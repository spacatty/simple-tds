// Package extapi calls external HTTP JSON services (IP intelligence, geo,
// anti-fraud) and caches their answers so the click path rarely waits on them.
package extapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hashicorp/golang-lru/v2/expirable"

	"simpletds/internal/model"
)

type Provider struct {
	Cfg    model.Integration
	stored model.Integration // as configured, to tell whether it changed
	cache  *expirable.LRU[string, answer]
	client *http.Client
	// Circuit breaker: a provider that keeps failing is left alone for a
	// while instead of costing every new visitor a timeout.
	fails  atomic.Int32
	paused atomic.Int64 // unix nanoseconds until which lookups are skipped
}

type answer struct {
	doc    any
	failed time.Time // zero for a good answer
}

const (
	failTTL    = time.Minute // how long a failed lookup is remembered
	breakAfter = 10          // consecutive failures that pause the provider
	breakFor   = 30 * time.Second
)

var errPaused = errors.New("provider paused after repeated failures")

func New(cfg model.Integration) *Provider {
	stored := cfg
	if cfg.TimeoutMs <= 0 {
		cfg.TimeoutMs = 300
	}
	ttl := time.Duration(cfg.CacheMinutes) * time.Minute
	if ttl <= 0 {
		ttl = time.Hour
	}
	return &Provider{
		Cfg:    cfg,
		stored: stored,
		cache:  expirable.NewLRU[string, answer](100_000, nil, ttl),
		client: &http.Client{Timeout: time.Duration(cfg.TimeoutMs) * time.Millisecond},
	}
}

var (
	sharedMu sync.Mutex
	shared   = map[int64]*Provider{}
)

// Shared returns the provider of a stored integration. The same provider, and
// with it the cache of answers, is handed out for as long as the integration
// is unchanged, so saving unrelated configuration does not send every visitor
// back to the external service.
func Shared(cfg model.Integration) *Provider {
	sharedMu.Lock()
	defer sharedMu.Unlock()
	if p := shared[cfg.ID]; p != nil && reflect.DeepEqual(p.stored, cfg) {
		return p
	}
	p := New(cfg)
	shared[cfg.ID] = p
	return p
}

// Lookup returns the decoded JSON document for ip. Good answers are cached
// for the configured time and failures for a minute, so a dead provider costs
// one timeout per address rather than one per click, yet a blip does not
// blind the tracker to that address for long.
func (p *Provider) Lookup(ctx context.Context, ip, ua string) (any, error) {
	key := ip
	if strings.Contains(p.Cfg.URL, "{ua}") {
		key += "|" + ua
	}
	if v, ok := p.cache.Get(key); ok && (v.failed.IsZero() || time.Since(v.failed) < failTTL) {
		return v.doc, nil
	}
	now := time.Now()
	if now.UnixNano() < p.paused.Load() {
		return nil, errPaused
	}
	// The answer is cached for everyone: a visitor who disconnects must not
	// turn it into a failure. The client timeout still bounds the request.
	doc, err := p.fetch(context.WithoutCancel(ctx), ip, ua)
	if err != nil {
		p.cache.Add(key, answer{failed: now})
		if p.fails.Add(1) >= breakAfter {
			p.fails.Store(0)
			p.paused.Store(now.Add(breakFor).UnixNano())
		}
		return nil, err
	}
	p.fails.Store(0)
	p.cache.Add(key, answer{doc: doc})
	return doc, nil
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
