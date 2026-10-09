package engine

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"simpletds/internal/events"
	"simpletds/internal/model"
)

var errNoCampaign = errors.New("campaign not found")

// PostbackInput is a conversion postback, whatever transport it came by.
type PostbackInput struct {
	Ctx       context.Context
	IP        netip.Addr
	Params    url.Values // query string merged with any form or JSON body
	HeaderKey string     // X-TDS-Key, as an alternative to ?key=
	HeaderSig string     // X-TDS-Signature, as an alternative to &sig=
}

const (
	maxPostbackParams = 60
	sigMaxSkew        = 10 * time.Minute
	// Refused postbacks tolerated per sender IP per minute.
	maxRejectsPerMinute = 120
)

// SignPostback computes the signature a sender must supply when the key
// requires one: hex(HMAC-SHA256(secret, "k1=v1&k2=v2...")) over every
// parameter except sig, sorted by name. sigNames are the other names the
// signature itself may arrive under.
func SignPostback(secret string, params url.Values, sigNames ...string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		if k != "sig" && !slices.Contains(sigNames, k) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	var b strings.Builder
	for i, k := range keys {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(params.Get(k))
	}
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(b.String()))
	return hex.EncodeToString(m.Sum(nil))
}

// Postback validates and stores a conversion. It returns the HTTP status and
// a short body. Refusals are deliberately terse so probing reveals nothing.
func (e *Engine) Postback(in *PostbackInput) (int, string) {
	snap := e.Snap()
	q := in.Params
	ip := in.IP.Unmap()
	// Parameters with a meaning to the tracker are read through names, under
	// whatever name the sender uses; everything else is stored as data.
	names := snap.Params
	keyStr := names.Get(q, "key")
	if keyStr == "" {
		keyStr = in.HeaderKey
	}
	key := snap.Keys[keyStr]
	// Every answer below leaves a line in the postback log, filled in as the
	// request is understood.
	entry := &events.Postback{SenderIP: ip.String(), KeyPrefix: clip(keyStr, logKeyPrefix)}
	answer := func(status int, outcome, reason, body string) (int, string) {
		entry.TS, entry.Status, entry.HTTPStatus, entry.Reason = time.Now().UTC(), outcome, uint16(status), reason
		entry.Query = logQuery(q, names)
		e.Events.AddPostback(entry)
		return status, body
	}
	reject := func(status int, reason string) (int, string) {
		e.limits.Allow("pb-rej|"+ip.String(), 1<<30)
		return answer(status, events.PostbackRejected, reason, http.StatusText(status))
	}

	// A sender that keeps getting refused is guessing: stop answering it, and
	// stop logging it, so a flood cannot fill the log.
	if e.limits.Count("pb-rej|"+ip.String()) > maxRejectsPerMinute {
		return http.StatusTooManyRequests, http.StatusText(http.StatusTooManyRequests)
	}
	if key == nil {
		return reject(http.StatusForbidden, "unknown or disabled key")
	}
	entry.KeyID, entry.ClickID = uint32(key.ID), clip(names.Get(q, "click_id"), 128)
	if key.allow != nil && !key.allow.Contains(ip) {
		return reject(http.StatusForbidden, "sender IP not in allowlist")
	}
	if !e.limits.Allow("pb|"+keyStr+"|"+ip.String(), key.RateLimit) {
		return reject(http.StatusTooManyRequests, "rate limit")
	}
	if len(q) > maxPostbackParams {
		return reject(http.StatusBadRequest, "too many parameters")
	}
	if key.RequireSig {
		sig := names.Get(q, "sig")
		if sig == "" {
			sig = in.HeaderSig
		}
		ts, err := strconv.ParseInt(names.Get(q, "ts"), 10, 64)
		if err != nil {
			return reject(http.StatusForbidden, "missing ts")
		}
		if d := time.Since(time.Unix(ts, 0)); d > sigMaxSkew || d < -sigMaxSkew {
			return reject(http.StatusForbidden, "stale ts")
		}
		if !hmac.Equal([]byte(strings.ToLower(sig)), []byte(SignPostback(key.Secret, q, names.Names("sig")...))) {
			return reject(http.StatusForbidden, "bad signature")
		}
	}

	typ := strings.ToLower(names.Get(q, "type"))
	if typ == "" {
		typ = key.DefaultType
	}
	entry.Type = clip(typ, 32)
	if !events.ValidStageKey(typ) {
		return reject(http.StatusBadRequest, "unknown conversion type "+clip(typ, 32))
	}

	now := time.Now()
	window := time.Duration(key.WindowHours) * time.Hour
	if window <= 0 {
		window = 72 * time.Hour
	}
	conv := &events.Conversion{TS: now.UTC(), KeyID: uint32(key.ID), Type: typ, SenderIP: ip.String()}
	var click *events.Click

	switch key.Attribution {
	case model.AttrClickID:
		id := names.Get(q, "click_id")
		ref, err := e.parseClickID(id)
		// A key only converts clicks of campaigns its owner runs: a click id
		// lifted from someone else's traffic is as good as forged.
		if c := snap.ByID[int64(ref.CampaignID)]; err == nil && (c == nil || !c.UsableBy(key.OwnerID)) {
			err = errBadClickID
		}
		switch {
		case err == nil && now.Sub(ref.At) <= window:
			conv.ClickID, conv.CampaignID, conv.StreamID, conv.ClickTS = id, ref.CampaignID, ref.StreamID, ref.At
			if c, ok := e.recent.Get(id); ok {
				click = c
			} else if c, err := e.Events.ClickByID(in.Ctx, id, ref.CampaignID, ref.At); err == nil {
				click = c
			}
		case key.RequireClick && err != nil:
			return reject(http.StatusBadRequest, "missing or forged click id")
		case key.RequireClick:
			return reject(http.StatusBadRequest, "click older than attribution window")
		}
	case model.AttrIP:
		target := ip
		if reported, err := netip.ParseAddr(names.Get(q, "ip")); err == nil {
			target = reported.Unmap()
		}
		var mine []uint32
		for id, c := range snap.ByID {
			if c.UsableBy(key.OwnerID) {
				mine = append(mine, uint32(id))
			}
		}
		c, err := e.Events.LastClickByIP(in.Ctx, target.String(), now.Add(-window), mine)
		if err != nil {
			slog.Warn("postback click lookup failed", "err", err)
		}
		if c != nil {
			click = c
			conv.ClickID, conv.CampaignID, conv.StreamID, conv.ClickTS = c.ClickID, c.CampaignID, c.StreamID, c.TS
		} else if key.RequireClick {
			return reject(http.StatusBadRequest, "no click from "+target.String())
		}
	}

	if conv.ClickID != "" {
		entry.ClickID, entry.CampaignID, entry.StreamID = conv.ClickID, conv.CampaignID, conv.StreamID
	}

	// Which types exist depends on the campaign, so this waits for attribution.
	campaign := snap.ByID[int64(conv.CampaignID)]
	// An outcome key that is unique in the funnel may come as the type itself.
	outcomeName := strings.ToLower(names.Get(q, "outcome"))
	if campaign != nil {
		if st, o := campaign.StageByOutcome(typ); o != nil {
			typ, outcomeName = st.Key, o.Key
			conv.Type = typ
		}
	}
	var known bool
	if conv.Goal, known = conversionKind(campaign, typ); !known {
		return reject(http.StatusBadRequest, "unknown conversion type "+clip(typ, 32))
	}
	// A stage that defines outcomes takes the one the postback names; for any
	// other stage the parameter is plain data, as it was before outcomes.
	failed := false
	if st := stageOf(campaign, typ); st != nil && len(st.Outcomes) > 0 {
		if name := outcomeName; name != "" {
			o := st.Outcome(name)
			if o == nil {
				return reject(http.StatusBadRequest, "unknown outcome "+clip(name, 32)+" of stage "+typ)
			}
			conv.Outcome, failed = o.Key, o.Kind == model.OutcomeFail
		}
		conv.Goal = st.Goal && st.Succeeded(conv.Outcome)
	}

	if key.Dedupe && e.duplicate(in.Ctx, conv) {
		return answer(http.StatusOK, events.PostbackDuplicate, "", "DUPLICATE")
	}
	conv.FromClick(click)

	// A failed attempt earns nothing, the key's default revenue included.
	if typ != model.TypeRejected && !failed {
		conv.Revenue = key.DefaultRevenue
		if s := names.Get(q, "revenue"); s != "" {
			if f, err := strconv.ParseFloat(s, 64); err == nil && f >= 0 && f < 1e12 {
				conv.Revenue = f
			}
		}
		if campaign != nil {
			switch campaign.CostModel {
			case "cpa":
				// One payout per customer, however many stages they pass.
				if conv.Goal {
					conv.Cost = campaign.CostValue
				}
			case "revshare":
				conv.Cost = conv.Revenue * campaign.CostValue / 100
			}
		}
	}
	conv.Currency = strings.ToUpper(clip(names.Get(q, "currency"), 8))
	if conv.Currency == "" && campaign != nil {
		conv.Currency = campaign.Currency
	}

	params := map[string]string{}
	for k, vals := range q {
		if names.Stored(k) || len(vals) == 0 || len(k) > 64 {
			continue
		}
		// An outcome the stage took has its own column.
		if conv.Outcome != "" && slices.Contains(names.Names("outcome"), k) {
			continue
		}
		params[k] = clip(vals[0], 1000)
	}
	pj, _ := json.Marshal(params)
	conv.Params = string(pj)

	entry.Revenue = conv.Revenue
	if err := e.addConversion(in.Ctx, conv); err != nil {
		return answer(http.StatusServiceUnavailable, events.PostbackFailed, "conversion not stored", "RETRY")
	}
	entry.ConvID = conv.ConvID
	return answer(http.StatusOK, events.PostbackOK, "", "OK")
}

