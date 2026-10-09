// Package events stores clicks and conversions in ClickHouse. Writes are
// batched off the request path; reads back the panel's reports.
package events

import (
	"context"
	"fmt"
	"log/slog"
	"reflect"
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
	conn    driver.Conn
	clicks  chan *Click
	quit    chan struct{} // closed by Close; clicks itself never is, so a late AddClick cannot panic
	done    chan struct{}
	Dropped atomic.Int64
	Written atomic.Int64
}

const (
	queueSize  = 200_000
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
	for _, ddl := range append([]string{ddlClicks, ddlConversions}, chMigrations...) {
		if err := conn.Exec(ctx, ddl); err != nil {
			return nil, fmt.Errorf("clickhouse schema: %w", err)
		}
	}
	db := &DB{conn: conn, clicks: make(chan *Click, queueSize), quit: make(chan struct{}), done: make(chan struct{})}
	go db.writer()
	return db, nil
}

// SetRetention applies the click/conversion TTL.
func (db *DB) SetRetention(ctx context.Context, days int) error {
	if days <= 0 {
		days = 180
	}
	for _, t := range []string{"clicks", "conversions"} {
		q := fmt.Sprintf("ALTER TABLE %s MODIFY TTL toDateTime(ts) + INTERVAL %d DAY", t, days)
		if err := db.conn.Exec(ctx, q); err != nil {
			return err
		}
	}
	return nil
}

// DeleteCampaign removes every click and conversion of a campaign. Clicks
// still in the write queue land afterwards, so the caller waits out a flush.
func (db *DB) DeleteCampaign(ctx context.Context, campaignID int64) error {
	time.Sleep(flushEvery + 200*time.Millisecond)
	for _, t := range []string{"clicks", "conversions"} {
		if err := db.conn.Exec(ctx, fmt.Sprintf("DELETE FROM %s WHERE campaign_id = %d", t, campaignID)); err != nil {
			return err
		}
	}
	return nil
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

// Close flushes queued clicks.
func (db *DB) Close() {
	close(db.quit)
	select {
	case <-db.done:
	case <-time.After(20 * time.Second):
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
