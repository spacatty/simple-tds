package engine

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	"simpletds/internal/antibot"
	"simpletds/internal/events"
	"simpletds/internal/extapi"
	"simpletds/internal/geo"
	"simpletds/internal/model"
)

// Input is a visit as received by one of the integrations.
type Input struct {
	Ctx         context.Context
	Integration string // direct | js | php
	Campaign    *CampaignRT
	Domain      string
	Path        string
	Method      string
	IP          netip.Addr
	Header      http.Header
	Query       url.Values
	Referer     string
	Proto       string
	Secure      bool
	TLS         *antibot.TLSInfo
	Cookie      func(name string) string
	Body        []byte
}

// Query parameters consumed by the tracker itself, never stored or forwarded.
var internalParams = []string{antibot.ParamNoJS, "_ref", "_url", "_t"}

func primaryLang(acceptLanguage string) string {
	s, _, _ := strings.Cut(acceptLanguage, ",")
	s, _, _ = strings.Cut(s, ";")
	s, _, _ = strings.Cut(strings.TrimSpace(s), "-")
	if len(s) > 8 {
		s = s[:8]
	}
	return strings.ToLower(s)
}

func hostOf(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func (e *Engine) lookupGeo(ctx context.Context, snap *Snapshot, ip netip.Addr, ua string) geo.Info {
	g := e.Geo.Lookup(ip)
	for _, p := range snap.geoProviders {
		doc, err := p.Lookup(ctx, ip.String(), ua)
		if err != nil || doc == nil {
			continue // fall back to the local database
		}
		m := p.Cfg.Mapping
		if s := extapi.String(extapi.Path(doc, m["country"])); s != "" {
			g.Country = strings.ToUpper(s)
		}
		if s := extapi.String(extapi.Path(doc, m["region"])); s != "" {
			g.Region = s
		}
		if s := extapi.String(extapi.Path(doc, m["city"])); s != "" {
			g.City = s
		}
		if s := extapi.String(extapi.Path(doc, m["isp"])); s != "" {
			g.ISP = s
		}
		if s := extapi.String(extapi.Path(doc, m["asn"])); s != "" {
			if n, err := strconv.ParseUint(strings.TrimPrefix(strings.ToUpper(s), "AS"), 10, 32); err == nil {
				g.ASN = uint32(n)
			}
		}
	}
	return g
}

// newVisit resolves everything about the visitor that filters may look at.
func (e *Engine) newVisit(in *Input, snap *Snapshot) *Visit {
	v := &Visit{Ctx: in.Ctx, Now: time.Now(), Integration: in.Integration, Domain: in.Domain, Path: in.Path, Method: in.Method,
		IP: in.IP.Unmap(), Header: in.Header, Query: in.Query, Referer: clip(in.Referer, 1000), Proto: in.Proto,
		Secure: in.Secure, TLS: in.TLS, Campaign: in.Campaign, Cookie: in.Cookie, Body: in.Body, params: snap.Params}
	if v.Query == nil {
		v.Query = url.Values{}
	}
	var rawUA string
	if in.Header != nil {
		rawUA = in.Header.Get("User-Agent")
		v.Lang = primaryLang(in.Header.Get("Accept-Language"))
	}
	v.UA = e.Detector.ParseUA(rawUA)
	v.RefDomain = hostOf(v.Referer)
	v.Geo = e.lookupGeo(in.Ctx, snap, v.IP, rawUA)
	v.Verdict = e.Detector.Check(in.Ctx, &antibot.Request{IP: v.IP, UA: v.UA, Header: in.Header, Proto: in.Proto,
		Secure: in.Secure, TLS: in.TLS, Geo: v.Geo})
	return v
}

func (v *Visit) markBot(reason string) {
	v.Verdict.Bot = true
	v.Verdict.Reasons = append(v.Verdict.Reasons, reason)
}

// jsCheck consumes the JS check cookies. It returns whether the browser has
// passed, plus any cookies to set.
func (e *Engine) jsCheck(v *Visit, snap *Snapshot) (passed bool, cookies []*http.Cookie) {
	if v.Cookie == nil {
		return false, nil
	}
	if _, ok := v.Query[antibot.ParamNoJS]; ok {
		v.markBot("js:no_js_or_cookies")
		return false, nil
	}
	if c := v.Cookie(antibot.CookieChallenge); c != "" {
		cookies = append(cookies, &http.Cookie{Name: antibot.CookieChallenge, Path: "/", MaxAge: -1})
		sig, ok := e.Signer.ReadChallenge(c, v.IP.String(), v.Now)
		if !ok {
			v.markBot("js:bad_token")
			return false, cookies
		}
		score, reasons := sig.Evaluate(v.UA)
		if score >= e.Detector.Threshold() {
			v.Verdict.Bot = true
			v.Verdict.Score += score
			v.Verdict.Reasons = append(v.Verdict.Reasons, reasons...)
			return false, cookies
		}
		// The reload replaced the original referrer with our own URL.
		if sig.Referrer != "" && (v.Referer == "" || v.RefDomain == v.Domain) {
			v.Referer, v.RefDomain = clip(sig.Referrer, 1000), hostOf(sig.Referrer)
		} else if v.RefDomain == v.Domain {
			v.Referer, v.RefDomain = "", ""
		}
		ttl := time.Duration(snap.Settings.JSPassHours) * time.Hour
		if ttl <= 0 {
			ttl = 24 * time.Hour
		}
		cookies = append(cookies, &http.Cookie{Name: antibot.CookiePass, Value: e.Signer.Pass(v.UA.Raw, ttl, v.Now),
			Path: "/", MaxAge: int(ttl / time.Second), HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: v.Secure})
		return true, cookies
	}
	if c := v.Cookie(antibot.CookiePass); c != "" && e.Signer.ValidPass(c, v.UA.Raw, v.Now) {
		return true, nil
	}
	return false, nil
}

// Process routes one visit through its campaign and records the click.
func (e *Engine) Process(in *Input) *Result {
	snap := e.Snap()
	// Before anything else: a suppressed source costs no lookups, takes no
	// uniqueness slot and leaves no click behind.
	if rule := in.Campaign.suppressed(in.IP.Unmap(), in.Referer); rule != nil {
		e.suppressed(in, rule)
		res := notFound()
		res.NoLog = true
		return res
	}
	v := e.newVisit(in, snap)
	c := in.Campaign

	var passed bool
	var cookies []*http.Cookie
	if !v.Verdict.Bot {
		passed, cookies = e.jsCheck(v, snap)
	}
	for _, p := range internalParams {
		delete(v.Query, p)
	}

	ttl := time.Duration(c.UniqueHours) * time.Hour
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	v.Unique = e.uniq.first(c.ID, v.IP.String(), v.UA.Raw, ttl, v.Now)

	stream := c.pick(v, nil)
	v.Stream = stream

	// The JS check needs a top-level page load it can interrupt, so it only
	// applies to direct campaign URLs; other integrations skip it.
	if stream != nil && stream.JSCheck && !passed {
		if in.Integration == "direct" && in.Method == http.MethodGet && in.Cookie != nil {
			if v.Unique {
				e.uniq.forget(c.ID, v.IP.String(), v.UA.Raw) // the real click is the reload
			}
			q := url.Values{}
			for k, vals := range v.Query {
				q[k] = vals
			}
			q.Set(antibot.ParamNoJS, "1")
			fallback := (&url.URL{Path: in.Path}).EscapedPath() + "?" + q.Encode()
			return &Result{Status: http.StatusOK, ContentType: "text/html; charset=utf-8", NoLog: true,
				Body:   antibot.ChallengePage(e.Signer.Token(v.IP.String(), v.Now), fallback),
				Header: http.Header{"Cache-Control": {"no-store"}}}
		}
	}

	var streamID int64
	action := "no_stream"
	if stream != nil {
		streamID, action = stream.ID, stream.ActionType
	}
	v.ClickID = e.newClickID(v.Now, c.ID, streamID)

	var res *Result
	if stream == nil {
		res = notFound()
	} else {
		var err error
		if res, err = stream.action(v); err != nil {
			slog.Warn("action failed", "campaign", c.Name, "stream", stream.Name, "err", err)
			res, action = notFound(), "error"
		}
	}
	res.Cookies = append(res.Cookies, cookies...)

	e.record(v, c, streamID, action)
	return res
}

func (e *Engine) record(v *Visit, c *CampaignRT, streamID int64, action string) {
	var cost float64
	switch c.CostModel {
	case "cpc":
		cost = c.CostValue
	case "cpuc":
		if v.Unique {
			cost = c.CostValue
		}
	case "cpm":
		cost = c.CostValue / 1000
	}
	params := make(map[string]string, len(v.Query))
	size := 0
	for k, vals := range v.Query {
		if len(vals) == 0 || len(k) > 64 {
			continue
		}
		val := clip(vals[0], 500)
		if size += len(k) + len(val); size > 4000 {
			break
		}
		params[k] = val
	}
	pj, _ := json.Marshal(params)
	click := &events.Click{
		TS: v.Now.UTC(), ClickID: v.ClickID, CampaignID: uint32(c.ID), StreamID: uint32(streamID), Domain: v.Domain,
		IP: v.IP.String(), Country: v.Geo.Country, Region: v.Geo.Region, City: v.Geo.City, ASN: v.Geo.ASN, ISP: v.Geo.ISP,
		DeviceType: v.UA.DeviceType, OS: v.UA.OS, OSVersion: v.UA.OSVersion, Browser: v.UA.Browser, BrowserVersion: v.UA.BrowserVersion,
		UA: v.UA.Raw, Lang: v.Lang, Referer: v.Referer, RefDomain: v.RefDomain,
		IsBot: v.Verdict.Bot, BotReason: clip(v.Verdict.Reason(), 200), IsDC: v.Verdict.Datacenter, IsUnique: v.Unique,
		Action: action, Integration: v.Integration, Keyword: clip(v.params.Get(v.Query, "keyword"), 500), Params: string(pj), Cost: cost,
	}
	for i := range click.Sub {
		click.Sub[i] = clip(v.params.Get(v.Query, "sub"+strconv.Itoa(i+1)), 500)
	}
	if v.TLS != nil {
		click.JA3, click.JA4 = v.TLS.JA3, v.TLS.JA4
	}
	e.recent.Add(click.ClickID, click)
	e.Events.AddClick(click)
}

// SimInput describes a hypothetical visitor for the stream debugger.
type SimInput struct {
	CampaignID int64             `json:"campaign_id"`
	IP         string            `json:"ip"`
	UserAgent  string            `json:"user_agent"`
	Language   string            `json:"language"`
	Referer    string            `json:"referer"`
	Country    string            `json:"country"` // overrides the geo lookup
	Query      string            `json:"query"`
	Domain     string            `json:"domain"`
	ForceBot   *bool             `json:"force_bot"`
	Headers    map[string]string `json:"headers"`
}

type SimResult struct {
	Geo        geo.Info      `json:"geo"`
	DeviceType string        `json:"device_type"`
	OS         string        `json:"os"`
	Browser    string        `json:"browser"`
	Bot        bool          `json:"bot"`
	Datacenter bool          `json:"datacenter"`
	Score      int           `json:"score"`
	Reasons    []string      `json:"reasons"`
	Streams    []StreamTrace `json:"streams"`
	StreamID   int64         `json:"stream_id"`
	Action     string        `json:"action"`
	Note       string        `json:"note"`
}

// Simulate explains which stream a visitor would get, without recording
// anything or running the action.
func (e *Engine) Simulate(ctx context.Context, in SimInput) (*SimResult, error) {
	snap := e.Snap()
	c := snap.ByID[in.CampaignID]
	if c == nil {
		return nil, errNoCampaign
	}
	ip, err := netip.ParseAddr(strings.TrimSpace(in.IP))
	if err != nil {
		ip = netip.MustParseAddr("0.0.0.0")
	}
	// Only the headers the user supplied take part, so header-consistency
	// checks are skipped unless explicitly simulated.
	var h http.Header
	if len(in.Headers) > 0 {
		h = http.Header{}
		for k, val := range in.Headers {
			h.Set(k, val)
		}
		h.Set("User-Agent", in.UserAgent)
	}
	if rule := c.suppressed(ip.Unmap(), in.Referer); rule != nil {
		note := "This IP address is suppressed: the request gets a 404 and is not counted."
		if rule.kind == model.SuppressReferer {
			note = "This referrer is suppressed: the request gets a 404 and is not counted."
		}
		return &SimResult{Reasons: []string{}, Streams: []StreamTrace{}, Action: "suppressed", Note: note}, nil
	}
	q, _ := url.ParseQuery(strings.TrimPrefix(in.Query, "?"))
	v := &Visit{Ctx: ctx, Now: time.Now(), Integration: "direct", Domain: in.Domain, IP: ip, Header: h, Query: q,
		Referer: in.Referer, RefDomain: hostOf(in.Referer), Lang: strings.ToLower(in.Language), Campaign: c, Unique: true, params: snap.Params}
	v.UA = e.Detector.ParseUA(in.UserAgent)
	v.Geo = e.lookupGeo(ctx, snap, ip, in.UserAgent)
	if in.Country != "" {
		v.Geo.Country = strings.ToUpper(in.Country)
	}
	v.Verdict = e.Detector.Check(ctx, &antibot.Request{IP: ip, UA: v.UA, Header: h, Geo: v.Geo})
	if in.ForceBot != nil {
		v.Verdict.Bot = *in.ForceBot
	}
	out := &SimResult{Geo: v.Geo, DeviceType: v.UA.DeviceType, OS: v.UA.OS, Browser: v.UA.Browser, Bot: v.Verdict.Bot,
		Datacenter: v.Verdict.Datacenter, Score: v.Verdict.Score, Reasons: v.Verdict.Reasons, Streams: []StreamTrace{}}
	if out.Reasons == nil {
		out.Reasons = []string{}
	}
	if s := c.pick(v, &out.Streams); s != nil {
		out.StreamID, out.Action = s.ID, s.ActionType
		if s.JSCheck {
			out.Note = "This stream runs the JS check first; a browser that fails it is re-routed as a bot."
		}
	} else {
		out.Action, out.Note = "no_stream", "No stream matched: the visitor gets a 404."
	}
	return out, nil
}
