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

// Parameters with a meaning to the tracker; everything else is stored as data.
var clickIDParams = []string{"click_id", "clickid", "subid", "cid"}
var hiddenParams = map[string]bool{"key": true, "sig": true, "ts": true, "type": true,
	"click_id": true, "clickid": true, "subid": true, "cid": true,
	"revenue": true, "payout": true, "currency": true} // these have columns of their own

const (
	maxPostbackParams = 60
	sigMaxSkew        = 10 * time.Minute
	// Refused postbacks tolerated per sender IP per minute.
	maxRejectsPerMinute = 120
)

// SignPostback computes the signature a sender must supply when the key
// requires one: hex(HMAC-SHA256(secret, "k1=v1&k2=v2...")) over every
// parameter except sig, sorted by name.
func SignPostback(secret string, params url.Values) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		if k != "sig" {
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

func first(q url.Values, names ...string) string {
	for _, n := range names {
		if v := q.Get(n); v != "" {
			return v
		}
	}
	return ""
}

// Postback validates and stores a conversion. It returns the HTTP status and
// a short body. Refusals are deliberately terse so probing reveals nothing.
func (e *Engine) Postback(in *PostbackInput) (int, string) {
	snap := e.Snap()
	q := in.Params
	ip := in.IP.Unmap()
	keyStr := first(q, "key")
	if keyStr == "" {
		keyStr = in.HeaderKey
	}
	key := snap.Keys[keyStr]
	reject := func(status int, reason string) (int, string) {
		e.limits.Allow("pb-rej|"+ip.String(), 1<<30)
		r := Rejected{At: time.Now(), IP: ip.String(), Key: clip(keyStr, 12), Reason: reason, Query: q.Encode()}
		if key != nil {
			r.KeyName, r.OwnerID = key.Name, key.OwnerID
		}
		e.Reject.add(r)
		return status, http.StatusText(status)
	}

	// A sender that keeps getting refused is guessing: stop answering it.
	if e.limits.Count("pb-rej|"+ip.String()) > maxRejectsPerMinute {
		return http.StatusTooManyRequests, http.StatusText(http.StatusTooManyRequests)
	}
	if key == nil {
		return reject(http.StatusForbidden, "unknown or disabled key")
	}
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
		sig := first(q, "sig")
		if sig == "" {
			sig = in.HeaderSig
		}
		ts, err := strconv.ParseInt(q.Get("ts"), 10, 64)
		if err != nil {
			return reject(http.StatusForbidden, "missing ts")
		}
		if d := time.Since(time.Unix(ts, 0)); d > sigMaxSkew || d < -sigMaxSkew {
			return reject(http.StatusForbidden, "stale ts")
		}
		if !hmac.Equal([]byte(strings.ToLower(sig)), []byte(SignPostback(key.Secret, q))) {
			return reject(http.StatusForbidden, "bad signature")
		}
	}

	typ := strings.ToLower(first(q, "type"))
	if typ == "" {
		typ = key.DefaultType
	}
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
		id := first(q, clickIDParams...)
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
		if reported, err := netip.ParseAddr(q.Get("ip")); err == nil {
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

	// Which types exist depends on the campaign, so this waits for attribution.
	campaign := snap.ByID[int64(conv.CampaignID)]
	var known bool
	if conv.Goal, known = conversionKind(campaign, typ); !known {
		return reject(http.StatusBadRequest, "unknown conversion type "+clip(typ, 32))
	}

	if key.Dedupe && e.duplicate(in.Ctx, conv) {
		return http.StatusOK, "DUPLICATE"
	}
	conv.FromClick(click)

	if typ != model.TypeRejected {
		conv.Revenue = key.DefaultRevenue
		if s := first(q, "revenue", "payout"); s != "" {
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
	conv.Currency = strings.ToUpper(clip(q.Get("currency"), 8))
	if conv.Currency == "" && campaign != nil {
		conv.Currency = campaign.Currency
	}

	params := map[string]string{}
	for k, vals := range q {
		if hiddenParams[k] || len(vals) == 0 || len(k) > 64 {
			continue
		}
		params[k] = clip(vals[0], 1000)
	}
	pj, _ := json.Marshal(params)
	conv.Params = string(pj)

	if err := e.addConversion(in.Ctx, conv); err != nil {
		return http.StatusServiceUnavailable, "RETRY"
	}
	return http.StatusOK, "OK"
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

// duplicate reports whether the click already has an event of this type, and
// remembers this one otherwise.
func (e *Engine) duplicate(ctx context.Context, conv *events.Conversion) bool {
	if conv.ClickID == "" {
		return false
	}
	dk := conv.ClickID + "|" + conv.Type
	// Check and claim in one step: two copies of a postback arriving together
	// must not both get through.
	if seen, _ := e.convs.ContainsOrAdd(dk, struct{}{}); seen {
		return true
	}
	dup, err := e.Events.ConversionExists(ctx, conv.ClickID, conv.Type, conv.ClickTS)
	return err == nil && dup
}

func (e *Engine) addConversion(ctx context.Context, conv *events.Conversion) error {
	var rnd [9]byte
	rand.Read(rnd[:])
	conv.ConvID = hex.EncodeToString(rnd[:])
	err := e.Events.AddConversion(ctx, conv)
	if err != nil {
		slog.Error("conversion not stored", "err", err)
		e.convs.Remove(conv.ClickID + "|" + conv.Type) // let the sender retry
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
}

const (
	// A browser reports its stages while the visitor is still on the page.
	publicEventWindow = 7 * 24 * time.Hour
	maxEventsPerMin   = 60 // per IP
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
	st := c.Stage(strings.ToLower(in.Stage))
	if st == nil || !st.Public {
		return false
	}
	conv := &events.Conversion{TS: now.UTC(), Type: st.Key, SenderIP: ip.String(), Params: "{}",
		ClickID: in.ClickID, CampaignID: ref.CampaignID, StreamID: ref.StreamID, ClickTS: ref.At, Currency: c.Currency}
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
