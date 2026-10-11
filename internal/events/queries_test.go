package events

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestFilterConditions(t *testing.T) {
	cases := []struct {
		name   string
		q      Query
		clicks []string // what the click selection must contain
		convs  []string
	}{
		{"one value", Query{Dims: map[string][]string{"os": {"Android"}}}, []string{"os = ?"}, []string{"os = ?"}},
		{"several values", Query{Dims: map[string][]string{"os": {"Android", "iOS"}}}, []string{"os IN (?)"}, []string{"os IN (?)"}},
		{"empty value is a filter", Query{Dims: map[string][]string{"country": {""}}}, []string{"country = ?"}, nil},
		// A dimension the table lacks must match nothing rather than everything.
		{"click-only dimension", Query{Dims: map[string][]string{"action": {"redirect"}}}, []string{"action = ?"}, []string{"0"}},
		{"conversion-only dimension", Query{Dims: map[string][]string{"type": {"sale"}}}, []string{"0"}, []string{"type = ?"}},
		{"unknown dimension", Query{Dims: map[string][]string{"nope": {"x"}, "campaign": {"1"}}}, []string{"1"}, []string{"1"}},
		{"contains, every word", Query{Like: map[string]string{"referer": "google  shop"}},
			[]string{"positionCaseInsensitiveUTF8(referer, ?) > 0 AND positionCaseInsensitiveUTF8(referer, ?) > 0"},
			[]string{"positionCaseInsensitiveUTF8(ref_domain, ?) > 0"}},
		{"user agent is kept for clicks only", Query{Like: map[string]string{"ua": "bot"}}, []string{"positionCaseInsensitiveUTF8(ua, ?) > 0"}, []string{"0"}},
		{"address", Query{IP: "203.0.113.7"}, []string{"ip = ?"}, []string{"sender_ip = ?"}},
		{"network", Query{IP: "203.0.113.0/24"}, []string{"isIPAddressInRange(ip, ?)"}, []string{"isIPAddressInRange(sender_ip, ?)"}},
		{"beginning of an address", Query{IP: "203.0.*"}, []string{"startsWith(ip, ?)"}, []string{"startsWith(sender_ip, ?)"}},
		{"click flags", Query{Unique: "only", DC: "exclude", Bots: "exclude"}, []string{"is_bot = 0", "is_unique = 1", "is_dc = 0"}, []string{"is_bot = 0"}},
		// What the viewer suppressed is left out unless asked for; a conversion finds the address through its click.
		{"banned address", Query{BannedSets: []BannedSet{{Campaigns: []uint32{3, 4}, IPs: []string{"203.0.113.7"}}}},
			[]string{"NOT ((campaign_id IN (3,4) AND (ip IN ('203.0.113.7'))))"},
			[]string{"NOT ((campaign_id IN (3,4) AND (click_id IN (SELECT click_id FROM clicks WHERE campaign_id IN (3,4) AND (ip IN ('203.0.113.7'))))))"}},
		{"banned network and referrer", Query{BannedSets: []BannedSet{{Campaigns: []uint32{3}, Nets: []string{"203.0.113.0/24"}, Refs: []string{"spy.example"}}}},
			[]string{"ref_domain IN ('spy.example') OR arrayExists(d -> endsWith(ref_domain, concat('.', d)), ['spy.example'])", "arrayExists(n -> isIPAddressInRange(ip, n), ['203.0.113.0/24'])"},
			[]string{"NOT ((campaign_id IN (3) AND (ref_domain IN ('spy.example')"}},
		{"only the banned", Query{Banned: "only", BannedSets: []BannedSet{{Campaigns: []uint32{3}, Refs: []string{"spy.example"}}}},
			[]string{"((campaign_id IN (3) AND (ref_domain IN ('spy.example')"}, []string{"((campaign_id IN (3) AND (ref_domain IN ('spy.example')"}},
		{"only the banned, nothing suppressed", Query{Banned: "only"}, []string{"0"}, []string{"0"}},
		{"banned included", Query{Banned: "all", BannedSets: []BannedSet{{Campaigns: []uint32{3}, Refs: []string{"spy.example"}}}}, []string{"1"}, []string{"1"}},
		// Rules that cover no campaign of the viewer's change nothing.
		{"banned nowhere", Query{BannedSets: []BannedSet{{Refs: []string{"spy.example"}}}}, []string{"1"}, []string{"1"}},
	}
	for _, c := range cases {
		for i, want := range [][]string{c.clicks, c.convs} {
			w := c.q.convWhere()
			if i == 0 {
				w = c.q.clickWhere()
			}
			got := w.sql()
			for _, part := range want {
				if (part == "0" || part == "1") && got != part {
					t.Errorf("%s: got %q, want %q", c.name, got, part)
				} else if !strings.Contains(got, part) {
					t.Errorf("%s: %q lacks %q", c.name, got, part)
				}
			}
			if n := strings.Count(got, "?"); n != len(w.args) {
				t.Errorf("%s: %d placeholders for %d arguments in %q", c.name, n, len(w.args), got)
			}
		}
	}
	if q := (Query{IP: "203.0.*"}); q.clickWhere().args[0] != "203.0." {
		t.Errorf("prefix argument: %v", q.clickWhere().args)
	}
	for name, want := range map[string]bool{"referer": true, "ua": true, "city": true, "sub3": true, "campaign": false, "day": false, "x": false} {
		if Searchable(name) != want {
			t.Errorf("Searchable(%q) = %v", name, !want)
		}
	}
}

