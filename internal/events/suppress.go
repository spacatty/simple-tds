package events

import (
	"context"
	"log/slog"
	"time"
)

// Suppressed is one request refused by a user's suppress rule.
type Suppressed struct {
	TS      time.Time
	OwnerID uint32 // the rule's owner
	Kind    string // ip | referer
	RuleID  uint64
	// Log keeps the request itself next to the counter; the fields below are
	// only filled in then.
	Log        bool
	Rule       string // the rule's value at the time
	IP         string
	Referer    string
	Domain     string
	UA         string
	CampaignID uint32
}

// AddSuppressed queues a suppressed request. It never blocks: when the queue
// is full the request goes uncounted.
func (db *DB) AddSuppressed(s *Suppressed) {
	select {
	case db.suppressed <- s:
	default:
	}
}

type supKey struct {
	day    time.Time
	owner  uint32
	kind   string
	ruleID uint64
}

type supCount struct {
	hits uint64
	last time.Time
}

func (db *DB) suppressedWriter() {
	defer close(db.supDone)
	// Counted here rather than in ClickHouse: a flood from one source costs
	// one row a second, however many requests it sends.
	counts := map[supKey]*supCount{}
	log := make([]*Suppressed, 0, 1000)
	tick := time.NewTicker(flushEvery)
	defer tick.Stop()
	add := func(s *Suppressed) {
		k := supKey{s.TS.UTC().Truncate(24 * time.Hour), s.OwnerID, s.Kind, s.RuleID}
		c := counts[k]
		if c == nil {
			c = &supCount{}
			counts[k] = c
		}
		c.hits++
		c.last = s.TS.UTC()
		if s.Log && len(log) < cap(log) {
			log = append(log, s) // beyond this many a second, the counter is enough
		}
	}
	flush := func() {
		if len(counts) > 0 {
			// On failure the counters stay and go out with the next flush.
			if err := db.writeSuppressedStats(counts); err != nil {
				slog.Error("suppressed counters not written", "err", err)
			} else {
				clear(counts)
			}
		}
		if len(log) > 0 {
			if err := db.writeSuppressedLog(log); err != nil {
				slog.Error("suppressed log batch lost", "rows", len(log), "err", err)
			}
			log = log[:0]
		}
	}
	for {
		select {
		case s := <-db.suppressed:
			add(s)
		case <-tick.C:
			flush()
		case <-db.quit:
			for {
				select {
				case s := <-db.suppressed:
					add(s)
					continue
				default:
				}
				flush()
				return
			}
		}
	}
}

func (db *DB) writeSuppressedStats(counts map[supKey]*supCount) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	batch, err := db.conn.PrepareBatch(ctx, "INSERT INTO suppress_stats (day, owner_id, kind, rule_id, hits, last)")
	if err != nil {
		return err
	}
	for k, c := range counts {
		if err := batch.Append(k.day, k.owner, k.kind, k.ruleID, c.hits, c.last); err != nil {
			batch.Abort()
			return err
		}
	}
	return batch.Send()
}

func (db *DB) writeSuppressedLog(rows []*Suppressed) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	batch, err := db.conn.PrepareBatch(ctx, "INSERT INTO suppress_log (ts, owner_id, kind, rule_id, rule, ip, referer, domain, campaign_id, ua)")
	if err != nil {
		return err
	}
	for _, s := range rows {
		if err := batch.Append(s.TS, s.OwnerID, s.Kind, s.RuleID, s.Rule, s.IP, s.Referer, s.Domain, s.CampaignID, s.UA); err != nil {
			batch.Abort()
			return err
		}
	}
	return batch.Send()
}

// SuppressedStats returns, per rule of one kind a user has, how many requests
// it refused: in the last seven days, in all the time kept, and when the last
// one came.
func (db *DB) SuppressedStats(ctx context.Context, owner uint32, kind string) ([]Row, error) {
	return db.query(ctx, `SELECT rule_id, sum(hits) AS total, sumIf(hits, day >= today() - 6) AS week, max(last) AS last
		FROM suppress_stats WHERE owner_id = ? AND kind = ? GROUP BY rule_id`, owner, kind)
}

// SuppressedLog returns a user's logged requests of one kind, newest first.
func (db *DB) SuppressedLog(ctx context.Context, owner uint32, kind string, limit, offset int) ([]Row, uint64, error) {
	const where = " FROM suppress_log WHERE owner_id = ? AND kind = ?"
	var total uint64
	if err := db.conn.QueryRow(ctx, "SELECT count()"+where, owner, kind).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := db.query(ctx, "SELECT ts, rule_id, rule, ip, referer, domain, campaign_id, ua"+where+
		" ORDER BY ts DESC LIMIT ? OFFSET ?", owner, kind, limit, offset)
	return rows, total, err
}

// ClearSuppressed forgets what a user kept about one kind of rule.
func (db *DB) ClearSuppressed(ctx context.Context, owner uint32, kind string) error {
	time.Sleep(flushEvery + 200*time.Millisecond) // let queued requests land first
	for _, t := range []string{"suppress_stats", "suppress_log"} {
		if err := db.conn.Exec(ctx, "DELETE FROM "+t+" WHERE owner_id = ? AND kind = ?", owner, kind); err != nil {
			return err
		}
	}
	return nil
}
