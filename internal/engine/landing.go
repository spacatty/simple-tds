package engine

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"math/rand/v2"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"simpletds/internal/model"
)

// LandingAction is the stream action that shows a landing.
const LandingAction = "landing"

// LandingGo is the file name, under a landing's public path, that sends the
// visitor on to the stream's offer: what the {offer} macro points at.
const LandingGo = "_go"

// LandingCookie carries the click a landing was shown for to its other pages.
const LandingCookie = "_lc"

// LandingValues is what a landing's variables hold for one request.
type LandingValues struct {
	// Out maps a variable name to the text written in place of its token,
	// already escaped for where that kind of variable goes. Server-only
	// variables are not in it.
	Out map[string]string
	// Env is what PHP gets in $_SERVER: every variable under its token name,
	// unescaped, and the click id.
	Env map[string]string
}

// LandingRenderer serves an uploaded landing with its variables filled in.
type LandingRenderer interface {
	RenderLanding(ctx context.Context, l *model.Landing, v *Visit, vals *LandingValues) (*Result, error)
}

// LandingSplit is one preset a stream shows, with its share of the visitors.
type LandingSplit struct {
	ID     int64 `json:"id"`
	Weight int   `json:"weight"`
}

// LandingConfig is the config of the landing action.
type LandingConfig struct {
	LandingID int64 `json:"landing_id"`
	// Presets are the value sets visitors are split between; none means the
	// defaults of the variables.
	Presets []LandingSplit `json:"presets"`
	// Values override single variables for this stream.
	Values     map[string]string `json:"values"`
	OfferURL   string            `json:"offer_url"`
	OfferStage string            `json:"offer_stage"`
}

func ParseLandingConfig(cfg json.RawMessage) (*LandingConfig, error) {
	c := &LandingConfig{}
	if len(cfg) == 0 {
		return c, nil
	}
	if err := decode(cfg, c); err != nil {
		return nil, err
	}
	c.OfferURL, c.OfferStage = strings.TrimSpace(c.OfferURL), strings.ToLower(strings.TrimSpace(c.OfferStage))
	return c, nil
}

// pick draws the preset for one visitor; 0 is "no preset".
func (c *LandingConfig) pick() int64 {
	total := 0
	for _, p := range c.Presets {
		if p.Weight > 0 {
			total += p.Weight
		}
	}
	if total == 0 {
		if len(c.Presets) > 0 {
			return c.Presets[0].ID
		}
		return 0
	}
	n := rand.IntN(total)
	for _, p := range c.Presets {
		if p.Weight <= 0 {
			continue
		}
		if n -= p.Weight; n < 0 {
			return p.ID
		}
	}
	return 0
}

// rawValues is every variable's value before macros: the stream's own value,
// else the preset's, else the default.
func (c *LandingConfig) rawValues(l *model.Landing, presetID int64) map[string]string {
	out := make(map[string]string, len(l.Vars))
	p := l.Preset(presetID)
	for _, v := range l.Vars {
		val := v.Default
		if p != nil {
			if x, ok := p.Values[v.Name]; ok {
				val = x
			}
		}
		if x, ok := c.Values[v.Name]; ok {
			val = x
		}
		out[v.Name] = val
	}
	return out
}

var reEventMacro = regexp.MustCompile(`\{event:([^{}]+)\}`)

// StageRef is a funnel stage a landing configuration counts on.
type StageRef struct {
	Var   string // the variable whose value names it; empty for the offer link
	Stage string
}