// TestFilterQueries runs the filters against a real ClickHouse and is skipped
// without one, like TestFunnel.
func TestFilterQueries(t *testing.T) {
	addr := os.Getenv("TDS_TEST_CLICKHOUSE")
	if addr == "" {
		t.Skip("TDS_TEST_CLICKHOUSE not set")
	}
	ctx := context.Background()
	db, err := Open(ctx, Config{Addr: addr, Database: "tds", User: "tds", Password: "tds"})
	if err != nil {
		t.Fatal(err)
	}
	const camp = 4_000_002
	wipe := func() {
		for _, tbl := range []string{"clicks", "conversions"} {
			if err := db.conn.Exec(ctx, fmt.Sprintf("ALTER TABLE %s DELETE WHERE campaign_id = %d SETTINGS mutations_sync = 1", tbl, camp)); err != nil {
				t.Fatal(err)
			}
		}
	}
	wipe()
	// The rows would otherwise show up in the panel of whoever shares this database.
	t.Cleanup(wipe)
	at := time.Now().UTC().Add(-time.Hour)
	clicks := []*Click{
		{IP: "203.0.113.7", Country: "DE", City: "Berlin", DeviceType: "mobile", OS: "Android", Referer: "https://www.google.com/search?q=shoes", RefDomain: "www.google.com", IsUnique: true},
		{IP: "203.0.113.9", Country: "DE", City: "Hamburg", DeviceType: "desktop", OS: "Windows", Referer: "https://www.google.com/maps", RefDomain: "www.google.com"},
		{IP: "203.0.114.1", Country: "FR", City: "Paris", DeviceType: "mobile", OS: "iOS", Referer: "https://news.example.org/a", RefDomain: "news.example.org", IsUnique: true},
		{IP: "2001:db8::1", Country: "US", City: "Boston", DeviceType: "tablet", OS: "iOS", IsDC: true},
		{IP: "not an address", Country: "", DeviceType: "bot", OS: "", IsBot: true},
	}
	for i, c := range clicks {
		c.TS, c.ClickID, c.CampaignID = at.Add(time.Duration(i)*time.Second), fmt.Sprintf("flt%d", i), camp
	}
	if err := db.writeClicks(clicks); err != nil {
		t.Fatal(err)
	}
	conv := &Conversion{TS: at.Add(time.Minute), ConvID: "fltc", ClickID: "flt0", Type: "sale", Goal: true, CampaignID: camp, Revenue: 5}
	conv.FromClick(clicks[0])
	if err := db.AddConversion(ctx, conv); err != nil {
		t.Fatal(err)
	}
	base := func() Query {
		return Query{From: at.Add(-time.Minute), To: at.Add(time.Hour), CampaignID: camp, Dims: map[string][]string{}, Like: map[string]string{}}
	}
	count := func(name string, want uint64, set func(q *Query)) {
		t.Helper()
		q := base()
		set(&q)
		_, total, err := db.Clicks(ctx, q)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if total != want {
			t.Errorf("%s: %d clicks, want %d", name, total, want)
		}
	}
	count("everything", 5, func(q *Query) {})
	count("two systems", 3, func(q *Query) { q.Dims["os"] = []string{"Android", "iOS"} })
	count("system and device", 1, func(q *Query) { q.Dims["os"], q.Dims["device_type"] = []string{"iOS"}, []string{"mobile"} })
	count("unknown country", 1, func(q *Query) { q.Dims["country"] = []string{""} })
	count("referrer contains", 1, func(q *Query) { q.Like["referer"] = "GOOGLE shoes" })
	count("network", 2, func(q *Query) { q.IP = "203.0.113.0/24" })
	count("v6 network", 1, func(q *Query) { q.IP = "2001:db8::/32" })
	count("beginning of an address", 3, func(q *Query) { q.IP = "203.0." })
	count("unique", 2, func(q *Query) { q.Unique = "only" })
	count("not from a datacenter", 4, func(q *Query) { q.DC = "exclude" })

	// The options of a filter: most frequent first, and not narrowed by the filter itself.
	q := base()
	q.Dims["os"] = []string{"Android"}
	vals, err := db.Values(ctx, "os", "", false, 0, q)
	if err != nil {
		t.Fatal(err)
	}
	if len(vals) != 4 || vals[0] != (ValueRow{Value: "iOS", Count: 2}) {
		t.Errorf("os values: %+v", vals)
	}
	if len(q.Dims["os"]) != 1 {
		t.Errorf("Values changed the caller's filters: %v", q.Dims)
	}
	// Another filter does narrow them.
	q.Dims["country"] = []string{"DE"}
	if vals, _ = db.Values(ctx, "os", "", false, 0, q); len(vals) != 2 {
		t.Errorf("os values in DE: %+v", vals)
	}
	// A typo still finds the referrer, after anything that matches as written.
	for search, want := range map[string]string{"goog": "www.google.com", "gogle": "www.google.com", "exampel": "news.example.org", "zzzz": ""} {
		vals, err := db.Values(ctx, "ref_domain", search, false, 0, base())
		if err != nil {
			t.Fatal(err)
		}
		got := ""
		if len(vals) > 0 {
			got = vals[0].Value
		}
		if got != want {
			t.Errorf("referrers like %q: %+v, want %q first", search, vals, want)
		}
	}
	if vals, err = db.Values(ctx, "type", "", true, 0, base()); err != nil || len(vals) != 1 || vals[0].Value != "sale" {
		t.Errorf("conversion types: %+v, %v", vals, err)
	}
	if _, err = db.Values(ctx, "campaign", "", false, 0, base()); err == nil {
		t.Error("campaign has no value list")
	}

	// The geo report: a country with its device split and what it converted.
	rows, err := db.Split(ctx, "country", base())
	if err != nil {
		t.Fatal(err)
	}
	var de SplitRow
	for _, r := range rows {
		if r.Key == "DE" {
			de = r
		}
	}
	if len(rows) != 4 || de.Clicks != 2 || de.Mobile != 1 || de.Desktop != 1 || de.Conversions != 1 || de.Revenue != 5 {
		t.Errorf("geo: %+v", rows)
	}
	q = base()
	q.Dims["country"], q.Dims["device_type"] = []string{"DE"}, []string{"mobile"}
	if rows, err = db.Split(ctx, "city", q); err != nil || len(rows) != 1 || rows[0].Key != "Berlin" || rows[0].Conversions != 1 {
		t.Errorf("cities: %+v, %v", rows, err)
	}
}
