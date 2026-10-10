package web

import (
	"context"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"simpletds/internal/model"
	"simpletds/internal/reputation"
	"simpletds/internal/store"
)

// Domain reputation: on a schedule, and whenever a domain is added or
// re-checked, the providers an administrator switched on are asked whether
// the domain is on their blocklists. The answers are stored on the domain and
// only shown: nothing on the click path depends on them.

// repState is the bookkeeping of the reputation checker.
type repState struct {
	checker *reputation.Checker

	mu       sync.Mutex
	inflight map[int64]bool       // domains a run is working on
	next     map[string]time.Time // per provider: when its next request may go out

	saveMu sync.Mutex // one read-merge-write of a domain's results at a time
}

func newRepState() repState {
	return repState{checker: reputation.New(os.Getenv("TDS_BLOCKLIST_DNS")), inflight: map[int64]bool{}, next: map[string]time.Time{}}
}

const (
	repTick       = 10 * time.Minute // how often due domains are looked for
	repManualGap  = 2 * time.Minute  // "re-check" pressed again sooner than this asks nobody
	repDefaultVT  = 2                // votes that flag a domain, unless set
	repDefaultRPM = 4                // requests a minute for rate-limited providers, unless set
)

func (s *Server) repInterval() time.Duration {
	return time.Duration(max(s.eng.Snap().Settings.Reputation.IntervalHours, 1)) * time.Hour
}

// repActive lists the providers that are switched on and usable.
func repActive(set model.ReputationSettings) []reputation.Def {
	var out []reputation.Def
	for _, d := range reputation.Defs() {
		if reputation.Usable(d, set.Providers[d.ID]) {
			out = append(out, d)
		}
	}
	return out
}

// repSlot waits for the provider's next free request slot.
func (s *Server) repSlot(ctx context.Context, id string, perMinute int) bool {
	gap := time.Minute / time.Duration(perMinute)
	s.rep.mu.Lock()
	at, now := s.rep.next[id], time.Now()
	if at.Before(now) {
		at = now
	}
	s.rep.next[id] = at.Add(gap)
	s.rep.mu.Unlock()
	select {
	case <-time.After(time.Until(at)):
		return true
	case <-ctx.Done():
		return false
	}
}

