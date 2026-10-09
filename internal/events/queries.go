package events

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Query is the common filter set for reports and logs.
type Query struct {
	From, To   time.Time
	TZ         string
	CampaignID uint32
	StreamID   uint32
	KeyID      uint32
	Country    string
	Domain     string
	Type       string
	Outcome    string // with Type: events of the stage that ended this way
	IP         string
	ClickID    string
	Bots       string            // "" | only | exclude
	// Reached and NotReached narrow the click log to clicks that have, or do
	// not have, an event of that type (a funnel stage). Reached may name an
	// outcome of the stage as well: "stage:outcome".
	Reached, NotReached string
	// Status and Search belong to the postback log: the outcome, and a piece
	// of text to look for in the parameters or the refusal reason.
	Status, Search string
	Params     map[string]string // conversion postback params, exact match
	// Dims narrows to exact values of report dimensions ("os" → "Android"),
	// which is what drilling into a report row does.
	Dims map[string]string
	// Scoped limits results to Campaigns (and, for conversions, to events
	// received through Keys). Unset means unrestricted.
	Scoped    bool
	Campaigns []uint32
	Keys      []uint32
	Limit     int
	Offset    int
}

type dim struct {
	expr          string // %s is replaced by the quoted timezone
	clicks, convs bool
	timeline      bool
}

// filterable reports whether rows can be narrowed to one value of the
// dimension (drill-down): true for dimensions that are a plain column.
func (d dim) filterable() bool { return !d.timeline && !strings.ContainsAny(d.expr, "('") }

var dims = map[string]dim{
	"total":       {"'total'", true, true, false},
	"day":         {"toString(toDate(ts, %s))", true, true, true},
	"hour":        {"formatDateTime(ts, '%%Y-%%m-%%d %%H:00', %s)", true, true, true},
	"campaign":    {"toString(campaign_id)", true, true, false},
	"stream":      {"toString(stream_id)", true, true, false},
	"domain":      {"domain", true, true, false},
	"country":     {"country", true, true, false},
	"region":      {"region", true, true, false},
	"city":        {"city", true, true, false},
	"isp":         {"isp", true, true, false},
	"device_type": {"device_type", true, true, false},
	"os":          {"os", true, true, false},
	"browser":     {"browser", true, true, false},
	"lang":        {"lang", true, true, false},
	"ref_domain":  {"ref_domain", true, true, false},
	"keyword":     {"keyword", true, true, false},
	"sub1":        {"sub1", true, true, false},
	"sub2":        {"sub2", true, true, false},
	"sub3":        {"sub3", true, true, false},
	"sub4":        {"sub4", true, true, false},
	"sub5":        {"sub5", true, true, false},
	"action":      {"action", true, false, false},
	"bot_reason":  {"bot_reason", true, false, false},
	"key":         {"toString(key_id)", false, true, false},
	"type":        {"type", false, true, false},
}

