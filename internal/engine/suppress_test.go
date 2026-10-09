package engine

import (
	"net/netip"
	"testing"

	"simpletds/internal/model"
)

func TestSuppress(t *testing.T) {
	camp := func(id, owner int64, editors ...int64) *CampaignRT {
		c := &CampaignRT{Campaign: model.Campaign{ID: id, OwnerID: owner}, users: map[int64]bool{owner: true}}
		for _, u := range editors {
			c.users[u] = true
		}
		return c
	}
	// User 1 owns campaigns 10 and 11; user 2 owns 20 and may edit 11.
	campaigns := map[int64]*CampaignRT{10: camp(10, 1), 11: camp(11, 1, 2), 20: camp(20, 2)}
	rules := []model.SuppressRule{
		{ID: 1, OwnerID: 1, Kind: model.SuppressIP, Value: "203.0.113.7"},
		{ID: 2, OwnerID: 1, Kind: model.SuppressIP, Value: "198.51.100.0/24", CampaignIDs: []int64{10}},
		{ID: 3, OwnerID: 1, Kind: model.SuppressReferer, Value: "spam.example"},
		{ID: 4, OwnerID: 2, Kind: model.SuppressIP, Value: "2001:db8::/32", Store: model.SuppressLog},
		// Named campaigns: one user 2 may run, one they may not, one that is gone.
		{ID: 5, OwnerID: 2, Kind: model.SuppressReferer, Value: "mail.example.org", CampaignIDs: []int64{11, 10, 99}},
		{ID: 6, OwnerID: 1, Kind: model.SuppressIP, Value: "not an address"},
		{ID: 7, OwnerID: 1, Kind: model.SuppressIP, Value: "203.0.113.99", Store: model.SuppressOff},
	}
	attachSuppress(campaigns, rules)

	cases := []struct {
		campaign    int64
		ip, referer string
		rule        int64 // 0: not suppressed
	}{
		{10, "203.0.113.7", "", 1},
		{11, "203.0.113.7", "", 1},
		{20, "203.0.113.7", "", 0}, // another user's rule
		{10, "203.0.113.8", "", 0},
		{10, "198.51.100.200", "", 2},
		{11, "198.51.100.200", "", 0}, // the rule names campaign 10 only
		{10, "192.0.2.1", "https://spam.example/page?x=1", 3},
		{11, "192.0.2.1", "http://a.b.SPAM.example:8080/", 3},
		{10, "192.0.2.1", "https://notspam.example/", 0},
		{20, "2001:db8:1::5", "", 4},
		{11, "2001:db8:1::5", "", 0}, // "all campaigns" means the ones user 2 owns
		{11, "192.0.2.1", "https://mail.example.org/", 5},
		{10, "192.0.2.1", "https://mail.example.org/", 0}, // user 2 does not run campaign 10
		{11, "192.0.2.1", "https://example.org/", 0},
		{10, "203.0.113.7", "https://spam.example/", 1}, // the address wins
	}
	for _, c := range cases {
		var got int64
		r := campaigns[c.campaign].suppressed(netip.MustParseAddr(c.ip), c.referer)
		if r != nil {
			got = r.id
		}
		if got != c.rule {
			t.Errorf("campaign %d, %s from %q: got rule %d, want %d", c.campaign, c.ip, c.referer, got, c.rule)
		}
	}

	if r := campaigns[10].suppressed(netip.MustParseAddr("203.0.113.7"), ""); !r.count || r.log {
		t.Error("a rule keeps a counter only by default")
	}
	if r := campaigns[20].suppressed(netip.MustParseAddr("2001:db8::1"), ""); !r.count || !r.log {
		t.Error("rule 4 asked for the request log")
	}
	if r := campaigns[10].suppressed(netip.MustParseAddr("203.0.113.99"), ""); r == nil || r.count || r.log {
		t.Error("rule 7 suppresses and keeps nothing")
	}
}

func TestParseSuppressIP(t *testing.T) {
	for in, want := range map[string]string{
		" 203.0.113.7 ":      "203.0.113.7",
		"203.0.113.7/32":     "203.0.113.7",
		"198.51.100.77/24":   "198.51.100.0/24",
		"::ffff:203.0.113.7": "203.0.113.7",
		"2001:DB8::1":        "2001:db8::1",
	} {
		if _, got, err := ParseSuppressIP(in); err != nil || got != want {
			t.Errorf("%q: got %q %v, want %q", in, got, err, want)
		}
	}
	if _, _, err := ParseSuppressIP("example.com"); err == nil {
		t.Error("a host name is not an address")
	}
}