// checkReputation asks the active providers about the given domains (every
// enabled one when ids is nil), leaving out those checked less than minAge ago.
func (s *Server) checkReputation(ctx context.Context, ids []int64, minAge time.Duration) {
	set := s.eng.Snap().Settings.Reputation
	active := repActive(set)
	domains, err := store.List[model.Domain](ctx, s.st, "domains", "id")
	if err != nil {
		return
	}
	if len(active) == 0 {
		// Answers left from when a provider was on would only mislead.
		for _, d := range domains {
			if d.RepStatus != "" || len(d.Reputation) > 0 {
				s.st.SetDomainReputation(ctx, d.ID, "", nil)
			}
		}
		return
	}
	want := map[int64]bool{}
	for _, id := range ids {
		want[id] = true
	}
	var todo []model.Domain
	s.rep.mu.Lock()
	for _, d := range domains {
		switch {
		case ids != nil && !want[d.ID], ids == nil && !d.Enabled:
		case d.RepCheckedAt != nil && time.Since(*d.RepCheckedAt) < minAge:
		case s.rep.inflight[d.ID]:
		default:
			s.rep.inflight[d.ID] = true
			todo = append(todo, d)
		}
	}
	s.rep.mu.Unlock()
	if len(todo) == 0 {
		return
	}
	defer func() {
		s.rep.mu.Lock()
		for _, d := range todo {
			delete(s.rep.inflight, d.ID)
		}
		s.rep.mu.Unlock()
	}()

	on := map[string]bool{}
	for _, def := range active {
		on[def.ID] = true
	}
	// An answer is kept through a provider's bad day, but not for ever.
	keep := 3 * s.repInterval()
	var wg sync.WaitGroup
	for _, def := range active {
		cfg := set.Providers[def.ID]
		if cfg.Threshold <= 0 {
			cfg.Threshold = repDefaultVT
		}
		workers, perMinute := 4, 0
		if def.Rate {
			workers, perMinute = 1, cfg.PerMinute
			if perMinute <= 0 {
				perMinute = repDefaultRPM
			}
		}
		// Each provider goes through the domains at its own pace, so a slow
		// quota does not hold back the answers of the quick ones.
		queue := make(chan model.Domain)
		stop := make(chan struct{})
		var once sync.Once
		for range workers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for d := range queue {
					if perMinute > 0 && !s.repSlot(ctx, def.ID, perMinute) {
						return
					}
					res, down := s.rep.checker.Check(ctx, def.ID, cfg, d.Name)
					s.saveReputation(ctx, d.ID, res, on, keep)
					if down {
						// A rejected key or a spent quota fails for every domain alike.
						once.Do(func() { close(stop) })
					}
				}
			}()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer close(queue)
			for _, d := range todo {
				select {
				case queue <- d:
				case <-stop:
					return
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	wg.Wait()
}

func (s *Server) saveReputation(ctx context.Context, id int64, res model.RepResult, active map[string]bool, keep time.Duration) {
	s.rep.saveMu.Lock()
	defer s.rep.saveMu.Unlock()
	var cur []model.RepResult
	// The domain may have been deleted while it was being checked.
	if err := s.st.Pool.QueryRow(ctx, "SELECT reputation FROM domains WHERE id=$1", id).Scan(&cur); err != nil {
		return
	}
	out, status := mergeReputation(cur, res, active, keep)
	s.st.SetDomainReputation(ctx, id, status, out)
}

// mergeReputation puts one new answer into a domain's stored ones and sums
// them up. Answers of providers that are no longer active are dropped. A
// failed check does not erase a recent verdict: a timeout must not turn a
// listed domain clean.
func mergeReputation(cur []model.RepResult, res model.RepResult, active map[string]bool, keep time.Duration) ([]model.RepResult, string) {
	out := []model.RepResult{}
	placed := false
	for _, r := range cur {
		switch {
		case !active[r.Provider]:
		case r.Provider != res.Provider:
			out = append(out, r)
		case res.Status == reputation.Failed && r.Status != reputation.Failed && res.CheckedAt.Sub(r.CheckedAt) < keep:
			out, placed = append(out, r), true
		}
	}
	if !placed {
		out = append(out, res)
	}
	order := map[string]int{}
	for i, d := range reputation.Defs() {
		order[d.ID] = i
	}
	sort.SliceStable(out, func(i, j int) bool { return order[out[i].Provider] < order[out[j].Provider] })
	status := "unknown"
	for _, r := range out {
		if r.Status == reputation.Listed {
			return out, "listed"
		}
		if r.Status == reputation.Clean {
			status = "clean"
		}
	}
	return out, status
}

var reRepKey = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)

// cleanReputation normalises the reputation settings an administrator saved.
func cleanReputation(set *model.ReputationSettings) error {
	if set.IntervalHours < 1 {
		set.IntervalHours = 12
	}
	if set.IntervalHours > 24*30 {
		return bad("the reputation check interval cannot be longer than 720 hours")
	}
	out := map[string]model.RepProvider{}
	for _, d := range reputation.Defs() {
		p, ok := set.Providers[d.ID]
		if !ok {
			continue
		}
		p.Key = strings.TrimSpace(p.Key)
		switch {
		case d.Key == reputation.KeyNone:
			p.Key = ""
		// Keys travel in headers and, for Spamhaus, inside a DNS name.
		case p.Key != "" && !reRepKey.MatchString(p.Key):
			return bad(d.Name + ": this does not look like an API key")
		case p.Enabled && d.Key == reputation.KeyRequired && p.Key == "":
			return bad(d.Name + ": an API key is needed to switch it on")
		}
		if !d.Threshold {
			p.Threshold = 0
		} else if p.Threshold < 1 || p.Threshold > 50 {
			p.Threshold = repDefaultVT
		}
		if !d.Rate {
			p.PerMinute = 0
		} else if p.PerMinute < 1 || p.PerMinute > 600 {
			p.PerMinute = repDefaultRPM
		}
		out[d.ID] = p
	}
	set.Providers = out
	return nil
}
