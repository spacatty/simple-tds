package events

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

// A referrer that has been silent for longer than this is dead rather than
// recently dead, whatever counts as idle.
const RefDeadAfter = 7 * 24 * time.Hour

// Referrer statuses, by how long ago the last click came.
const (
	RefActive = "active"
	RefRecent = "recent" // silent for longer than the idle time, but not for RefDeadAfter
	RefDead   = "dead"
)

const (
	refSparkDays = 14
	refRowLimit  = 500
)

// RefActivityOpts says what counts as idle and which referrers to list.
type RefActivityOpts struct {
	Now    time.Time
	Idle   time.Duration
	Search string
	Status string
}

// RefRow is one referrer domain: when it sent its first and last click, and
// how much it sent.
type RefRow struct {
	Ref    string    `json:"ref"`
	First  time.Time `json:"first"`
	Last   time.Time `json:"last"`
	Status string    `json:"status"`
	// New: the first click came within the idle time.
	New     bool  `json:"new"`
	Clicks  int64 `json:"clicks"`
	Uniques int64 `json:"uniques"`
	Bots    int64 `json:"bots"`
	// Day is the clicks of the last 24 hours, Week those of the 7 days before
	// them: together they say whether a living referrer is fading.
	Day         int64   `json:"day"`
	Week        int64   `json:"week"`
	Days        int64   `json:"days"` // days with at least one click
	Conversions int64   `json:"conversions"`
	Revenue     float64 `json:"revenue"`
	// Spark is the clicks of each of the last 14 days, today last.
	Spark []int64 `json:"spark"`
	score float64
}

// RefActivity is the referrers of a selection. Counts is by status for every
// referrer that matches the search; Total is how many matched the status as
// well, of which Rows holds the first few hundred.
type RefActivity struct {
	Rows   []RefRow       `json:"rows"`
	Total  int            `json:"total"`
	Counts map[string]int `json:"counts"`
}

func refStatus(last, now time.Time, idle time.Duration) string {
	switch age := now.Sub(last); {
	case age < idle:
		return RefActive
	case age < RefDeadAfter:
		return RefRecent
	}
	return RefDead
}

func location(tz string) *time.Location {
	if loc, err := time.LoadLocation(strings.Trim(tzLiteral(tz), "'")); err == nil {
		return loc
	}
	return time.UTC
}

