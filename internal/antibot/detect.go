// Package antibot decides whether a visitor is a bot, from passive signals
// (IP lists, ASN, User-Agent, header consistency, TLS fingerprint, external
// providers) and an optional in-browser JS check.
package antibot

import (
	"context"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"sync/atomic"

	"simpletds/internal/extapi"
	"simpletds/internal/geo"
	"simpletds/internal/model"
)

type config struct {
	st        model.Settings
	ua        *uaParser
	botASN    map[uint32]bool
	dcASN     map[uint32]bool
	ja3       map[string]bool
	ja4       map[string]bool
	providers []*extapi.Provider
}

type Detector struct {
	Lists *Lists
	cfg   atomic.Pointer[config]
}

func NewDetector(lists *Lists) *Detector {
	d := &Detector{Lists: lists}
	d.Configure(model.DefaultSettings(), nil)
	return d
}

// Configure swaps in new settings and external anti-bot providers.
func (d *Detector) Configure(st model.Settings, integrations []model.Integration) {
	c := &config{st: st,
		botASN: map[uint32]bool{}, dcASN: map[uint32]bool{}, ja3: map[string]bool{}, ja4: map[string]bool{}}
	for _, a := range st.BotASNs {
		c.botASN[a] = true
	}
	for _, a := range st.DatacenterASNs {
		c.dcASN[a] = true
	}
	for _, v := range st.JA3Block {
		c.ja3[strings.ToLower(strings.TrimSpace(v))] = true
	}
	for _, v := range st.JA4Block {
		c.ja4[strings.ToLower(strings.TrimSpace(v))] = true
	}
	for _, in := range integrations {
		if in.Enabled && in.Kind == "antibot" {
			c.providers = append(c.providers, extapi.Shared(in))
		}
	}
	// Parsed User-Agents stay valid until the signatures change.
	if old := d.cfg.Load(); old != nil && slices.Equal(old.st.BotUAPatterns, st.BotUAPatterns) {
		c.ua = old.ua
	} else {
		c.ua = newUAParser(st.BotUAPatterns)
	}
	if c.st.BotThreshold <= 0 {
		c.st.BotThreshold = 100
	}
	d.cfg.Store(c)
}

func (d *Detector) ParseUA(raw string) *UA { return d.cfg.Load().ua.parse(raw) }

func (d *Detector) Threshold() int { return d.cfg.Load().st.BotThreshold }

// Request is everything known about a visit before routing it.
type Request struct {
	IP     netip.Addr
	UA     *UA
	Header http.Header
	Proto  string // "HTTP/1.1", "HTTP/2.0"; empty when unknown (server-side integrations)
	Secure bool   // visitor reached us over HTTPS
	TLS    *TLSInfo
	Geo    geo.Info
}

type Verdict struct {
	Bot        bool
	Datacenter bool
	Score      int
	Reasons    []string
}

func (v *Verdict) add(score int, reason string) {
	v.Score += score
	v.Reasons = append(v.Reasons, reason)
}

// Reason is the compact form stored with the click.
func (v *Verdict) Reason() string { return strings.Join(v.Reasons, ",") }

const hard = 1000 // a signal that is conclusive on its own

