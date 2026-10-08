// Package geo resolves IPs to location and network using local MMDB files
// (DB-IP Lite by default, GeoLite2 when a MaxMind key is configured).
package geo

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	lru "github.com/hashicorp/golang-lru/v2"
	"github.com/oschwald/maxminddb-golang/v2"

	"simpletds/internal/model"
)

type Info struct {
	Country string `json:"country"`
	Region  string `json:"region"`
	City    string `json:"city"`
	ASN     uint32 `json:"asn"`
	ISP     string `json:"isp"`
}

type DB struct {
	dir   string
	city  atomic.Pointer[maxminddb.Reader]
	asn   atomic.Pointer[maxminddb.Reader]
	cache *lru.Cache[netip.Addr, Info]
	mu    sync.Mutex // serialises refreshes
	last  atomic.Value
}

func New(dir string) *DB {
	os.MkdirAll(dir, 0o755)
	c, _ := lru.New[netip.Addr, Info](200_000)
	g := &DB{dir: dir, cache: c}
	g.last.Store("")
	g.open("city")
	g.open("asn")
	return g
}

func (g *DB) path(kind string) string { return filepath.Join(g.dir, kind+".mmdb") }

func (g *DB) slot(kind string) *atomic.Pointer[maxminddb.Reader] {
	if kind == "asn" {
		return &g.asn
	}
	return &g.city
}

func (g *DB) open(kind string) error {
	r, err := maxminddb.Open(g.path(kind))
	if err != nil {
		return err
	}
	if old := g.slot(kind).Swap(r); old != nil {
		// In-flight lookups may still be reading the old mapping.
		time.AfterFunc(time.Minute, func() { old.Close() })
	}
	g.cache.Purge()
	return nil
}

// Both DB-IP and GeoLite2 share this layout.
type cityRec struct {
	Country struct {
		ISO string `maxminddb:"iso_code"`
	} `maxminddb:"country"`
	Subdivisions []struct {
		Names map[string]string `maxminddb:"names"`
	} `maxminddb:"subdivisions"`
	City struct {
		Names map[string]string `maxminddb:"names"`
	} `maxminddb:"city"`
}

type asnRec struct {
	ASN uint32 `maxminddb:"autonomous_system_number"`
	Org string `maxminddb:"autonomous_system_organization"`
}

func (g *DB) Lookup(ip netip.Addr) Info {
	if v, ok := g.cache.Get(ip); ok {
		return v
	}
	var out Info
	if r := g.city.Load(); r != nil {
		var rec cityRec
		if r.Lookup(ip).Decode(&rec) == nil {
			out.Country = rec.Country.ISO
			out.City = rec.City.Names["en"]
			if len(rec.Subdivisions) > 0 {
				out.Region = rec.Subdivisions[0].Names["en"]
			}
		}
	}
	if r := g.asn.Load(); r != nil {
		var rec asnRec
		if r.Lookup(ip).Decode(&rec) == nil {
			out.ASN, out.ISP = rec.ASN, rec.Org
		}
	}
	g.cache.Add(ip, out)
	return out
}

type FileStatus struct {
	Loaded  bool      `json:"loaded"`
	Updated time.Time `json:"updated"`
	Size    int64     `json:"size"`
}

type Status struct {
	City      FileStatus `json:"city"`
	ASN       FileStatus `json:"asn"`
	LastError string     `json:"last_error"`
}

func (g *DB) Status() Status {
	fs := func(kind string) FileStatus {
		s := FileStatus{Loaded: g.slot(kind).Load() != nil}
		if fi, err := os.Stat(g.path(kind)); err == nil {
			s.Updated, s.Size = fi.ModTime(), fi.Size()
		}
		return s
	}
	return Status{City: fs("city"), ASN: fs("asn"), LastError: g.last.Load().(string)}
}

// Install replaces a database with an uploaded MMDB file.
func (g *DB) Install(kind string, src io.Reader) error {
	if kind != "city" && kind != "asn" {
		return fmt.Errorf("unknown database %q", kind)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.install(kind, src)
}

func (g *DB) install(kind string, src io.Reader) error {
	tmp := g.path(kind) + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, io.LimitReader(src, 2<<30))
	f.Close()
	if err != nil {
		return err
	}
	// Validate before replacing the live file.
	r, err := maxminddb.Open(tmp)
	if err != nil {
		os.Remove(tmp)
		return fmt.Errorf("not a valid MMDB file: %w", err)
	}
	r.Close()
	if err := os.Rename(tmp, g.path(kind)); err != nil {
		return err
	}
	return g.open(kind)
}

// Refresh downloads databases that are missing or older than the configured age.
func (g *DB) Refresh(ctx context.Context, st model.Settings, force bool) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	maxAge := time.Duration(st.GeoRefreshDays) * 24 * time.Hour
	if maxAge <= 0 {
		maxAge = 7 * 24 * time.Hour
	}
	urls := map[string]string{"city": st.GeoCityURL, "asn": st.GeoASNURL}
	if st.MaxMindKey != "" {
		const mm = "https://download.maxmind.com/app/geoip_download?edition_id=%s&license_key=%s&suffix=tar.gz"
		urls["city"] = fmt.Sprintf(mm, "GeoLite2-City", st.MaxMindKey)
		urls["asn"] = fmt.Sprintf(mm, "GeoLite2-ASN", st.MaxMindKey)
	}
	var firstErr error
	for kind, u := range urls {
		if u == "" {
			continue
		}
		if fi, err := os.Stat(g.path(kind)); err == nil && !force && time.Since(fi.ModTime()) < maxAge {
			continue
		}
		if err := g.download(ctx, kind, u); err != nil {
			slog.Warn("geo database update failed", "db", kind, "err", err)
			if firstErr == nil {
				firstErr = fmt.Errorf("%s: %w", kind, err)
			}
			continue
		}
		slog.Info("geo database updated", "db", kind)
	}
	if firstErr != nil {
		g.last.Store(firstErr.Error())
	} else {
		g.last.Store("")
	}
	return firstErr
}

func (g *DB) download(ctx context.Context, kind, tmpl string) error {
	// Monthly feeds may not have the current month published yet.
	now := time.Now().UTC()
	candidates := []string{tmpl}
	if strings.Contains(tmpl, "{YYYY}") || strings.Contains(tmpl, "{MM}") {
		candidates = candidates[:0]
		for _, t := range []time.Time{now, now.AddDate(0, 0, -now.Day())} {
			u := strings.ReplaceAll(tmpl, "{YYYY}", t.Format("2006"))
			candidates = append(candidates, strings.ReplaceAll(u, "{MM}", t.Format("01")))
		}
	}
	var err error
	for _, u := range candidates {
		if err = g.fetch(ctx, kind, u); err == nil {
			return nil
		}
	}
	return err
}

func (g *DB) fetch(ctx context.Context, kind, url string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var src io.Reader = resp.Body
	path := strings.ToLower(req.URL.Path + "?" + req.URL.RawQuery)
	switch {
	case strings.Contains(path, "tar.gz"):
		gz, err := gzip.NewReader(src)
		if err != nil {
			return err
		}
		tr := tar.NewReader(gz)
		for {
			h, err := tr.Next()
			if err != nil {
				return fmt.Errorf("no .mmdb in archive: %w", err)
			}
			if strings.HasSuffix(h.Name, ".mmdb") {
				src = tr
				break
			}
		}
	case strings.Contains(path, ".gz"):
		gz, err := gzip.NewReader(src)
		if err != nil {
			return err
		}
		src = gz
	}
	return g.install(kind, src)
}