const (
	logKeyPrefix = 12
	logQueryMax  = 2000
)

// logQuery renders the parameters for the postback log. The key is cut to
// its first characters: enough to tell which one was sent, without the log
// holding working credentials.
func logQuery(q url.Values, names *ParamNames) string {
	out := make(url.Values, len(q))
	for k, vals := range q {
		out[k] = vals
	}
	for _, n := range names.Names("key") {
		if v := out.Get(n); len(v) > logKeyPrefix {
			out.Set(n, v[:logKeyPrefix]+"...")
		}
	}
	return clip(out.Encode(), logQueryMax)
}

// conversionKind reports whether typ is a conversion type the campaign
// accepts, and whether such an event is a conversion (goal) rather than a
// step towards one. c is nil for events not attributed to a click.
func conversionKind(c *CampaignRT, typ string) (goal, known bool) {
	if c != nil && len(c.Stages) > 0 {
		if st := c.Stage(typ); st != nil {
			return st.Goal, true
		}
	}
	for _, t := range model.ConversionTypes {
		if t == typ {
			// With a funnel only its goal stage is the conversion; a built-in
			// type arriving next to it is kept as an extra event.
			return typ != model.TypeRejected && (c == nil || len(c.Stages) == 0), true
		}
	}
	return false, false
}