// Check runs every passive signal. It only blocks on the network when an
// external provider is configured and the answer is not cached.
func (d *Detector) Check(ctx context.Context, r *Request) Verdict {
	c := d.cfg.Load()
	var v Verdict

	if _, ok := d.Lists.Match(model.ListAllow, r.IP); ok {
		return v
	}
	if name, ok := d.Lists.Match(model.ListBlock, r.IP); ok {
		v.add(hard, "blocklist:"+name)
	}
	if name, ok := d.Lists.Match(model.ListBot, r.IP); ok {
		v.add(hard, "ip:"+name)
	}
	if c.botASN[r.Geo.ASN] {
		v.add(hard, "bot_asn")
	}
	if _, ok := d.Lists.Match(model.ListDatacenter, r.IP); ok || c.dcASN[r.Geo.ASN] {
		v.Datacenter = true
		if c.st.DatacenterIsBot {
			v.add(hard, "datacenter")
		}
	}
	if r.UA.Bot {
		v.add(hard, "ua:"+r.UA.BotSig)
	}

	if c.st.HeaderChecks && r.Header != nil {
		h := r.Header
		if p := h.Get("Purpose") + h.Get("Sec-Purpose") + h.Get("X-Purpose") + h.Get("X-Moz"); strings.Contains(p, "prefetch") || strings.Contains(p, "preview") {
			v.add(hard, "prefetch")
		}
		if h.Get("Accept-Language") == "" {
			v.add(50, "no_accept_language")
		}
		if h.Get("Accept") == "" {
			v.add(40, "no_accept")
		}
		if h.Get("Accept-Encoding") == "" {
			v.add(30, "no_accept_encoding")
		}
		if r.Proto == "HTTP/1.0" {
			v.add(60, "http10")
		}
		// Every Chromium since v90 sends client hints and fetch metadata on secure origins.
		if r.Secure && r.UA.Chromium && r.UA.Major >= 90 {
			if h.Get("Sec-Ch-Ua") == "" {
				v.add(50, "no_client_hints")
			}
			if h.Get("Sec-Fetch-Mode") == "" {
				v.add(50, "no_fetch_metadata")
			}
		}
		if ch := h.Get("Sec-Ch-Ua"); strings.Contains(ch, "Headless") {
			v.add(hard, "headless")
		}
		// Client hint platform must agree with the User-Agent.
		if pf := strings.Trim(h.Get("Sec-Ch-Ua-Platform"), `"`); pf != "" && r.UA.OS != "" {
			if !platformMatches(pf, r.UA.OS) {
				v.add(60, "platform_mismatch")
			}
		}
	}

	if c.st.TLSChecks && r.TLS != nil {
		if c.ja3[r.TLS.JA3] || c.ja4[strings.ToLower(r.TLS.JA4)] {
			v.add(hard, "tls_blocklist")
		}
		browser := r.UA.DeviceType != "bot" && r.UA.Browser != ""
		if browser && !r.TLS.TLS13 {
			v.add(60, "tls_no_13")
		}
		if browser && !r.TLS.H2 {
			v.add(50, "tls_no_h2")
		}
		// Chromium and Safari randomise GREASE into every handshake; HTTP
		// libraries posing as them do not.
		if r.UA.GreaseTLS && !r.TLS.Grease {
			v.add(60, "tls_no_grease")
		}
	}

	if v.Score < c.st.BotThreshold {
		for _, p := range c.providers {
			doc, err := p.Lookup(ctx, r.IP.String(), r.UA.Raw)
			if err != nil || doc == nil {
				continue // fail open
			}
			var th float64
			if s := p.Cfg.Mapping["threshold"]; s != "" {
				th, _ = parseFloat(s)
			}
			if extapi.Truthy(extapi.Path(doc, p.Cfg.Mapping["bot"]), th) {
				v.add(hard, "ext:"+p.Cfg.Name)
				break
			}
		}
	}

	v.Bot = v.Score >= c.st.BotThreshold
	return v
}

func platformMatches(hint, uaOS string) bool {
	hint, uaOS = strings.ToLower(hint), strings.ToLower(uaOS)
	switch {
	case strings.Contains(hint, "windows"):
		return strings.Contains(uaOS, "windows")
	case strings.Contains(hint, "mac"):
		return strings.Contains(uaOS, "mac")
	case strings.Contains(hint, "android"):
		return strings.Contains(uaOS, "android")
	case strings.Contains(hint, "ios"):
		return strings.Contains(uaOS, "ios")
	case strings.Contains(hint, "linux"), strings.Contains(hint, "chrome"):
		return strings.Contains(uaOS, "linux") || strings.Contains(uaOS, "chrome") || strings.Contains(uaOS, "android")
	}
	return true
}