// ReferrerActivity lists the referrer domains of the selection with the age
// of their last click. Clicks without a referrer are not a referrer.
func (db *DB) ReferrerActivity(ctx context.Context, q Query, o RefActivityOpts) (*RefActivity, error) {
	dayAgo, weekAgo := o.Now.Add(-24*time.Hour), o.Now.Add(-8*24*time.Hour)
	w := q.clickWhere()
	w.add("ref_domain != ''")
	rows, err := db.query(ctx, "SELECT ref_domain AS k, min(ts) AS first, max(ts) AS last, count() AS clicks, sum(is_unique) AS uniques, sum(is_bot) AS bots,"+
		" countIf(ts >= ?) AS day, countIf(ts >= ? AND ts < ?) AS week, uniqExact(toDate(ts, "+tzLiteral(q.TZ)+")) AS days"+
		" FROM clicks WHERE "+w.sql()+" GROUP BY k", append([]any{dayAgo, weekAgo, dayAgo}, w.args...)...)
	if err != nil {
		return nil, err
	}
	out := &RefActivity{Rows: []RefRow{}, Counts: map[string]int{RefActive: 0, RefRecent: 0, RefDead: 0}}
	search := strings.TrimSpace(o.Search)
	for _, r := range rows {
		row := RefRow{Ref: fmt.Sprint(r["k"]), Clicks: int64(num(r["clicks"])), Uniques: int64(num(r["uniques"])), Bots: int64(num(r["bots"])),
			Day: int64(num(r["day"])), Week: int64(num(r["week"])), Days: int64(num(r["days"]))}
		row.First, _ = r["first"].(time.Time)
		row.Last, _ = r["last"].(time.Time)
		if search != "" {
			s, ok := fuzzyScore(row.Ref, search)
			if !ok {
				continue
			}
			row.score = s
		}
		row.Status = refStatus(row.Last, o.Now, o.Idle)
		row.New = o.Now.Sub(row.First) < o.Idle
		out.Counts[row.Status]++
		if o.Status == "" || o.Status == row.Status {
			out.Rows = append(out.Rows, row)
		}
	}
	out.Total = len(out.Rows)
	// The best match first; otherwise the freshest, so that among the dead
	// the ones that died last lead.
	sort.Slice(out.Rows, func(i, j int) bool {
		a, b := out.Rows[i], out.Rows[j]
		if a.score != b.score {
			return a.score > b.score
		}
		if !a.Last.Equal(b.Last) {
			return a.Last.After(b.Last)
		}
		return a.Ref < b.Ref
	})
	if len(out.Rows) > refRowLimit {
		out.Rows = out.Rows[:refRowLimit]
	}
	if len(out.Rows) == 0 {
		return out, nil
	}
	refs := make([]string, len(out.Rows))
	at := make(map[string]int, len(out.Rows))
	for i, r := range out.Rows {
		refs[i], at[r.Ref] = r.Ref, i
		out.Rows[i].Spark = make([]int64, refSparkDays)
	}

	cw := q.convWhere()
	cw.add("ref_domain IN (?)", refs)
	convs, err := db.query(ctx, "SELECT ref_domain AS k, sum(goal) AS conversions, sumIf(revenue, type != 'rejected') AS revenue FROM conversions WHERE "+cw.sql()+" GROUP BY k", cw.args...)
	if err != nil {
		return nil, err
	}
	for _, r := range convs {
		if i, ok := at[fmt.Sprint(r["k"])]; ok {
			out.Rows[i].Conversions, out.Rows[i].Revenue = int64(num(r["conversions"])), num(r["revenue"])
		}
	}

	// The last 14 days, by the viewer's calendar.
	loc := location(q.TZ)
	today := o.Now.In(loc)
	start := time.Date(today.Year(), today.Month(), today.Day()-(refSparkDays-1), 0, 0, 0, 0, loc)
	day := map[string]int{}
	for i := 0; i < refSparkDays; i++ {
		day[start.AddDate(0, 0, i).Format("2006-01-02")] = i
	}
	sq := q
	if sq.From.Before(start) {
		sq.From = start
	}
	sw := sq.clickWhere()
	sw.add("ref_domain IN (?)", refs)
	spark, err := db.query(ctx, "SELECT ref_domain AS k, toString(toDate(ts, "+tzLiteral(q.TZ)+")) AS d, count() AS n FROM clicks WHERE "+sw.sql()+" GROUP BY k, d", sw.args...)
	if err != nil {
		return nil, err
	}
	for _, r := range spark {
		i, ok := at[fmt.Sprint(r["k"])]
		d, inside := day[fmt.Sprint(r["d"])]
		if ok && inside {
			out.Rows[i].Spark[d] = int64(num(r["n"]))
		}
	}
	return out, nil
}

// RefProfile is the life of one referrer domain: when it sent clicks, by hour
// of the day and day of the week in the viewer's timezone, and the longest
// it has been silent between two clicks.
type RefProfile struct {
	Ref     string    `json:"ref"`
	First   time.Time `json:"first"`
	Last    time.Time `json:"last"`
	Clicks  int64     `json:"clicks"`
	Uniques int64     `json:"uniques"`
	Bots    int64     `json:"bots"`
	Days    int64     `json:"days"`
	Hours   [24]int64 `json:"hours"`
	// Weekdays starts on Monday.
	Weekdays [7]int64 `json:"weekdays"`
	// LongestGap is in seconds, measured in whole hours: two clicks in
	// neighbouring hours make no gap.
	LongestGap float64   `json:"longest_gap"`
	GapFrom    time.Time `json:"gap_from"`
	GapTo      time.Time `json:"gap_to"`
}