// FilterableDimensions lists the dimensions that accept an f.<name> filter.
func FilterableDimensions() []string {
	out := []string{}
	for k, d := range dims {
		if d.filterable() {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// Dimensions lists the report groupings, for the panel.
func Dimensions() []string {
	out := make([]string, 0, len(dims))
	for k := range dims {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

var tzRe = regexp.MustCompile(`^[A-Za-z0-9_+\-/]{1,64}$`)

func tzLiteral(tz string) string {
	if tz == "" || !tzRe.MatchString(tz) {
		return "'UTC'"
	}
	if _, err := time.LoadLocation(tz); err != nil {
		return "'UTC'"
	}
	return "'" + tz + "'"
}

type where struct {
	parts []string
	args  []any
}

func (w *where) add(cond string, args ...any) {
	w.parts = append(w.parts, cond)
	w.args = append(w.args, args...)
}

func (w *where) sql() string {
	if len(w.parts) == 0 {
		return "1"
	}
	return strings.Join(w.parts, " AND ")
}

func (q *Query) base() *where { return q.baseAt("ts") }

// baseAt is base with the period applied to another time column.
func (q *Query) baseAt(ts string) *where {
	w := &where{}
	if !q.From.IsZero() {
		w.add(ts+" >= ?", q.From)
	}
	if !q.To.IsZero() {
		w.add(ts+" < ?", q.To)
	}
	if q.CampaignID != 0 {
		w.add("campaign_id = ?", q.CampaignID)
	}
	if q.StreamID != 0 {
		w.add("stream_id = ?", q.StreamID)
	}
	if q.Country != "" {
		w.add("country = ?", q.Country)
	}
	if q.Domain != "" {
		w.add("domain = ?", q.Domain)
	}
	if q.ClickID != "" {
		w.add("click_id = ?", q.ClickID)
	}
	return w
}

// idList renders ids for an IN (...) clause; an empty list matches nothing.
func idList(ids []uint32) string {
	if len(ids) == 0 {
		return "NULL"
	}
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.FormatUint(uint64(id), 10)
	}
	return strings.Join(parts, ",")
}

// drill applies the dimension filters. A dimension the table does not have
// cannot match anything there: filtering clicks by conversion type must not
// leave the click totals unfiltered next to it.
func (q *Query) drill(w *where, clicks bool) {
	for name, val := range q.Dims {
		d, ok := dims[name]
		if !ok || !d.filterable() {
			continue
		}
		if (clicks && !d.clicks) || (!clicks && !d.convs) {
			w.add("0")
			continue
		}
		w.add(d.expr+" = ?", val)
	}
}

func (q *Query) clickWhere() *where {
	w := q.base()
	q.drill(w, true)
	if q.Scoped {
		w.add("campaign_id IN (" + idList(q.Campaigns) + ")")
	}
	switch q.Bots {
	case "only":
		w.add("is_bot = 1")
	case "exclude":
		w.add("is_bot = 0")
	}
	if q.IP != "" {
		w.add("ip = ?", q.IP)
	}
	return w
}

func (q *Query) convWhere() *where { return q.convWhereAt("ts") }

func (q *Query) convWhereAt(ts string) *where {
	w := q.baseAt(ts)
	q.drill(w, false)
	if q.Scoped {
		w.add("(campaign_id IN (" + idList(q.Campaigns) + ") OR key_id IN (" + idList(q.Keys) + "))")
	}
	switch q.Bots {
	case "only":
		w.add("is_bot = 1")
	case "exclude":
		w.add("is_bot = 0")
	}
	if q.KeyID != 0 {
		w.add("key_id = ?", q.KeyID)
	}
	if q.Type != "" {
		w.add("type = ?", q.Type)
	}
	if q.Outcome != "" {
		w.add("outcome = ?", q.Outcome)
	}
	if q.IP != "" {
		w.add("sender_ip = ?", q.IP)
	}
	for k, v := range q.Params {
		w.add("JSONExtractString(params, ?) = ?", k, v)
	}
	return w
}

func num(v any) float64 {
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return float64(rv.Int())
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return float64(rv.Uint())
	case reflect.Float32, reflect.Float64:
		return rv.Float()
	}
	return 0
}

type ReportRow struct {
	Key         string           `json:"key"`
	Clicks      int64            `json:"clicks"`
	Uniques     int64            `json:"uniques"`
	Bots        int64            `json:"bots"`
	Conversions int64            `json:"conversions"`
	Rejected    int64            `json:"rejected"`
	Revenue     float64          `json:"revenue"`
	Cost        float64          `json:"cost"`
	Profit      float64          `json:"profit"`
	CR          float64          `json:"cr"`  // conversions / real clicks, %
	ROI         float64          `json:"roi"` // %
	EPC         float64          `json:"epc"`
	Types       map[string]int64 `json:"types"` // events by conversion type, funnel stages included
}

// Report aggregates clicks and conversions by one dimension.
func (db *DB) Report(ctx context.Context, group string, q Query) ([]ReportRow, error) {
	d, ok := dims[group]
	if !ok {
		return nil, fmt.Errorf("unknown grouping %q", group)
	}
	expr := d.expr
	if strings.Contains(expr, "%s") {
		expr = fmt.Sprintf(expr, tzLiteral(q.TZ))
	}
	byKey := map[string]*ReportRow{}
	get := func(k string) *ReportRow {
		r := byKey[k]
		if r == nil {
			r = &ReportRow{Key: k, Types: map[string]int64{}}
			byKey[k] = r
		}
		return r
	}
	if d.clicks {
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
	}
	if d.convs {
		w := q.convWhere()
		// Only goal events are conversions: the other stages of a funnel are
		// steps towards one, though any of them may bring revenue.
		rows, err := db.query(ctx, "SELECT "+expr+" AS k, toString(type) AS t, count() AS n, sum(goal) AS conversions, sumIf(revenue, type != 'rejected') AS revenue, sum(cost) AS cost FROM conversions WHERE "+w.sql()+" GROUP BY k, t", w.args...)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			row := get(fmt.Sprint(r["k"]))
			t, n := fmt.Sprint(r["t"]), int64(num(r["n"]))
			if t == "rejected" {
				row.Rejected += n
			} else {
				row.Types[t] += n
			}
			row.Conversions += int64(num(r["conversions"]))
			row.Revenue += num(r["revenue"])
			row.Cost += num(r["cost"])
		}
	}
	out := make([]ReportRow, 0, len(byKey))
	for _, r := range byKey {
		r.Profit = r.Revenue - r.Cost
		if real := r.Clicks - r.Bots; real > 0 {
			r.CR = float64(r.Conversions) / float64(real) * 100
			r.EPC = r.Revenue / float64(real)
		}
		if r.Cost > 0 {
			r.ROI = r.Profit / r.Cost * 100
		}
		out = append(out, *r)
	}
	if d.timeline {
		sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	} else {
		sort.Slice(out, func(i, j int) bool {
			if out[i].Clicks != out[j].Clicks {
				return out[i].Clicks > out[j].Clicks
			}
			return out[i].Conversions > out[j].Conversions
		})
	}
	return out, nil
}

// ReferrerRow is a report row for one referring site (or, in the page list,
// one referring URL) with its clicks split by device class.
type ReferrerRow struct {
	ReportRow
	Mobile  int64 `json:"mobile"` // phones and tablets
	Desktop int64 `json:"desktop"`
}

const deviceSplit = "countIf(device_type IN ('mobile', 'tablet')) AS mobile, countIf(device_type = 'desktop') AS desktop"

// Referrers is the report by referrer domain plus the device split. Clicks
// that came without a referrer are the row with an empty key.
func (db *DB) Referrers(ctx context.Context, q Query) ([]ReferrerRow, error) {
	rows, err := db.Report(ctx, "ref_domain", q)
	if err != nil {
		return nil, err
	}
	w := q.clickWhere()
	split, err := db.query(ctx, "SELECT ref_domain AS k, "+deviceSplit+" FROM clicks WHERE "+w.sql()+" GROUP BY k", w.args...)
	if err != nil {
		return nil, err
	}
	byKey := make(map[string]Row, len(split))
	for _, r := range split {
		byKey[fmt.Sprint(r["k"])] = r
	}
	out := make([]ReferrerRow, len(rows))
	for i, r := range rows {
		out[i] = ReferrerRow{ReportRow: r}
		if s := byKey[r.Key]; s != nil {
			out[i].Mobile, out[i].Desktop = int64(num(s["mobile"])), int64(num(s["desktop"]))
		}
	}
	return out, nil
}

const referrerURLLimit = 50

// ReferrerURLs lists the referring pages that sent the most clicks. Only
// clicks keep the full referrer, so the rows carry no conversions.
func (db *DB) ReferrerURLs(ctx context.Context, q Query) ([]ReferrerRow, error) {
	w := q.clickWhere()
	rows, err := db.query(ctx, fmt.Sprintf("SELECT referer AS k, count() AS clicks, sum(is_unique) AS uniques, sum(is_bot) AS bots, %s FROM clicks WHERE %s GROUP BY k ORDER BY clicks DESC, k LIMIT %d",
		deviceSplit, w.sql(), referrerURLLimit), w.args...)
	if err != nil {
		return nil, err
	}
	out := make([]ReferrerRow, len(rows))
	for i, r := range rows {
		out[i] = ReferrerRow{
			ReportRow: ReportRow{Key: fmt.Sprint(r["k"]), Clicks: int64(num(r["clicks"])), Uniques: int64(num(r["uniques"])), Bots: int64(num(r["bots"]))},
			Mobile:    int64(num(r["mobile"])), Desktop: int64(num(r["desktop"])),
		}
	}
	return out, nil
}

const clickCols = `ts, click_id, campaign_id, stream_id, domain, ip, country, region, city, asn, isp, device_type, os, os_version,
 browser, browser_version, ua, lang, referer, ref_domain, is_bot, bot_reason, is_dc, is_unique, action, integration,
 sub1, sub2, sub3, sub4, sub5, keyword, params, ja3, ja4, cost`

func (q *Query) page() (int, int) {
	limit := q.Limit
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	if q.Offset < 0 {
		q.Offset = 0
	}
	return limit, q.Offset
}

// stageClicks selects the ids of clicks that have an event of one type. An
// event cannot predate its click, so conversions are read from the start of
// the period onwards.
func (q *Query) stageClicks(w *where, not bool, typ string) {
	sub := &where{}
	typ, outcome, _ := strings.Cut(typ, ":")
	sub.add("type = ?", typ)
	if outcome != "" {
		sub.add("outcome = ?", outcome)
	}
	sub.add("click_id != ''")
	if !q.From.IsZero() {
		sub.add("ts >= ?", q.From)
	}
	if q.CampaignID != 0 {
		sub.add("campaign_id = ?", q.CampaignID)
	}
	op := "IN"
	if not {
		op = "NOT IN"
	}
	w.add("click_id "+op+" (SELECT click_id FROM conversions WHERE "+sub.sql()+")", sub.args...)
}

// Clicks returns the raw click log, newest first. Every row carries the
// events received for that click so far, oldest first.
func (db *DB) Clicks(ctx context.Context, q Query) ([]Row, uint64, error) {
	w := q.clickWhere()
	if q.Reached != "" {
		q.stageClicks(w, false, q.Reached)
	}
	if q.NotReached != "" {
		q.stageClicks(w, true, q.NotReached)
	}
	limit, offset := q.page()
	rows, err := db.query(ctx, fmt.Sprintf("SELECT %s FROM clicks WHERE %s ORDER BY ts DESC LIMIT %d OFFSET %d", clickCols, w.sql(), limit, offset), w.args...)
	if err != nil {
		return nil, 0, err
	}
	var total uint64
	if err := db.conn.QueryRow(ctx, "SELECT count() FROM clicks WHERE "+w.sql(), w.args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	if err := db.attachEvents(ctx, rows); err != nil {
		return nil, 0, err
	}
	return rows, total, nil
}

// attachEvents puts under "events" what each click of a log page went on to
// do: one short entry per event, in the order they arrived.
func (db *DB) attachEvents(ctx context.Context, clicks []Row) error {
	if len(clicks) == 0 {
		return nil
	}
	ids := make([]string, 0, len(clicks))
	var first time.Time
	for _, c := range clicks {
		c["events"] = []Row{}
		if id, _ := c["click_id"].(string); id != "" {
			ids = append(ids, id)
		}
		if ts, ok := c["ts"].(time.Time); ok && (first.IsZero() || ts.Before(first)) {
			first = ts
		}
	}
	if len(ids) == 0 {
		return nil
	}
	evs, err := db.query(ctx, "SELECT click_id, ts, toString(type) AS type, toString(outcome) AS outcome, revenue, goal FROM conversions WHERE ts >= ? AND click_id IN (?) ORDER BY ts",
		first.Add(-time.Minute), ids)
	if err != nil {
		return err
	}
	byClick := map[string][]Row{}
	for _, e := range evs {
		id, _ := e["click_id"].(string)
		delete(e, "click_id")
		byClick[id] = append(byClick[id], e)
	}
	for _, c := range clicks {
		if id, _ := c["click_id"].(string); byClick[id] != nil {
			c["events"] = byClick[id]
		}
	}
	return nil
}

const convCols = `ts, conv_id, click_id, key_id, type, revenue, cost, currency, sender_ip, params, campaign_id, stream_id,
 domain, country, city, device_type, os, browser, sub1, sub2, sub3, sub4, sub5, goal, is_bot, click_ts, outcome`

func decodeParams(rows []Row) {
	for _, r := range rows {
		m := map[string]string{}
		if s, _ := r["params"].(string); s != "" {
			json.Unmarshal([]byte(s), &m)
		}
		r["params"] = m
	}
}

// paramKeys returns every postback parameter name seen in the selection, so
// the panel can render them as table columns.
func (db *DB) paramKeys(ctx context.Context, w *where) ([]string, error) {
	var keys []string
	err := db.conn.QueryRow(ctx, "SELECT arraySort(groupUniqArrayArray(JSONExtractKeys(params))) FROM conversions WHERE "+w.sql(), w.args...).Scan(&keys)
	if keys == nil {
		keys = []string{}
	}
	return keys, err
}

// Conversions returns the conversion log plus the union of postback params.
func (db *DB) Conversions(ctx context.Context, q Query) (rows []Row, keys []string, total uint64, err error) {
	w := q.convWhere()
	limit, offset := q.page()
	rows, err = db.query(ctx, fmt.Sprintf("SELECT %s FROM conversions WHERE %s ORDER BY ts DESC LIMIT %d OFFSET %d", convCols, w.sql(), limit, offset), w.args...)
	if err != nil {
		return
	}
	decodeParams(rows)
	if keys, err = db.paramKeys(ctx, w); err != nil {
		return
	}
	err = db.conn.QueryRow(ctx, "SELECT count() FROM conversions WHERE "+w.sql(), w.args...).Scan(&total)
	return
}

// Postbacks returns the postback log, newest first. Unlike conversions it is
// scoped by key alone: a row shows the request as its sender made it, which
// is for the key's owner to see, not for everyone the campaign is shared with.
func (db *DB) Postbacks(ctx context.Context, q Query) ([]Row, uint64, error) {
	w := &where{}
	if !q.From.IsZero() {
		w.add("ts >= ?", q.From)
	}
	if !q.To.IsZero() {
		w.add("ts < ?", q.To)
	}
	if q.Scoped {
		w.add("key_id IN (" + idList(q.Keys) + ")")
	}
	if q.KeyID != 0 {
		w.add("key_id = ?", q.KeyID)
	}
	if q.CampaignID != 0 {
		w.add("campaign_id = ?", q.CampaignID)
	}
	if q.Status != "" {
		w.add("status = ?", q.Status)
	}
	if q.Type != "" {
		w.add("type = ?", q.Type)
	}
	if q.IP != "" {
		w.add("sender_ip = ?", q.IP)
	}
	if q.ClickID != "" {
		w.add("click_id = ?", q.ClickID)
	}
	if q.Search != "" {
		w.add("(positionCaseInsensitive(query, ?) > 0 OR positionCaseInsensitive(reason, ?) > 0)", q.Search, q.Search)
	}
	limit, offset := q.page()
	rows, err := db.query(ctx, fmt.Sprintf(`SELECT ts, toString(status) AS status, http_status, reason, key_id, key_prefix, sender_ip, type,
		click_id, conv_id, campaign_id, stream_id, revenue, query FROM postbacks WHERE %s ORDER BY ts DESC LIMIT %d OFFSET %d`, w.sql(), limit, offset), w.args...)
	if err != nil {
		return nil, 0, err
	}
	var total uint64
	err = db.conn.QueryRow(ctx, "SELECT count() FROM postbacks WHERE "+w.sql(), w.args...).Scan(&total)
	return rows, total, err
}

const csvMaxRows = 1_000_000

// ConversionsCSV streams the selection as CSV with one column per postback param.
// keyNames maps key ids to their display names.
func (db *DB) ConversionsCSV(ctx context.Context, out io.Writer, q Query, keyNames map[uint32]string) error {
	w := q.convWhere()
	keys, err := db.paramKeys(ctx, w)
	if err != nil {
		return err
	}
	rows, err := db.conn.Query(ctx, fmt.Sprintf(`SELECT ts, conv_id, click_id, key_id, type, revenue, cost, currency, sender_ip,
		campaign_id, stream_id, domain, country, city, device_type, os, browser, sub1, sub2, sub3, sub4, sub5, outcome, params
		FROM conversions WHERE %s ORDER BY ts DESC LIMIT %d`, w.sql(), csvMaxRows), w.args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	cw := csv.NewWriter(out)
	head := []string{"time", "conversion_id", "click_id", "key", "type", "revenue", "cost", "currency", "sender_ip",
		"campaign_id", "stream_id", "domain", "country", "city", "device_type", "os", "browser", "sub1", "sub2", "sub3", "sub4", "sub5", "outcome"}
	fixed := map[string]bool{}
	for _, h := range head {
		fixed[h] = true
	}
	for _, k := range keys {
		if fixed[k] {
			k = "param_" + k // keep header names unique
		}
		head = append(head, k)
	}
	cw.Write(head)
	for rows.Next() {
		var (
			ts                              time.Time
			convID, clickID, typ, cur, sip  string
			keyID, campID, streamID         uint32
			rev, cost                       float64
			domain, country, city, dev, osn string
			browser, s1, s2, s3, s4, s5, pj string
			outcome                         string
		)
		if err := rows.Scan(&ts, &convID, &clickID, &keyID, &typ, &rev, &cost, &cur, &sip, &campID, &streamID,
			&domain, &country, &city, &dev, &osn, &browser, &s1, &s2, &s3, &s4, &s5, &outcome, &pj); err != nil {
			return err
		}
		keyName := keyNames[keyID]
		if keyName == "" {
			keyName = strconv.FormatUint(uint64(keyID), 10)
		}
		rec := []string{ts.UTC().Format(time.RFC3339), convID, clickID, csvSafe(keyName), typ,
			strconv.FormatFloat(rev, 'f', -1, 64), strconv.FormatFloat(cost, 'f', -1, 64), csvSafe(cur), sip,
			strconv.FormatUint(uint64(campID), 10), strconv.FormatUint(uint64(streamID), 10),
			domain, country, csvSafe(city), dev, osn, browser, csvSafe(s1), csvSafe(s2), csvSafe(s3), csvSafe(s4), csvSafe(s5), outcome}
		params := map[string]string{}
		json.Unmarshal([]byte(pj), &params)
		for _, k := range keys {
			rec = append(rec, csvSafe(params[k]))
		}
		if err := cw.Write(rec); err != nil {
			return err
		}
	}
	cw.Flush()
	return rows.Err()
}

// csvSafe neutralises spreadsheet formula injection from visitor and postback data.
func csvSafe(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}

func scanClick(rows interface {
	Next() bool
	Scan(...any) error
}) (*Click, error) {
	if !rows.Next() {
		return nil, nil
	}
	c := &Click{}
	var bot uint8
	defer func() { c.IsBot = bot == 1 }()
	err := rows.Scan(&c.TS, &c.ClickID, &c.CampaignID, &c.StreamID, &c.Domain, &c.IP, &c.Country, &c.Region, &c.City, &c.ISP,
		&c.DeviceType, &c.OS, &c.Browser, &c.Lang, &c.RefDomain, &c.Keyword, &c.Sub[0], &c.Sub[1], &c.Sub[2], &c.Sub[3], &c.Sub[4], &bot)
	return c, err
}

const lookupCols = `ts, click_id, campaign_id, stream_id, domain, ip, country, region, city, isp, device_type, os, browser,
 lang, ref_domain, keyword, sub1, sub2, sub3, sub4, sub5, is_bot`

// ClickByID finds a click. The id carries its campaign and timestamp, so the
// lookup is a narrow primary-key range rather than a scan.
func (db *DB) ClickByID(ctx context.Context, id string, campaignID uint32, at time.Time) (*Click, error) {
	rows, err := db.conn.Query(ctx, "SELECT "+lookupCols+" FROM clicks WHERE campaign_id = ? AND ts >= ? AND ts < ? AND click_id = ? LIMIT 1",
		campaignID, at.Add(-2*time.Second), at.Add(2*time.Second), id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanClick(rows)
}

// LastClickByIP finds the most recent human click from ip since the given
// time, among the given campaigns.
func (db *DB) LastClickByIP(ctx context.Context, ip string, since time.Time, campaigns []uint32) (*Click, error) {
	rows, err := db.conn.Query(ctx, "SELECT "+lookupCols+" FROM clicks WHERE campaign_id IN ("+idList(campaigns)+") AND ip = ? AND ts >= ? AND is_bot = 0 ORDER BY ts DESC LIMIT 1", ip, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanClick(rows)
}

// ConversionExists reports whether a click already has a conversion of this
// type and outcome. A conversion cannot predate its click, so the table, which is ordered
// by time, is only read from the click onwards.
func (db *DB) ConversionExists(ctx context.Context, clickID, typ, outcome string, clickAt time.Time) (bool, error) {
	var n uint64
	err := db.conn.QueryRow(ctx, "SELECT count() FROM conversions WHERE ts >= ? AND click_id = ? AND type = ? AND outcome = ?",
		clickAt.Add(-time.Minute), clickID, typ, outcome).Scan(&n)
	return n > 0, err
}
