package antibot

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"simpletds/internal/model"
	"simpletds/internal/store"
)

type namedSet struct {
	name string
	set  *Set
}

type listSnap struct {
	byKind map[string][]namedSet
}

// Lists keeps the IP lists (bot, datacenter, block, allow) in memory and
// refreshes URL-backed ones on their schedule.
type Lists struct {
	st   *store.Store
	dir  string
	snap atomic.Pointer[listSnap]
	mu   sync.Mutex
}

func NewLists(st *store.Store, dir string) *Lists {
	os.MkdirAll(dir, 0o755)
	l := &Lists{st: st, dir: dir}
	l.snap.Store(&listSnap{byKind: map[string][]namedSet{}})
	return l
}

func (l *Lists) file(id int64) string {
	return filepath.Join(l.dir, strconv.FormatInt(id, 10)+".txt")
}

// Reload rebuilds the in-memory sets from the database and the on-disk copies
// of downloaded lists. It does no network I/O.
func (l *Lists) Reload(ctx context.Context) error {
	lists, err := store.List[model.IPList](ctx, l.st, "ip_lists", "id")
	if err != nil {
		return err
	}
	snap := &listSnap{byKind: map[string][]namedSet{}}
	for _, it := range lists {
		if !it.Enabled {
			continue
		}
		prefixes := ParsePrefixes([]byte(it.Content))
		if it.URL != "" {
			if b, err := os.ReadFile(l.file(it.ID)); err == nil {
				prefixes = append(prefixes, ParsePrefixes(b)...)
			}
		}
		if len(prefixes) == 0 {
			continue
		}
		snap.byKind[it.Kind] = append(snap.byKind[it.Kind], namedSet{it.Name, NewSet(prefixes)})
	}
	l.snap.Store(snap)
	return nil
}

// Match returns the name of the first list of the given kind containing ip.
func (l *Lists) Match(kind string, ip netip.Addr) (string, bool) {
	for _, ns := range l.snap.Load().byKind[kind] {
		if ns.set.Contains(ip) {
			return ns.name, true
		}
	}
	return "", false
}

// Refresh downloads URL-backed lists. id 0 means every list that is due.
func (l *Lists) Refresh(ctx context.Context, id int64, force bool) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	lists, err := store.List[model.IPList](ctx, l.st, "ip_lists", "id")
	if err != nil {
		return err
	}
	var firstErr error
	for _, it := range lists {
		if (id != 0 && it.ID != id) || !it.Enabled {
			continue
		}
		if it.URL == "" {
			l.st.SetListState(ctx, it.ID, len(ParsePrefixes([]byte(it.Content))), "")
			continue
		}
		every := time.Duration(it.RefreshHours) * time.Hour
		if every <= 0 {
			every = 24 * time.Hour
		}
		_, statErr := os.Stat(l.file(it.ID))
		if !force && statErr == nil && it.UpdatedAt != nil && time.Since(*it.UpdatedAt) < every {
			continue
		}
		n, err := l.download(ctx, it)
		if err != nil {
			slog.Warn("ip list update failed", "list", it.Name, "err", err)
			l.st.SetListState(ctx, it.ID, it.Entries, err.Error())
			if firstErr == nil {
				firstErr = fmt.Errorf("%s: %w", it.Name, err)
			}
			continue
		}
		l.st.SetListState(ctx, it.ID, n+len(ParsePrefixes([]byte(it.Content))), "")
	}
	if err := l.Reload(ctx); err != nil {
		return err
	}
	return firstErr
}

func (l *Lists) download(ctx context.Context, it model.IPList) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, it.URL, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; list-fetcher)")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return 0, err
	}
	prefixes := ParsePrefixes(body)
	if len(prefixes) == 0 {
		return 0, fmt.Errorf("no IP ranges found in response")
	}
	// Store normalised, one prefix per line.
	buf := make([]byte, 0, len(prefixes)*20)
	for _, p := range prefixes {
		buf = append(buf, p.String()...)
		buf = append(buf, '\n')
	}
	return len(prefixes), os.WriteFile(l.file(it.ID), buf, 0o644)
}

// Remove deletes the on-disk copy of a list.
func (l *Lists) Remove(id int64) { os.Remove(l.file(id)) }