// ReferrerProfile describes one referrer domain in the selection; a profile
// with no clicks when it sent none there.
func (db *DB) ReferrerProfile(ctx context.Context, ref string, q Query) (*RefProfile, error) {
	w := q.clickWhere()
	w.add("ref_domain = ?", ref)
	tz := tzLiteral(q.TZ)
	sum, err := db.query(ctx, "SELECT min(ts) AS first, max(ts) AS last, count() AS clicks, sum(is_unique) AS uniques, sum(is_bot) AS bots, uniqExact(toDate(ts, "+tz+")) AS days FROM clicks WHERE "+w.sql(), w.args...)
	if err != nil {
		return nil, err
	}
	if len(sum) == 0 || num(sum[0]["clicks"]) == 0 {
		return &RefProfile{Ref: ref}, nil
	}
	p := &RefProfile{Ref: ref, Clicks: int64(num(sum[0]["clicks"])), Uniques: int64(num(sum[0]["uniques"])), Bots: int64(num(sum[0]["bots"])), Days: int64(num(sum[0]["days"]))}
	p.First, _ = sum[0]["first"].(time.Time)
	p.Last, _ = sum[0]["last"].(time.Time)

	hours, err := db.query(ctx, "SELECT toStartOfHour(ts) AS h, count() AS n FROM clicks WHERE "+w.sql()+" GROUP BY h ORDER BY h", w.args...)
	if err != nil {
		return nil, err
	}
	loc := location(q.TZ)
	var prev time.Time
	for _, r := range hours {
		h, _ := r["h"].(time.Time)
		n := int64(num(r["n"]))
		local := h.In(loc)
		p.Hours[local.Hour()] += n
		p.Weekdays[(int(local.Weekday())+6)%7] += n
		if !prev.IsZero() {
			if gap := h.Sub(prev) - time.Hour; gap.Seconds() > p.LongestGap {
				p.LongestGap, p.GapFrom, p.GapTo = gap.Seconds(), prev.Add(time.Hour), h
			}
		}
		prev = h
	}
	return p, nil
}

// fuzzyScore says whether text matches what was typed, and how well: every
// word must occur in it, or its letters in order ("fbk" → facebook.com), or,
// for a longer word, something close enough to forgive a typo.
func fuzzyScore(text, query string) (float64, bool) {
	text = strings.ToLower(text)
	total := 0.0
	for _, word := range strings.Fields(strings.ToLower(query)) {
		s, ok := wordScore(text, word)
		if !ok {
			return 0, false
		}
		total += s
	}
	return total, true
}

func wordScore(text, word string) (float64, bool) {
	if i := strings.Index(text, word); i >= 0 {
		s := 100 - float64(len(text)-len(word))*0.1
		// At the start of the name or of one of its labels.
		if i == 0 || text[i-1] == '.' || text[i-1] == '-' {
			s += 20
		}
		return s, true
	}
	// Letters in order, fewer skipped letters scoring higher.
	j, skipped := 0, 0
	for i := 0; i < len(text) && j < len(word); i++ {
		if text[i] == word[j] {
			j++
		} else if j > 0 {
			skipped++
		}
	}
	if j == len(word) && len(word) >= 2 {
		return 60 - float64(skipped), true
	}
	if len([]rune(word)) >= 4 {
		if d := dice(text, word); d >= 0.5 {
			return 40 * d, true
		}
	}
	return 0, false
}

// dice is the share of letter pairs two strings have in common.
func dice(a, b string) float64 {
	pairs := func(s string) map[string]int {
		r := []rune(s)
		m := map[string]int{}
		for i := 0; i+1 < len(r); i++ {
			m[string(r[i:i+2])]++
		}
		return m
	}
	pb := pairs(b)
	nb := 0
	for _, n := range pb {
		nb += n
	}
	// Against the best window of the text, so a long domain is not punished for its length.
	ra := []rune(a)
	size := len([]rune(b)) + 1
	best := 0.0
	for start := 0; start == 0 || start+size <= len(ra); start++ {
		end := min(start+size, len(ra))
		pa := pairs(string(ra[start:end]))
		common, na := 0, 0
		for k, n := range pa {
			na += n
			common += min(n, pb[k])
		}
		if na+nb > 0 {
			best = max(best, 2*float64(common)/float64(na+nb))
		}
		if end == len(ra) {
			break
		}
	}
	return best
}
