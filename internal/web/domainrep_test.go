package web

import (
	"testing"
	"time"

	"simpletds/internal/model"
)

func TestMergeReputation(t *testing.T) {
	now := time.Now()
	hour := func(n int) time.Time { return now.Add(-time.Duration(n) * time.Hour) }
	active := map[string]bool{"gsb": true, "spamhaus": true, "quad9": true}
	cur := []model.RepResult{
		{Provider: "quad9", Status: "clean", CheckedAt: hour(2)},
		{Provider: "spamhaus", Status: "listed", Detail: "Listed as spam", CheckedAt: hour(2)},
		{Provider: "virustotal", Status: "listed", CheckedAt: hour(2)}, // switched off since
	}
	ids := func(rs []model.RepResult) string {
		s := ""
		for _, r := range rs {
			s += r.Provider + ":" + r.Status + " "
		}
		return s
	}

	// A new answer is added in provider order; the switched-off provider goes.
	out, status := mergeReputation(cur, model.RepResult{Provider: "gsb", Status: "clean", CheckedAt: now}, active, 36*time.Hour)
	if got := ids(out); got != "gsb:clean spamhaus:listed quad9:clean " || status != "listed" {
		t.Errorf("add: %s → %s", got, status)
	}
	// A failed check does not erase a recent listing…
	out, status = mergeReputation(cur, model.RepResult{Provider: "spamhaus", Status: "error", CheckedAt: now}, active, 36*time.Hour)
	if got := ids(out); got != "spamhaus:listed quad9:clean " || status != "listed" {
		t.Errorf("failure over a fresh verdict: %s → %s", got, status)
	}
	// …but replaces one that is too old to trust.
	out, status = mergeReputation(cur, model.RepResult{Provider: "spamhaus", Status: "error", CheckedAt: now}, active, time.Hour)
	if got := ids(out); got != "spamhaus:error quad9:clean " || status != "clean" {
		t.Errorf("failure over a stale verdict: %s → %s", got, status)
	}
	// A delisting shows at once.
	out, status = mergeReputation(cur, model.RepResult{Provider: "spamhaus", Status: "clean", CheckedAt: now}, active, 36*time.Hour)
	if got := ids(out); got != "spamhaus:clean quad9:clean " || status != "clean" {
		t.Errorf("delisted: %s → %s", got, status)
	}
	// Nothing but failures is not "clean".
	if _, status = mergeReputation(nil, model.RepResult{Provider: "gsb", Status: "error", CheckedAt: now}, active, time.Hour); status != "unknown" {
		t.Errorf("only failures: %s", status)
	}
}

func TestCleanReputation(t *testing.T) {
	set := model.ReputationSettings{Providers: map[string]model.RepProvider{
		"virustotal": {Enabled: true, Key: " 0123456789abcdef ", Threshold: 999},
		"surbl":      {Enabled: true, Key: "ignored-key", Threshold: 3, PerMinute: 9},
		"nonsense":   {Enabled: true},
	}}
	if err := cleanReputation(&set); err != nil {
		t.Fatal(err)
	}
	vt, surbl := set.Providers["virustotal"], set.Providers["surbl"]
	if set.IntervalHours != 12 || vt.Key != "0123456789abcdef" || vt.Threshold != repDefaultVT || vt.PerMinute != repDefaultRPM ||
		surbl != (model.RepProvider{Enabled: true}) || len(set.Providers) != 2 {
		t.Errorf("not normalised: %+v", set)
	}
	for name, bad := range map[string]model.ReputationSettings{
		"key needed": {Providers: map[string]model.RepProvider{"gsb": {Enabled: true}}},
		"odd key":    {Providers: map[string]model.RepProvider{"spamhaus": {Key: "a.b/c d"}}},
		"interval":   {IntervalHours: 100000},
	} {
		if cleanReputation(&bad) == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