// stageOf returns the campaign's funnel stage with this key, or nil.
func stageOf(c *CampaignRT, typ string) *model.Stage {
	if c == nil {
		return nil
	}
	return c.Stage(typ)
}

// dedupeKey identifies what a click may have only one of: an event of a type
// and outcome. A failure followed by a success is two events, not a repeat.
func dedupeKey(conv *events.Conversion) string {
	return conv.ClickID + "|" + conv.Type + "|" + conv.Outcome
}

// duplicate reports whether the click already has an event of this type and
// outcome, and remembers this one otherwise.
func (e *Engine) duplicate(ctx context.Context, conv *events.Conversion) bool {
	if conv.ClickID == "" {
		return false
	}
	dk := dedupeKey(conv)
	// Check and claim in one step: two copies of a postback arriving together
	// must not both get through.
	if seen, _ := e.convs.ContainsOrAdd(dk, struct{}{}); seen {
		return true
	}
	dup, err := e.Events.ConversionExists(ctx, conv.ClickID, conv.Type, conv.Outcome, conv.ClickTS)
	return err == nil && dup
}

func (e *Engine) addConversion(ctx context.Context, conv *events.Conversion) error {
	var rnd [9]byte
	rand.Read(rnd[:])
	conv.ConvID = hex.EncodeToString(rnd[:])
	err := e.Events.AddConversion(ctx, conv)
	if err != nil {
		slog.Error("conversion not stored", "err", err)
		e.convs.Remove(dedupeKey(conv)) // let the sender retry
	}
	return err
}

