package events

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"
)

// TestFunnel runs against a real ClickHouse and is skipped without one:
//
//	TDS_TEST_CLICKHOUSE=127.0.0.1:9000 go test ./internal/events/
//
// It uses the tds database and user of the compose file and its own campaign id.
func TestFunnel(t *testing.T) {
	addr := os.Getenv("TDS_TEST_CLICKHOUSE")
	if addr == "" {
		t.Skip("TDS_TEST_CLICKHOUSE not set")
	}
	ctx := context.Background()
	db, err := Open(ctx, Config{Addr: addr, Database: "tds", User: "tds", Password: "tds"})
	if err != nil {
		t.Fatal(err)
	}
	const camp = 4_000_001
	for _, tbl := range []string{"clicks", "conversions"} {
		if err := db.conn.Exec(ctx, fmt.Sprintf("ALTER TABLE %s DELETE WHERE campaign_id = %d SETTINGS mutations_sync = 1", tbl, camp)); err != nil {
			t.Fatal(err)
		}
	}

	day := time.Now().UTC().Truncate(24 * time.Hour).Add(-48 * time.Hour)
	// Five clicks on one day, one of them a bot. What each went on to do:
	paths := map[string][]string{
		"a": {"lp_click", "signup", "order"}, // the whole funnel
		"b": {"lp_click", "signup"},
		"c": {"lp_click", "lp_click"}, // a repeated event is still one click
		"d": {"order", "lp_click"},    // out of order: bought before the landing click arrived
		"e": {},
	}
	var clicks []*Click
	for id := range paths {
		country := "DE"
		if id == "d" {
			country = "FR"
		}
		clicks = append(clicks, &Click{TS: day.Add(time.Hour), ClickID: id, CampaignID: camp, Country: country, IsBot: id == "e", IsUnique: true})
	}
	if err := db.writeClicks(clicks); err != nil {
		t.Fatal(err)
	}
	for _, c := range clicks {
		for i, typ := range paths[c.ClickID] {
			conv := &Conversion{
				// Events arrive days later, outside the period asked for below.
				TS: day.Add(30*time.Hour + time.Duration(i)*time.Minute), ConvID: c.ClickID + typ + fmt.Sprint(i),
				ClickID: c.ClickID, Type: typ, CampaignID: camp, Goal: typ == "order", Params: "{}",
			}
			if typ == "order" {
				conv.Revenue, conv.Cost = 10, 4
			}
			conv.FromClick(c)
			if err := db.AddConversion(ctx, conv); err != nil {
				t.Fatal(err)
			}
		}
	}

	stages := []string{"lp_click", "signup", "order"}
	q := Query{From: day, To: day.Add(24 * time.Hour), CampaignID: camp}
	reached := func(group string, strict bool) map[string][]int64 {
		t.Helper()
		rows, err := db.Funnel(ctx, group, stages, strict, q)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string][]int64{}
		for _, r := range rows {
			s := []int64{r.Clicks}
			for _, st := range r.Steps {
				s = append(s, st.Reached)
			}
			out[r.Key] = s
		}
		return out
	}
	check := func(name string, got map[string][]int64, want map[string][]int64) {
		t.Helper()
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("%s: got %v, want %v", name, got, want)
		}
	}
	// The period covers the clicks, not the events: the cohort is followed.
	check("total", reached("total", false), map[string][]int64{"total": {5, 4, 2, 2}})
	check("total strict", reached("total", true), map[string][]int64{"total": {5, 4, 2, 1}})
	check("by country", reached("country", false), map[string][]int64{"DE": {4, 3, 2, 1}, "FR": {1, 1, 0, 1}})
	check("by day", reached("day", false), map[string][]int64{day.Format("2006-01-02"): {5, 4, 2, 2}})

	rows, err := db.Funnel(ctx, "total", stages, false, q)
	if err != nil {
		t.Fatal(err)
	}
	if lp, order := rows[0].Steps[0], rows[0].Steps[2]; lp.Events != 5 || order.Revenue != 20 || rows[0].Cost != 8 || rows[0].Bots != 1 {
		t.Errorf("totals: %+v", rows[0])
	}

	// The plain report counts only the goal stage as a conversion.
	rep, err := db.Report(ctx, "total", Query{From: day, To: day.Add(72 * time.Hour), CampaignID: camp})
	if err != nil {
		t.Fatal(err)
	}
	if r := rep[0]; r.Conversions != 2 || r.Revenue != 20 || r.Types["lp_click"] != 5 || r.Types["signup"] != 2 {
		t.Errorf("report: %+v", r)
	}
	db.Close()
}
