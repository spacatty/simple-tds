// Package events stores clicks and conversions in ClickHouse. Writes are
// batched off the request path; reads back the panel's reports.
package events

import (
	"context"
	"fmt"
	"log/slog"
	"net/netip"
	"reflect"
	"strings"
	"sync/atomic"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

type Click struct {
	TS             time.Time
	ClickID        string
	CampaignID     uint32
	StreamID       uint32
	Domain         string
	IP             string
	Country        string
	Region         string
	City           string
	ASN            uint32
	ISP            string
	DeviceType     string
	OS             string
	OSVersion      string
	Browser        string
	BrowserVersion string
	UA             string
	Lang           string
	Referer        string
	RefDomain      string
	IsBot          bool
	BotReason      string
	IsDC           bool
	IsUnique       bool
	Action         string
	Integration    string
	Sub            [5]string
	Keyword        string
	Params         string
	JA3            string
	JA4            string
	Cost           float64
}

type Conversion struct {
	TS         time.Time
	ConvID     string
	ClickID    string
	KeyID      uint32
	Type       string
	Revenue    float64
	Cost       float64
	Currency   string
	SenderIP   string
	Params     string
	CampaignID uint32
	StreamID   uint32
	// Goal: the event counts as a conversion. Other funnel stages are steps
	// on the way to one.
	Goal bool
	// ClickTS is when the attributed click happened; zero when there is none.
	ClickTS time.Time
	// Denormalised from the click so reports need no join.
	Domain, Country, Region, City, ISP, DeviceType, OS, Browser, Lang, RefDomain, Keyword string
	IsBot                                                                                 bool // the attributed click was flagged as a bot
	Sub                                                                                   [5]string
}

// Postback outcomes, as stored in the postback log.
const (
	PostbackOK        = "ok"
	PostbackDuplicate = "duplicate"
	PostbackRejected  = "rejected"
	PostbackFailed    = "failed" // accepted, but the conversion could not be stored
)

// Postback is one request to the postback URL and what became of it.
type Postback struct {
	TS         time.Time
	Status     string
	HTTPStatus uint16
	Reason     string // why it was refused
	KeyID      uint32 // 0 when the key is unknown
	KeyPrefix  string // first characters of the key that was sent
	SenderIP   string
	Type       string
	ClickID    string // as sent, attributed or not
	ConvID     string // the conversion it produced
	CampaignID uint32
	StreamID   uint32
	Revenue    float64
	Query      string
}

// FromClick copies what reports group by from the attributed click.
func (c *Conversion) FromClick(click *Click) {
	if click == nil {
		return
	}
	c.ClickTS = click.TS
	c.Domain, c.Country, c.Region, c.City, c.ISP = click.Domain, click.Country, click.Region, click.City, click.ISP
	c.DeviceType, c.OS, c.Browser, c.Lang = click.DeviceType, click.OS, click.Browser, click.Lang
	c.RefDomain, c.Keyword, c.Sub, c.IsBot = click.RefDomain, click.Keyword, click.Sub, click.IsBot
}

const ddlClicks = `CREATE TABLE IF NOT EXISTS clicks (
 ts DateTime64(3,'UTC'), click_id String, campaign_id UInt32, stream_id UInt32, domain LowCardinality(String),
 ip String, country LowCardinality(String), region String, city String, asn UInt32, isp String,
 device_type LowCardinality(String), os LowCardinality(String), os_version String,
 browser LowCardinality(String), browser_version String, ua String, lang LowCardinality(String),
 referer String, ref_domain String, is_bot UInt8, bot_reason LowCardinality(String), is_dc UInt8, is_unique UInt8,
 action LowCardinality(String), integration LowCardinality(String),
 sub1 String, sub2 String, sub3 String, sub4 String, sub5 String, keyword String,
 params String, ja3 String, ja4 String, cost Float64,
 INDEX idx_ip ip TYPE bloom_filter(0.01) GRANULARITY 4
) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (campaign_id, ts)`

const ddlConversions = `CREATE TABLE IF NOT EXISTS conversions (
 ts DateTime64(3,'UTC'), conv_id String, click_id String, key_id UInt32, type LowCardinality(String),
 revenue Float64, cost Float64, currency LowCardinality(String), sender_ip String, params String,
 campaign_id UInt32, stream_id UInt32, domain LowCardinality(String), country LowCardinality(String),
 region String, city String, isp String, device_type LowCardinality(String), os LowCardinality(String),
 browser LowCardinality(String), lang LowCardinality(String), ref_domain String, keyword String,
 sub1 String, sub2 String, sub3 String, sub4 String, sub5 String, is_bot UInt8,
 goal UInt8 DEFAULT type != 'rejected', click_ts DateTime64(3,'UTC'),
 INDEX idx_click click_id TYPE bloom_filter(0.01) GRANULARITY 4
) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (ts)`

const ddlPostbacks = `CREATE TABLE IF NOT EXISTS postbacks (
 ts DateTime64(3,'UTC'), status LowCardinality(String), http_status UInt16, reason String,
 key_id UInt32, key_prefix String, sender_ip String, type String, click_id String, conv_id String,
 campaign_id UInt32, stream_id UInt32, revenue Float64, query String
) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (ts)`

// Requests refused by the suppress lists live apart from clicks: a counter per
// rule and day, and, when the log is on, a short line per request.
const ddlSuppressedStats = `CREATE TABLE IF NOT EXISTS suppress_stats (
 day Date, owner_id UInt32, kind LowCardinality(String), rule_id UInt64,
 hits SimpleAggregateFunction(sum, UInt64), last SimpleAggregateFunction(max, DateTime('UTC'))
) ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(day) ORDER BY (owner_id, kind, rule_id, day)`

const ddlSuppressedLog = `CREATE TABLE IF NOT EXISTS suppress_log (
 ts DateTime('UTC'), owner_id UInt32, kind LowCardinality(String), rule_id UInt64, rule String,
 ip String, referer String, domain LowCardinality(String), campaign_id UInt32, ua String
) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (owner_id, kind, ts)`

const insertPostback = `INSERT INTO postbacks (ts, status, http_status, reason, key_id, key_prefix, sender_ip, type,
 click_id, conv_id, campaign_id, stream_id, revenue, query)`

const insertClick = `INSERT INTO clicks (ts, click_id, campaign_id, stream_id, domain, ip, country, region, city, asn, isp,
 device_type, os, os_version, browser, browser_version, ua, lang, referer, ref_domain, is_bot, bot_reason, is_dc, is_unique,
 action, integration, sub1, sub2, sub3, sub4, sub5, keyword, params, ja3, ja4, cost)`

const insertConv = `INSERT INTO conversions (ts, conv_id, click_id, key_id, type, revenue, cost, currency, sender_ip, params,
 campaign_id, stream_id, domain, country, region, city, isp, device_type, os, browser, lang, ref_domain, keyword,
 sub1, sub2, sub3, sub4, sub5, is_bot, goal, click_ts)`

// Columns added after the first release; safe to run on every start.
var chMigrations = []string{
	"ALTER TABLE conversions ADD COLUMN IF NOT EXISTS is_bot UInt8",
	// Before funnels every accepted conversion was the goal.
	"ALTER TABLE conversions ADD COLUMN IF NOT EXISTS goal UInt8 DEFAULT type != 'rejected'",
	"ALTER TABLE conversions ADD COLUMN IF NOT EXISTS click_ts DateTime64(3,'UTC')",
}

type Config struct {
	Addr, Database, User, Password string
}

type DB struct {
	conn   driver.Conn
	clicks chan *Click
	quit   chan struct{} // closed by Close; clicks itself never is, so a late AddClick cannot panic
	done   chan struct{}
	// The postback log has its own small queue and writer.
	postbacks chan *Postback
	pbDone    chan struct{}
	// So do requests refused by the suppress lists.
	suppressed chan *Suppressed
	supDone    chan struct{}
	Dropped    atomic.Int64
	Written    atomic.Int64
}

const (
	queueSize  = 200_000
	pbQueue    = 20_000
	batchSize  = 10_000
	flushEvery = time.Second
)

func Open(ctx context.Context, c Config) (*DB, error) {
	conn, err := clickhouse.Open(&clickhouse.Options{
		Addr:         []string{c.Addr},
		Auth:         clickhouse.Auth{Database: c.Database, Username: c.User, Password: c.Password},
		DialTimeout:  5 * time.Second,
		MaxOpenConns: 16,
		MaxIdleConns: 8,
		Compression:  &clickhouse.Compression{Method: clickhouse.CompressionLZ4},
	})
	if err != nil {
		return nil, err
	}
	for i := 0; i < 60; i++ {
		if err = conn.Ping(ctx); err == nil {
			break
		}
		time.Sleep(time.Second)
	}
	if err != nil {
		return nil, fmt.Errorf("clickhouse: %w", err)
	}
	for _, ddl := range append([]string{ddlClicks, ddlConversions, ddlPostbacks, ddlSuppressedStats, ddlSuppressedLog}, chMigrations...) {
		if err := conn.Exec(ctx, ddl); err != nil {
			return nil, fmt.Errorf("clickhouse schema: %w", err)
		}
	}
	db := &DB{conn: conn, clicks: make(chan *Click, queueSize), quit: make(chan struct{}), done: make(chan struct{}),
		postbacks: make(chan *Postback, pbQueue), pbDone: make(chan struct{}),
		suppressed: make(chan *Suppressed, pbQueue), supDone: make(chan struct{})}
	go db.writer()
	go db.postbackWriter()
	go db.suppressedWriter()
	return db, nil
}

// SetRetention applies the TTL of clicks, conversions, the postback log and
// what is kept about suppressed requests.
func (db *DB) SetRetention(ctx context.Context, days int) error {
	if days <= 0 {
		days = 180
	}
	for _, t := range []string{"clicks", "conversions", "postbacks", "suppress_log"} {
		q := fmt.Sprintf("ALTER TABLE %s MODIFY TTL toDateTime(ts) + INTERVAL %d DAY", t, days)
		if err := db.conn.Exec(ctx, q); err != nil {
			return err
		}
	}
	return db.conn.Exec(ctx, fmt.Sprintf("ALTER TABLE suppress_stats MODIFY TTL day + INTERVAL %d DAY", days))
}

// DeleteCampaign removes every click and conversion of a campaign, and its
// postback log. Clicks still in the write queue land afterwards, so the
// caller waits out a flush.
func (db *DB) DeleteCampaign(ctx context.Context, campaignID int64) error {
	time.Sleep(flushEvery + 200*time.Millisecond)
	for _, t := range []string{"clicks", "conversions", "postbacks"} {
		if err := db.conn.Exec(ctx, fmt.Sprintf("DELETE FROM %s WHERE campaign_id = %d", t, campaignID)); err != nil {
			return err
		}
	}
	return nil
}

// Purged is what DeleteIPs removed.
type Purged struct {
	Clicks      uint64 `json:"clicks"`
	Conversions uint64 `json:"conversions"`
	// Visitors are the (ip, user agent) pairs behind the removed clicks.
	Visitors [][2]string `json:"-"`
}

// DeleteIPs removes the clicks a campaign received from the given addresses
// and networks, together with the conversions of those clicks.
func (db *DB) DeleteIPs(ctx context.Context, campaignID int64, prefixes []netip.Prefix) (Purged, error) {
	var out Purged
	// Everything below is formatted by netip, so it is safe inside the query.
	var single, conds []string
	for _, p := range prefixes {
		if p.IsSingleIP() {
			single = append(single, "'"+p.Addr().String()+"'")
		} else {
			conds = append(conds, "isIPAddressInRange(ip, '"+p.Masked().String()+"')")
		}
	}
	if len(conds) > 0 {
		// Short-circuits, so a row without a parsable address never reaches the range check.
		conds = []string{"((isIPv4String(ip) OR isIPv6String(ip)) AND (" + strings.Join(conds, " OR ") + "))"}
	}
	if len(single) > 0 {
		conds = append(conds, "ip IN ("+strings.Join(single, ",")+")")
	}
	if len(conds) == 0 {
		return out, nil
	}
	time.Sleep(flushEvery + 200*time.Millisecond) // let queued clicks land first
	clicks := fmt.Sprintf("campaign_id = %d AND (%s)", campaignID, strings.Join(conds, " OR "))
	convs := fmt.Sprintf("campaign_id = %d AND click_id IN (SELECT click_id FROM clicks WHERE %s)", campaignID, clicks)

	if err := db.conn.QueryRow(ctx, "SELECT count() FROM clicks WHERE "+clicks).Scan(&out.Clicks); err != nil {
		return out, err
	}
	if err := db.conn.QueryRow(ctx, "SELECT count() FROM conversions WHERE "+convs).Scan(&out.Conversions); err != nil {
		return out, err
	}
	rows, err := db.conn.Query(ctx, "SELECT DISTINCT ip, ua FROM clicks WHERE "+clicks+" LIMIT 100000")
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var v [2]string
		if err := rows.Scan(&v[0], &v[1]); err != nil {
			rows.Close()
			return out, err
		}
		out.Visitors = append(out.Visitors, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	// Conversions and the postback log first: they are found through the clicks.
	for _, t := range []string{"conversions", "postbacks"} {
		if err := db.conn.Exec(ctx, "DELETE FROM "+t+" WHERE "+convs); err != nil {
			return out, err
		}
	}
	return out, db.conn.Exec(ctx, "DELETE FROM clicks WHERE "+clicks)
}

// AddClick never blocks: when ClickHouse cannot keep up the click is dropped
// and counted rather than slowing the visitor down.
func (db *DB) AddClick(c *Click) {
	select {
	case db.clicks <- c:
	default:
		db.Dropped.Add(1)
	}
}

func (db *DB) QueueLen() int { return len(db.clicks) }

func (db *DB) writer() {
	defer close(db.done)
	buf := make([]*Click, 0, batchSize)
	tick := time.NewTicker(flushEvery)
	defer tick.Stop()
	flush := func() {
		if len(buf) == 0 {
			return
		}
		// Retry a few times so a short ClickHouse restart loses nothing.
		var err error
		for try := 0; try < 5; try++ {
			if err = db.writeClicks(buf); err == nil {
				break
			}
			time.Sleep(time.Duration(try+1) * time.Second)
		}
		if err != nil {
			slog.Error("click batch lost", "rows", len(buf), "err", err)
			db.Dropped.Add(int64(len(buf)))
		} else {
			db.Written.Add(int64(len(buf)))
		}
		buf = buf[:0]
	}
	for {
		select {
		case c := <-db.clicks:
			buf = append(buf, c)
			if len(buf) >= batchSize {
				flush()
			}
		case <-tick.C:
			flush()
		case <-db.quit:
			// Write out whatever is still queued, then stop.
			for {
				select {
				case c := <-db.clicks:
					if buf = append(buf, c); len(buf) >= batchSize {
						flush()
					}
					continue
				default:
				}
				flush()
				return
			}
		}
	}
}

func b2u(b bool) uint8 {
	if b {
		return 1
	}
	return 0
}

func (db *DB) writeClicks(rows []*Click) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	batch, err := db.conn.PrepareBatch(ctx, insertClick)
	if err != nil {
		return err
	}
	for _, c := range rows {
		err := batch.Append(c.TS, c.ClickID, c.CampaignID, c.StreamID, c.Domain, c.IP, c.Country, c.Region, c.City, c.ASN, c.ISP,
			c.DeviceType, c.OS, c.OSVersion, c.Browser, c.BrowserVersion, c.UA, c.Lang, c.Referer, c.RefDomain,
			b2u(c.IsBot), c.BotReason, b2u(c.IsDC), b2u(c.IsUnique), c.Action, c.Integration,
			c.Sub[0], c.Sub[1], c.Sub[2], c.Sub[3], c.Sub[4], c.Keyword, c.Params, c.JA3, c.JA4, c.Cost)
		if err != nil {
			batch.Abort()
			return err
		}
	}
	return batch.Send()
}

// AddConversion writes synchronously: conversions are rare and the caller
// wants to know the event is durable before answering the postback.
func (db *DB) AddConversion(ctx context.Context, c *Conversion) error {
	batch, err := db.conn.PrepareBatch(ctx, insertConv)
	if err != nil {
		return err
	}
	clickTS := c.ClickTS
	if clickTS.IsZero() {
		clickTS = time.Unix(0, 0) // the column's "no click" value
	}
	err = batch.Append(c.TS, c.ConvID, c.ClickID, c.KeyID, c.Type, c.Revenue, c.Cost, c.Currency, c.SenderIP, c.Params,
		c.CampaignID, c.StreamID, c.Domain, c.Country, c.Region, c.City, c.ISP, c.DeviceType, c.OS, c.Browser, c.Lang,
		c.RefDomain, c.Keyword, c.Sub[0], c.Sub[1], c.Sub[2], c.Sub[3], c.Sub[4], b2u(c.IsBot),
		b2u(c.Goal), clickTS)
	if err != nil {
		batch.Abort()
		return err
	}
	return batch.Send()
}

// AddPostback queues a postback log entry. Like clicks, the log never holds
// a request up: when the queue is full the entry is dropped.
func (db *DB) AddPostback(p *Postback) {
	select {
	case db.postbacks <- p:
	default:
	}
}

func (db *DB) postbackWriter() {
	defer close(db.pbDone)
	buf := make([]*Postback, 0, 1000)
	tick := time.NewTicker(flushEvery)
	defer tick.Stop()
	flush := func() {
		if len(buf) == 0 {
			return
		}
		if err := db.writePostbacks(buf); err != nil {
			slog.Error("postback log batch lost", "rows", len(buf), "err", err)
		}
		buf = buf[:0]
	}
	for {
		select {
		case p := <-db.postbacks:
			if buf = append(buf, p); len(buf) >= cap(buf) {
				flush()
			}
		case <-tick.C:
			flush()
		case <-db.quit:
			for {
				select {
				case p := <-db.postbacks:
					if buf = append(buf, p); len(buf) >= cap(buf) {
						flush()
					}
					continue
				default:
				}
				flush()
				return
			}
		}
	}
}

func (db *DB) writePostbacks(rows []*Postback) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	batch, err := db.conn.PrepareBatch(ctx, insertPostback)
	if err != nil {
		return err
	}
	for _, p := range rows {
		err := batch.Append(p.TS, p.Status, p.HTTPStatus, p.Reason, p.KeyID, p.KeyPrefix, p.SenderIP, p.Type,
			p.ClickID, p.ConvID, p.CampaignID, p.StreamID, p.Revenue, p.Query)
		if err != nil {
			batch.Abort()
			return err
		}
	}
	return batch.Send()
}

// Close flushes queued clicks, postback log entries and suppressed requests.
func (db *DB) Close() {
	close(db.quit)
	timeout := time.After(20 * time.Second)
	for _, done := range []chan struct{}{db.done, db.pbDone, db.supDone} {
		select {
		case <-done:
		case <-timeout:
		}
	}
	db.conn.Close()
}

func (db *DB) Ping(ctx context.Context) error { return db.conn.Ping(ctx) }

// Row is one result row keyed by column name.
type Row = map[string]any

// query runs sql and returns rows as maps, whatever the column set is.
func (db *DB) query(ctx context.Context, sql string, args ...any) ([]Row, error) {
	rows, err := db.conn.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names := rows.Columns()
	types := rows.ColumnTypes()
	out := []Row{}
	for rows.Next() {
		dest := make([]any, len(names))
		for i, t := range types {
			dest[i] = reflect.New(t.ScanType()).Interface()
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		r := make(Row, len(names))
		for i, n := range names {
			r[n] = reflect.ValueOf(dest[i]).Elem().Interface()
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