// StageRefs lists the funnel stages the configuration reports to, through
// {event:STAGE} in a variable value or as the stage of the offer link. The
// campaign the stream belongs to must have each of them as a browser stage.
func (c *LandingConfig) StageRefs(l *model.Landing) []StageRef {
	var out []StageRef
	seen := map[StageRef]bool{}
	add := func(r StageRef) {
		if !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	presets := []int64{0}
	if len(c.Presets) > 0 {
		presets = presets[:0]
		for _, p := range c.Presets {
			presets = append(presets, p.ID)
		}
	}
	for _, id := range presets {
		vals := c.rawValues(l, id)
		for _, v := range l.Vars { // in declaration order, so the first error is stable
			for _, m := range reEventMacro.FindAllStringSubmatch(vals[v.Name], -1) {
				add(StageRef{v.Name, strings.ToLower(m[1])})
			}
		}
	}
	if c.OfferURL != "" {
		if c.OfferStage != "" {
			add(StageRef{"", c.OfferStage})
		}
		for _, m := range reEventMacro.FindAllStringSubmatch(c.OfferURL, -1) {
			add(StageRef{"", strings.ToLower(m[1])})
		}
	}
	return out
}

// urlSafe makes a URL harmless inside an HTML attribute and a script string
// alike, without changing where it leads.
var urlSafe = strings.NewReplacer(`"`, "%22", `'`, "%27", "<", "%3C", ">", "%3E", "`", "%60", `\`, "%5C", " ", "%20", "\n", "", "\r", "")

// jsContent escapes s to sit between the quotes of a JavaScript string.
func jsContent(s string) string {
	q := jsString(s)
	return strings.ReplaceAll(q[1:len(q)-1], "'", `\u0027`)
}

// landingValues resolves the variables of l for one visit.
func (e *Engine) landingValues(v *Visit, l *model.Landing, cfg *LandingConfig, presetID int64) *LandingValues {
	vals := &LandingValues{Out: map[string]string{}, Env: map[string]string{"TDS_CLICK_ID": v.ClickID}}
	raw := cfg.rawValues(l, presetID)
	for _, lv := range l.Vars {
		val := raw[lv.Name]
		vals.Env[model.LandingVarPrefix+lv.Name] = v.expand(val, false)
		switch lv.Kind {
		case model.VarServer:
			// Never written into a page: these are the secrets.
		case model.VarHTML:
			vals.Out[lv.Name] = v.expandWith(val, func(_, s string) string { return html.EscapeString(s) })
		case model.VarURL:
			vals.Out[lv.Name] = urlSafe.Replace(v.expandWith(val, func(name, s string) string {
				// These are URLs (or a query string) themselves.
				if name == "query" || name == "offer" || strings.HasPrefix(name, "event:") {
					return s
				}
				return url.QueryEscape(s)
			}))
		case model.VarJS:
			vals.Out[lv.Name] = jsContent(v.expand(val, false))
		default:
			vals.Out[lv.Name] = html.EscapeString(v.expand(val, false))
		}
	}
	return vals
}

func goURL(v *Visit, l *model.Landing) string {
	scheme := "http"
	if v.Secure {
		scheme = "https"
	}
	return scheme + "://" + v.Domain + "/_a/" + l.Key + "/" + LandingGo + "?cid=" + url.QueryEscape(v.ClickID)
}

// showLanding is the landing action. stream and owner are the stream the
// action belongs to and its campaign; they are unknown (0, nil) only while a
// config is being validated.
func (e *Engine) showLanding(v *Visit, cfg *LandingConfig, stream int64, owner *CampaignRT) (*Result, error) {
	l := e.Snap().Landings[cfg.LandingID]
	if l == nil {
		return nil, fmt.Errorf("landing %d no longer exists", cfg.LandingID)
	}
	// Repeats what saving the stream checked: a landing is shown only by
	// campaigns its owner runs.
	if owner != nil && !owner.UsableBy(l.OwnerID) {
		return nil, fmt.Errorf("landing %d is not available to this campaign", cfg.LandingID)
	}
	if e.Landings == nil {
		return nil, errors.New("landings are not available")
	}
	preset := cfg.pick()
	if l.Preset(preset) == nil {
		preset = 0
	}
	v.LandingID, v.PresetID = l.ID, preset
	if cfg.OfferURL != "" {
		v.offer = goURL(v, l)
	}
	res, err := e.Landings.RenderLanding(v.Ctx, l, v, e.landingValues(v, l, cfg, preset))
	if err != nil {
		return nil, err
	}
	// Only a browser on the campaign URL can carry the click to the landing's
	// other pages; the JS and PHP integrations get the entry page alone.
	if v.Integration == "direct" && v.Cookie != nil {
		res.Cookies = append(res.Cookies, &http.Cookie{Name: LandingCookie, Value: e.signLanding(l, &landingCtx{
			Click: v.ClickID, Stream: stream, Preset: preset, Referer: clip(v.Referer, 300), Query: clipQuery(v.Query.Encode(), 1024)}),
			Path: "/_a/" + l.Key + "/", MaxAge: int(publicEventWindow / time.Second), HttpOnly: true,
			SameSite: http.SameSiteLaxMode, Secure: v.Secure})
	}
	return res, nil
}

// clipQuery shortens a query string to whole parameters.
func clipQuery(q string, n int) string {
	if len(q) <= n {
		return q
	}
	return q[:strings.LastIndexByte(q[:n], '&')+1]
}

// landingCtx is what the cookie remembers of the click.
type landingCtx struct {
	Click   string `json:"c"`
	Stream  int64  `json:"s"`
	Preset  int64  `json:"p,omitempty"`
	Referer string `json:"r,omitempty"`
	Query   string `json:"q,omitempty"`
}

func (e *Engine) landingMAC(l *model.Landing, payload string) string {
	m := hmac.New(sha256.New, e.secret)
	m.Write([]byte("landing|" + l.Key + "|" + payload))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil)[:12])
}

func (e *Engine) signLanding(l *model.Landing, c *landingCtx) string {
	b, _ := json.Marshal(c)
	payload := base64.RawURLEncoding.EncodeToString(b)
	return payload + "." + e.landingMAC(l, payload)
}

func (e *Engine) readLanding(l *model.Landing, cookie string) *landingCtx {
	payload, mac, ok := strings.Cut(cookie, ".")
	if !ok || !hmac.Equal([]byte(mac), []byte(e.landingMAC(l, payload))) {
		return nil
	}
	b, err := base64.RawURLEncoding.DecodeString(payload)
	c := &landingCtx{}
	if err != nil || json.Unmarshal(b, c) != nil {
		return nil
	}
	return c
}

// LandingInput is a request for a file of a landing other than a click: a
// second page, a script that carries variables, the offer link.
type LandingInput struct {
	Ctx     context.Context
	Landing *model.Landing
	Cookie  string // the landing cookie, if the browser sent it
	// ClickID stands in for a missing cookie on the offer link.
	ClickID string
	Domain  string
	OwnerID int64 // owner of the domain the request arrived on
	IP      netip.Addr
	Header  http.Header
	Secure  bool
}

// landingVisit rebuilds the visit a landing was shown for. Without a valid
// cookie there is no click: the visit is blank and cfg is nil.
func (e *Engine) landingVisit(in *LandingInput) (v *Visit, cfg *LandingConfig, preset int64) {
	snap := e.Snap()
	v = &Visit{Ctx: in.Ctx, Now: time.Now(), Integration: "direct", Domain: in.Domain, IP: in.IP.Unmap(), Header: in.Header,
		Query: url.Values{}, Secure: in.Secure, Campaign: &CampaignRT{}, params: snap.Params, blank: true}
	var rawUA string
	if in.Header != nil {
		rawUA = in.Header.Get("User-Agent")
		v.Lang = primaryLang(in.Header.Get("Accept-Language"))
	}
	v.UA = e.Detector.ParseUA(rawUA)
	v.Geo = e.lookupGeo(in.Ctx, snap, v.IP, rawUA)

	c := e.readLanding(in.Landing, in.Cookie)
	if c == nil && in.ClickID != "" {
		if ref, err := e.parseClickID(in.ClickID); err == nil {
			c = &landingCtx{Click: in.ClickID, Stream: int64(ref.StreamID)}
		}
	}
	if c == nil {
		return v, nil, 0
	}
	ref, err := e.parseClickID(c.Click)
	if err != nil || v.Now.Sub(ref.At) > publicEventWindow {
		return v, nil, 0
	}
	camp := snap.ByID[int64(ref.CampaignID)]
	st := snap.landingStreams[c.Stream]
	// The same rules a click goes by: the campaign answers on this domain,
	// and the stream still shows this landing.
	if camp == nil || !camp.UsableBy(in.OwnerID) || st == nil || st.landing.LandingID != in.Landing.ID || !st.campaign.UsableBy(in.Landing.OwnerID) {
		return v, nil, 0
	}
	v.Campaign, v.ClickID, v.blank = camp, c.Click, false
	v.Stream = &StreamRT{Stream: model.Stream{ID: int64(ref.StreamID)}}
	v.Referer, v.RefDomain = c.Referer, hostOf(c.Referer)
	if q, err := url.ParseQuery(c.Query); err == nil {
		v.Query = q
	}
	if st.landing.OfferURL != "" {
		v.offer = goURL(v, in.Landing)
	}
	if in.Landing.Preset(c.Preset) != nil {
		preset = c.Preset
	}
	return v, st.landing, preset
}

// LandingValues resolves a landing's variables for a request that follows a
// click. Without the click the variables hold their defaults.
func (e *Engine) LandingValues(in *LandingInput) *LandingValues {
	v, cfg, preset := e.landingVisit(in)
	if cfg == nil {
		cfg = &LandingConfig{}
	}
	return e.landingValues(v, in.Landing, cfg, preset)
}

// LandingOffer answers the offer link of a landing: it reports the stream's
// offer stage for the click and returns where to send the visitor.
func (e *Engine) LandingOffer(in *LandingInput) (string, bool) {
	v, cfg, _ := e.landingVisit(in)
	if cfg == nil || cfg.OfferURL == "" {
		return "", false
	}
	if cfg.OfferStage != "" {
		e.Event(&EventInput{Ctx: in.Ctx, IP: in.IP, OwnerID: in.OwnerID, ClickID: v.ClickID, Stage: cfg.OfferStage, Params: url.Values{}})
	}
	return v.expand(cfg.OfferURL, true), true
}

// PreviewLanding resolves the variables the way the panel preview shows them:
// one preset, no click. stages are the browser stages {event:…} may name.
func (e *Engine) PreviewLanding(ctx context.Context, l *model.Landing, presetID int64, campaign *CampaignRT, domain string, secure bool, query url.Values) *LandingValues {
	snap := e.Snap()
	v := &Visit{Ctx: ctx, Now: time.Now(), Integration: "direct", Domain: domain, IP: netip.IPv4Unspecified(), Query: query,
		Secure: secure, Campaign: &CampaignRT{}, params: snap.Params, blank: true, ClickID: "preview"}
	if campaign != nil {
		v.Campaign = campaign
	}
	v.UA = e.Detector.ParseUA("")
	return e.landingValues(v, l, &LandingConfig{}, presetID)
}

func init() {
	RegisterAction(ActionDef{
		Type: LandingAction, Label: "Landing", Description: "Serve an uploaded landing with its variables filled in from presets and this stream's own values.",
		Fields: []Field{
			{Name: "landing_id", Label: "Landing", Type: "landing", Required: true},
			{Name: "presets", Label: "Presets", Type: "landing_presets",
				Help: "The sets of variable values shown by this stream. With several, visitors are split between them by weight and the reports compare them."},
			{Name: "offer_url", Label: "Offer URL", Type: "text",
				Help: "Where the {offer} macro leads. Put {offer} into a link variable: the visitor goes through the tracker, which reports the stage below and redirects here. Macros like {click_id} are URL-encoded and substituted."},
			{Name: "offer_stage", Label: "Stage reported by the offer link", Type: "stage",
				Help: "A browser stage of the campaign funnel, recorded when the visitor follows the offer link. Optional."},
			{Name: "values", Label: "Values for this stream", Type: "landing_values",
				Help: "Override single variables for this stream only. Macros are allowed."},
		},
		Build: func(cfg json.RawMessage, e *Engine) (Handler, error) {
			c, err := ParseLandingConfig(cfg)
			if err != nil {
				return nil, err
			}
			if c.LandingID == 0 {
				return nil, errors.New("choose a landing")
			}
			for _, p := range c.Presets {
				if p.Weight < 0 || p.Weight > 100000 {
					return nil, errors.New("weight must be 0-100000")
				}
			}
			if c.OfferURL != "" {
				if err := validURL(c.OfferURL); err != nil {
					return nil, err
				}
			} else if c.OfferStage != "" {
				return nil, errors.New("the offer stage needs an offer URL")
			}
			for name, val := range c.Values {
				if len(val) > model.MaxLandingValue {
					return nil, errors.New("variable " + name + ": the value is too long")
				}
			}
			// Reload replaces this with a handler that knows its stream.
			return func(v *Visit) (*Result, error) { return e.showLanding(v, c, 0, nil) }, nil
		},
	})
}

// LandingID reads the landing a stream shows; 0 when it shows none.
func LandingID(s *model.Stream) int64 {
	if s.ActionType != LandingAction {
		return 0
	}
	var c struct {
		ID json.Number `json:"landing_id"`
	}
	json.Unmarshal(s.ActionConfig, &c)
	id, _ := strconv.ParseInt(c.ID.String(), 10, 64)
	return id
}
