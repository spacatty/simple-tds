// Package extapi calls external HTTP JSON services (IP intelligence, geo,
// anti-fraud) and caches their answers so the click path rarely waits on them.
package extapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/hashicorp/golang-lru/v2/expirable"

	"simpletds/internal/model"
)

type Provider struct {
	Cfg    model.Integration
	cache  *expirable.LRU[string, any]
	client *http.Client
}

func New(cfg model.Integration) *Provider {
	if cfg.TimeoutMs <= 0 {
		cfg.TimeoutMs = 300
	}
	ttl := time.Duration(cfg.CacheMinutes) * time.Minute
	if ttl <= 0 {
		ttl = time.Hour
	}
	return &Provider{
		Cfg:    cfg,
		cache:  expirable.NewLRU[string, any](100_000, nil, ttl),
		client: &http.Client{Timeout: time.Duration(cfg.TimeoutMs) * time.Millisecond},
	}
}

// Lookup returns the decoded JSON document for ip. Failures are cached as nil
// like any other answer, so a dead provider costs one timeout per address
// rather than one per click.
func (p *Provider) Lookup(ctx context.Context, ip, ua string) (any, error) {
	usesUA := strings.Contains(p.Cfg.URL, "{ua}")
	key := ip
	if usesUA {
		key += "|" + ua
	}
	if v, ok := p.cache.Get(key); ok {
		return v, nil
	}
	doc, err := p.fetch(ctx, ip, ua)
	p.cache.Add(key, doc)
	return doc, err
}

func (p *Provider) fetch(ctx context.Context, ip, ua string) (any, error) {
	u := strings.NewReplacer("{ip}", url.QueryEscape(ip), "{ua}", url.QueryEscape(ua)).Replace(p.Cfg.URL)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range p.Cfg.Headers {
		req.Header.Set(k, v)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var doc any
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&doc); err != nil {
		return nil, err
	}
	return doc, nil
}

// Path walks a dot-separated path ("data.location.country") through a decoded JSON document.
func Path(doc any, path string) any {
	if path == "" {
		return nil
	}
	cur := doc
	for _, part := range strings.Split(path, ".") {
		switch node := cur.(type) {
		case map[string]any:
			cur = node[part]
		case []any:
			i, err := strconv.Atoi(part)
			if err != nil || i < 0 || i >= len(node) {
				return nil
			}
			cur = node[i]
		default:
			return nil
		}
	}
	return cur
}

func String(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	}
	return ""
}

// Truthy interprets a provider's bot flag: a boolean, a "true"/"yes"/"1"
// string, or a score compared against threshold.
func Truthy(v any, threshold float64) bool {
	switch t := v.(type) {
	case bool:
		return t
	case float64:
		if threshold > 0 {
			return t >= threshold
		}
		return t > 0
	case string:
		if f, err := strconv.ParseFloat(t, 64); err == nil {
			return Truthy(f, threshold)
		}
		s := strings.ToLower(t)
		return s == "true" || s == "yes"
	}
	return false
}
