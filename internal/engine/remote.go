package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	remoteMaxBody    = 2 << 20
	remoteMaxEntries = 5000
)

type remoteEntry struct {
	mu         sync.Mutex // serialises the first fetch
	body       []byte
	fetched    time.Time
	refreshing atomic.Bool
}

// remoteCache holds JavaScript fetched from partner endpoints, keyed by URL.
type remoteCache struct {
	mu      sync.Mutex
	entries map[string]*remoteEntry
	client  *http.Client
}

func newRemoteCache() *remoteCache {
	return &remoteCache{entries: map[string]*remoteEntry{}, client: &http.Client{
		Transport: &http.Transport{MaxIdleConnsPerHost: 32, IdleConnTimeout: 90 * time.Second},
	}}
}

func (c *remoteCache) entry(key string) *remoteEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.entries[key]
	if e == nil {
		if len(c.entries) >= remoteMaxEntries {
			// Per-visitor URLs can grow without bound; start over rather than track LRU order.
			c.entries = map[string]*remoteEntry{}
		}
		e = &remoteEntry{}
		c.entries[key] = e
	}
	return e
}

type remoteJSConfig struct {
	URL            string `json:"url"`
	CacheMinutes   int    `json:"cache_minutes"`
	Mode           string `json:"mode"`
	TimeoutMs      int    `json:"timeout_ms"`
	Headers        string `json:"headers"`
	ForwardVisitor bool   `json:"forward_visitor"`
	OnError        string `json:"on_error"`
}

func (c *remoteCache) fetch(ctx context.Context, url string, headers [][2]string, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	for _, h := range headers {
		req.Header.Set(h[0], h[1])
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("source answered HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, remoteMaxBody+1))
	if err != nil {
		return nil, err
	}
	if len(body) > remoteMaxBody {
		return nil, errors.New("source response is larger than 2 MB")
	}
	return body, nil
}

// get returns the code for url. A fresh cached copy is returned directly; a
// stale one is returned immediately while one background request refreshes
// it, so the partner endpoint sees at most one request per interval per URL.
func (c *remoteCache) get(ctx context.Context, url string, headers [][2]string, ttl, timeout time.Duration) (body []byte, stale bool, err error) {
	if ttl <= 0 {
		body, err = c.fetch(ctx, url, headers, timeout)
		return body, false, err
	}
	e := c.entry(url)
	e.mu.Lock()
	if e.body == nil {
		// First request for this URL: fetch while holding the lock so
		// concurrent visitors wait for one request instead of each sending one.
		b, err := c.fetch(ctx, url, headers, timeout)
		if err != nil {
			e.mu.Unlock()
			return nil, false, err
		}
		e.body, e.fetched = b, time.Now()
	}
	body, age := e.body, time.Since(e.fetched)
	e.mu.Unlock()

	if age > ttl && e.refreshing.CompareAndSwap(false, true) {
		go func() {
			defer e.refreshing.Store(false)
			b, err := c.fetch(context.Background(), url, headers, timeout)
			e.mu.Lock()
			if err != nil {
				slog.Warn("remote js refresh failed", "url", url, "err", err)
				// Back off for a minute instead of retrying on every click.
				e.fetched = time.Now().Add(-ttl + time.Minute)
			} else {
				e.body, e.fetched = b, time.Now()
			}
			e.mu.Unlock()
		}()
	}
	return body, age > ttl, nil
}

// Purge drops every cached script.
func (c *remoteCache) Purge() {
	c.mu.Lock()
	c.entries = map[string]*remoteEntry{}
	c.mu.Unlock()
}

// PurgeRemoteCache forces remote JavaScript to be fetched again.
func (e *Engine) PurgeRemoteCache() { e.remote.Purge() }

func buildRemoteJS(cfg json.RawMessage, e *Engine) (Handler, error) {
	c := remoteJSConfig{CacheMinutes: 5, Mode: "html", TimeoutMs: 3000, OnError: "stale"}
	if err := decode(cfg, &c); err != nil {
		return nil, err
	}
	if err := validURL(c.URL); err != nil {
		return nil, err
	}
	if strings.HasPrefix(c.URL, "/") {
		return nil, errors.New("source URL must be absolute")
	}
	if c.CacheMinutes < 0 || c.CacheMinutes > 7*24*60 {
		return nil, errors.New("cache must be between 0 and 10080 minutes")
	}
	if c.TimeoutMs < 100 || c.TimeoutMs > 30000 {
		c.TimeoutMs = 3000
	}
	var headerTmpl [][2]string
	for _, line := range strings.Split(c.Headers, "\n") {
		if line = strings.TrimSpace(line); line == "" {
			continue
		}
		k, val, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(k) == "" {
			return nil, fmt.Errorf("bad header line %q", line)
		}
		headerTmpl = append(headerTmpl, [2]string{strings.TrimSpace(k), strings.TrimSpace(val)})
	}
	ttl := time.Duration(c.CacheMinutes) * time.Minute
	timeout := time.Duration(c.TimeoutMs) * time.Millisecond

	return func(v *Visit) (*Result, error) {
		url := v.expand(c.URL, true)
		headers := make([][2]string, 0, len(headerTmpl)+2)
		for _, h := range headerTmpl {
			headers = append(headers, [2]string{h[0], v.expand(h[1], false)})
		}
		if c.ForwardVisitor {
			headers = append(headers, [2]string{"User-Agent", v.UA.Raw}, [2]string{"X-Forwarded-For", v.IP.String()})
		}
		code, _, err := e.remote.get(v.Ctx, url, headers, ttl, timeout)
		if err != nil {
			slog.Warn("remote js fetch failed", "url", url, "err", err)
			if c.OnError == "404" {
				return notFound(), nil
			}
			code = []byte{}
		}
		if c.Mode == "script" {
			return &Result{Status: http.StatusOK, ContentType: "application/javascript; charset=utf-8", Body: code, Script: code}, nil
		}
		// Keep the code from closing its own <script> element.
		safe := strings.ReplaceAll(string(code), "</script", `<\/script`)
		page := `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>` + safe + `</script></body></html>`
		return &Result{Status: http.StatusOK, ContentType: "text/html; charset=utf-8", Body: []byte(page), Script: code}, nil
	}, nil
}
