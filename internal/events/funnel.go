package events

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// FunnelStep is one stage of a funnel row.
type FunnelStep struct {
	Reached int64   `json:"reached"` // clicks that got this far
	Events  int64   `json:"events"`  // events received, repeats included
	Revenue float64 `json:"revenue"`
}

type FunnelRow struct {
	Key     string       `json:"key"`
	Clicks  int64        `json:"clicks"`
	Uniques int64        `json:"uniques"`
	Bots    int64        `json:"bots"`
	Cost    float64      `json:"cost"`
	Steps   []FunnelStep `json:"steps"` // one per stage, in funnel order
}

var stageKeyRe = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)

// ValidStageKey reports whether s can be a stage key (and so a conversion type).
func ValidStageKey(s string) bool { return stageKeyRe.MatchString(s) }

var tsRe = regexp.MustCompile(`\bts\b`)

const (
	// How long after its first stage a click may still complete the funnel
	// when the order of stages is enforced.
	funnelWindowMs = 180 * 24 * 3600 * 1000
	// Events are placed at the time of their click, so a period selects a
	// cohort of clicks and follows each of them to the end of the funnel.
	// Rows written before click_ts existed fall back to their own time.
	cohortTS = "if(toUnixTimestamp64Milli(click_ts) = 0, ts, click_ts)"
)

// Funnel reports how many clicks reached each of the given stages, grouped by
// one dimension. The period selects clicks, not events: a purchase made a week
// after the click belongs to the day of the click.
//
// A click has reached a stage once any event of that stage arrived for it.
// With strict set it must also have passed every earlier stage, in order.
func (db *DB) Funnel(ctx context.Context, group string, stages []string, strict bool, q Query) ([]FunnelRow, error) {
	d, ok := dims[group]
	if !ok || !d.clicks || !d.convs {
		return nil, fmt.Errorf("unknown grouping %q", group)
	}
	if len(stages) == 0 {
		return nil, fmt.Errorf("the campaign has no stages")
	}
	for _, s := range stages {
		if !ValidStageKey(s) {
			return nil, fmt.Errorf("bad stage key %q", s)
		}
	}
	expr := d.expr
	if strings.Contains(expr, "%s") {
		expr = fmt.Sprintf(expr, tzLiteral(q.TZ))
	}
	byKey := map[string]*FunnelRow{}
	get := func(k string) *FunnelRow {
		r := byKey[k]
		if r == nil {
			r = &FunnelRow{Key: k, Steps: make([]FunnelStep, len(stages))}
			byKey[k] = r
		}
		return r
	}

	w := q.clickWhere()
	rows, err := db.query(ctx, "SELECT "+expr+" AS k, count() AS clicks, sum(is_unique) AS uniques, sum(is_bot) AS bots, sum(cost) AS cost FROM clicks WHERE "+w.sql()+" GROUP BY k", w.args...)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		row := get(fmt.Sprint(r["k"]))
		row.Clicks, row.Uniques, row.Bots = int64(num(r["clicks"])), int64(num(r["uniques"])), int64(num(r["bots"]))
		row.Cost = num(r["cost"])
	}

	// Inner query: one row per click with the stages it reached. Outer: the
	// clicks of each group added up.
	var conds, inner, outer []string
	for i, s := range stages {
		cond := "type = '" + s + "'"
		conds = append(conds, cond)
		reached := "max(" + cond + ")"
		if strict {
			reached = fmt.Sprintf("lvl >= %d", i+1)
		}
		inner = append(inner, fmt.Sprintf("%s AS s%d, countIf(%s) AS e%d, sumIf(revenue, %s) AS r%d", reached, i, cond, i, cond, i))
		outer = append(outer, fmt.Sprintf("sum(s%d) AS s%d, sum(e%d) AS e%d, sum(r%d) AS r%d", i, i, i, i, i, i))
	}
	lvl := ""
	if strict {
		lvl = fmt.Sprintf("windowFunnel(%d)(toUInt64(toUnixTimestamp64Milli(ts)), %s) AS lvl, ", funnelWindowMs, strings.Join(conds, ", "))
	}
	cw := q.convWhereAt("cts")
	cw.add("click_id != ''")
	sql := "SELECT k, sum(c) AS cost, " + strings.Join(outer, ", ") + " FROM (" +
		"SELECT " + tsRe.ReplaceAllString(expr, "cts") + " AS k, sum(cost) AS c, " + lvl + strings.Join(inner, ", ") +
		" FROM (SELECT *, " + cohortTS + " AS cts FROM conversions) WHERE " + cw.sql() +
		" GROUP BY click_id, k) GROUP BY k"
	rows, err = db.query(ctx, sql, cw.args...)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		row := get(fmt.Sprint(r["k"]))
		row.Cost += num(r["cost"])
		for i := range stages {
			n := strconv.Itoa(i)
			row.Steps[i] = FunnelStep{Reached: int64(num(r["s"+n])), Events: int64(num(r["e"+n])), Revenue: num(r["r"+n])}
		}
	}

	out := make([]FunnelRow, 0, len(byKey))
	for _, r := range byKey {
		out = append(out, *r)
	}
	if d.timeline {
		sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	} else {
		sort.Slice(out, func(i, j int) bool {
			if out[i].Clicks != out[j].Clicks {
				return out[i].Clicks > out[j].Clicks
			}
			return out[i].Key < out[j].Key
		})
	}
	return out, nil
}
