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
	reject := func(status int, reason string) (int, string) {
		e.limits.Allow("pb-rej|"+ip.String(), 1<<30)
		e.Reject.add(Rejected{At: time.Now(), IP: ip.String(), Key: clip(keyStr, 12), Reason: reason, Query: q.Encode()})
		return status, http.StatusText(status)
	}

	// A sender that keeps getting refused is guessing: stop answering it.
	if e.limits.Count("pb-rej|"+ip.String()) > maxRejectsPerMinute {
		return http.StatusTooManyRequests, http.StatusText(http.StatusTooManyRequests)
	}
	key := snap.Keys[keyStr]
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
	valid := false
	for _, t := range model.ConversionTypes {
		valid = valid || t == typ
	}
	if !valid {
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
		switch {
		case err == nil && now.Sub(ref.At) <= window:
			conv.ClickID, conv.CampaignID, conv.StreamID = id, ref.CampaignID, ref.StreamID
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
		c, err := e.Events.LastClickByIP(in.Ctx, target.String(), now.Add(-window))
		if err != nil {
			slog.Warn("postback click lookup failed", "err", err)
		}
		if c != nil {
			click = c
			conv.ClickID, conv.CampaignID, conv.StreamID = c.ClickID, c.CampaignID, c.StreamID
		} else if key.RequireClick {
			return reject(http.StatusBadRequest, "no click from "+target.String())
		}
	}

	if key.Dedupe && conv.ClickID != "" {
		dk := conv.ClickID + "|" + typ
		if _, seen := e.convs.Get(dk); seen {
			return http.StatusOK, "DUPLICATE"
		}
		if dup, err := e.Events.ConversionExists(in.Ctx, conv.ClickID, typ); err == nil && dup {
			e.convs.Add(dk, struct{}{})
			return http.StatusOK, "DUPLICATE"
		}
		e.convs.Add(dk, struct{}{})
	}

	if click != nil {
		conv.Domain, conv.Country, conv.Region, conv.City, conv.ISP = click.Domain, click.Country, click.Region, click.City, click.ISP
		conv.DeviceType, conv.OS, conv.Browser, conv.Lang = click.DeviceType, click.OS, click.Browser, click.Lang
		conv.RefDomain, conv.Keyword, conv.Sub = click.RefDomain, click.Keyword, click.Sub
	}

	campaign := snap.ByID[int64(conv.CampaignID)]
	if typ != "rejected" {
		conv.Revenue = key.DefaultRevenue
		if s := first(q, "revenue", "payout"); s != "" {
			if f, err := strconv.ParseFloat(s, 64); err == nil && f >= 0 && f < 1e12 {
				conv.Revenue = f
			}
		}
		if campaign != nil {
			switch campaign.CostModel {
			case "cpa":
				conv.Cost = campaign.CostValue
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

	var rnd [9]byte
	rand.Read(rnd[:])
	conv.ConvID = hex.EncodeToString(rnd[:])

	if err := e.Events.AddConversion(in.Ctx, conv); err != nil {
		slog.Error("conversion not stored", "err", err)
		if key.Dedupe && conv.ClickID != "" {
			e.convs.Remove(conv.ClickID + "|" + typ) // let the sender retry
		}
		return http.StatusServiceUnavailable, "RETRY"
	}
	return http.StatusOK, "OK"
}
