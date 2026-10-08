package engine

import (
	"net/netip"
	"net/url"
	"testing"
	"time"

	"simpletds/internal/antibot"
	"simpletds/internal/geo"
	"simpletds/internal/model"
)

func visit(country, device string, bot bool) *Visit {
	return &Visit{IP: netip.MustParseAddr("1.2.3.4"), UA: &antibot.UA{DeviceType: device, Raw: "UA"},
		Geo: geo.Info{Country: country}, Verdict: antibot.Verdict{Bot: bot}, Query: url.Values{"utm": {"x"}}}
}

func stream(op string, js bool, fs ...model.Filter) *StreamRT {
	s := &StreamRT{Stream: model.Stream{FilterOp: op, JSCheck: js}}
	var err error
	if s.filters, err = compileFilters(fs); err != nil {
		panic(err)
	}
	return s
}

func TestStreamMatching(t *testing.T) {
	ru := model.Filter{Type: "country", Mode: "is", Values: []string{"RU", "kz"}}
	notMobile := model.Filter{Type: "device_type", Mode: "is_not", Values: []string{"mobile"}}
	isBot := model.Filter{Type: "bot", Mode: "is"}
	hasUTM := model.Filter{Type: "param", Mode: "is", Values: []string{"utm=x"}}

	cases := []struct {
		name string
		s    *StreamRT
		v    *Visit
		want bool
	}{
		{"no filters", stream("and", false), visit("US", "desktop", false), true},
		{"and: both pass", stream("and", false, ru, notMobile), visit("KZ", "desktop", false), true},
		{"and: one fails", stream("and", false, ru, notMobile), visit("RU", "mobile", false), false},
		{"or: one passes", stream("or", false, ru, notMobile), visit("RU", "mobile", false), true},
		{"or: none pass", stream("or", false, ru, isBot), visit("US", "mobile", false), false},
		{"is_not", stream("and", false, notMobile), visit("US", "mobile", false), false},
		{"bot flag", stream("and", false, isBot), visit("US", "bot", true), true},
		{"param", stream("and", false, hasUTM), visit("US", "desktop", false), true},
		{"js check stream never takes bots", stream("and", true), visit("US", "desktop", true), false},
	}
	for _, c := range cases {
		if got := c.s.matches(c.v, nil); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
		// The traced path evaluates every filter and must agree.
		if got := c.s.matches(c.v, &StreamTrace{}); got != c.want {
			t.Errorf("%s (traced): got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestPickOrder(t *testing.T) {
	forced := stream("and", false, model.Filter{Type: "bot", Mode: "is"})
	forced.ID = 1
	regular := stream("and", false, model.Filter{Type: "country", Mode: "is", Values: []string{"RU"}})
	regular.ID = 2
	def := stream("and", false)
	def.ID = 3
	c := &CampaignRT{Forced: []*StreamRT{forced}, Regular: []*StreamRT{regular}, Default: []*StreamRT{def}}
	for want, v := range map[int64]*Visit{1: visit("RU", "bot", true), 2: visit("RU", "desktop", false), 3: visit("US", "desktop", false)} {
		if got := c.pick(v, nil); got == nil || got.ID != want {
			t.Errorf("want stream %d, got %+v", want, got)
		}
	}
}

func TestClickID(t *testing.T) {
	e := &Engine{secret: []byte("0123456789abcdef0123456789abcdef")}
	now := time.Unix(1_800_000_000, 0)
	id := e.newClickID(now, 70000, 123456)
	ref, err := e.parseClickID(id)
	if err != nil || ref.CampaignID != 70000 || ref.StreamID != 123456 || !ref.At.Equal(now) {
		t.Fatalf("round trip failed: %+v %v", ref, err)
	}
	forged := []byte(id)
	forged[8] ^= 1
	if _, err := e.parseClickID(string(forged)); err == nil {
		t.Error("tampered id accepted")
	}
	other := &Engine{secret: []byte("another-secret-another-secret-00")}
	if _, err := other.parseClickID(id); err == nil {
		t.Error("id accepted under a different secret")
	}
	for _, bad := range []string{"", "abc", "!!!!"} {
		if _, err := e.parseClickID(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestMacroExpansion(t *testing.T) {
	v := visit("RU", "desktop", false)
	v.ClickID = "CID"
	v.Campaign = &CampaignRT{Campaign: model.Campaign{ID: 7, Alias: "go"}}
	v.Query = url.Values{"sub1": {"a b"}, "x": {"1&2"}}
	got := v.expand("https://o.example/?c={click_id}&g={country}&s={sub1}&p={param:x}&keep={unknown}", true)
	want := "https://o.example/?c=CID&g=RU&s=a+b&p=1%262&keep={unknown}"
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestSignPostback(t *testing.T) {
	q := url.Values{"key": {"k"}, "ts": {"1"}, "b": {"2"}, "a": {"1"}, "sig": {"ignored"}}
	if got := SignPostback("secret", q); len(got) != 64 {
		t.Fatalf("want a hex SHA-256, got %q", got)
	}
	q2 := url.Values{"a": {"1"}, "b": {"2"}, "key": {"k"}, "ts": {"1"}}
	if SignPostback("secret", q) != SignPostback("secret", q2) {
		t.Error("signature must ignore sig and parameter order")
	}
	q2.Set("b", "3")
	if SignPostback("secret", q) == SignPostback("secret", q2) {
		t.Error("signature must change with the data")
	}
}

func TestConversionKind(t *testing.T) {
	plain := &CampaignRT{}
	funnel := &CampaignRT{Campaign: model.Campaign{Stages: []model.Stage{{Key: "signup"}, {Key: "order", Goal: true}}}}
	cases := []struct {
		name        string
		c           *CampaignRT
		typ         string
		goal, known bool
	}{
		{"built-in type is a conversion", plain, "sale", true, true},
		{"unattributed built-in type", nil, "lead", true, true},
		{"rejected is never a conversion", plain, "rejected", false, true},
		{"stage keys need a funnel", plain, "signup", false, false},
		{"step of a funnel", funnel, "signup", false, true},
		{"goal of a funnel", funnel, "order", true, true},
		{"built-in type next to a funnel is not its goal", funnel, "sale", false, true},
		{"rejected with a funnel", funnel, "rejected", false, true},
		{"unknown", funnel, "nosuch", false, false},
	}
	for _, c := range cases {
		if goal, known := conversionKind(c.c, c.typ); goal != c.goal || known != c.known {
			t.Errorf("%s: got goal=%v known=%v", c.name, goal, known)
		}
	}
}