// ---- stage events from the browser ------------------------------------------

// EventInput is a funnel stage reported by the visitor's own browser: a
// landing page button, an offer link. The signed click id is the only proof
// it carries, so only stages marked public are accepted this way.
type EventInput struct {
	Ctx     context.Context
	IP      netip.Addr
	OwnerID int64 // owner of the domain the event arrived on
	ClickID string
	Stage   string
	// Params is the query of the request: the outcome is read from it, and a
	// few of the others are kept with the event (an error message, say).
	Params url.Values
}

const (
	// A browser reports its stages while the visitor is still on the page.
	publicEventWindow = 7 * 24 * time.Hour
	maxEventsPerMin   = 60 // per IP
	// What a browser may attach to an event. Anyone holding a click id can
	// send these, so they are kept small.
	maxEventParams   = 8
	maxEventParamLen = 200
)

// Event stores a public stage event and reports whether it was accepted.
// Callers answer the same either way.
func (e *Engine) Event(in *EventInput) bool {
	ip := in.IP.Unmap()
	if !e.limits.Allow("ev|"+ip.String(), maxEventsPerMin) {
		return false
	}
	ref, err := e.parseClickID(in.ClickID)
	now := time.Now()
	if err != nil || now.Sub(ref.At) > publicEventWindow {
		return false
	}
	c := e.Snap().ByID[int64(ref.CampaignID)]
	if c == nil || !c.UsableBy(in.OwnerID) {
		return false
	}
	names := e.Snap().Params
	st, outcomeName := c.Stage(strings.ToLower(in.Stage)), strings.ToLower(names.Get(in.Params, "outcome"))
	if st == nil {
		// /_e/<outcome key>: the outcome names its stage.
		var o *model.Outcome
		if st, o = c.StageByOutcome(strings.ToLower(in.Stage)); o != nil {
			outcomeName = o.Key
		}
	}
	if st == nil || !st.Public {
		return false
	}
	conv := &events.Conversion{TS: now.UTC(), Type: st.Key, SenderIP: ip.String(), Params: "{}",
		ClickID: in.ClickID, CampaignID: ref.CampaignID, StreamID: ref.StreamID, ClickTS: ref.At, Currency: c.Currency}
	if name := outcomeName; name != "" && len(st.Outcomes) > 0 {
		o := st.Outcome(name)
		if o == nil {
			return false
		}
		conv.Outcome = o.Key
	}
	conv.Params = eventParams(in.Params, names, conv.Outcome != "")
	if e.duplicate(in.Ctx, conv) {
		return false
	}
	click, ok := e.recent.Get(in.ClickID)
	if !ok {
		click, _ = e.Events.ClickByID(in.Ctx, in.ClickID, ref.CampaignID, ref.At)
	}
	conv.FromClick(click)
	return e.addConversion(in.Ctx, conv) == nil
}

// eventParams renders what a browser event carried besides the click id, as
// the JSON kept with the event.
func eventParams(q url.Values, names *ParamNames, outcomeTaken bool) string {
	keys := make([]string, 0, len(q))
	for k, vals := range q {
		if names.Stored(k) || len(vals) == 0 || vals[0] == "" || len(k) > 64 {
			continue
		}
		if outcomeTaken && slices.Contains(names.Names("outcome"), k) {
			continue
		}
		keys = append(keys, k)
	}
	// Sorted, so which ones survive the cap does not depend on map order.
	sort.Strings(keys)
	if len(keys) > maxEventParams {
		keys = keys[:maxEventParams]
	}
	params := make(map[string]string, len(keys))
	for _, k := range keys {
		params[k] = clip(q.Get(k), maxEventParamLen)
	}
	pj, _ := json.Marshal(params)
	return string(pj)
}
