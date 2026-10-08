package antibot

import (
	"net/netip"
	"testing"
)

func TestSetContains(t *testing.T) {
	set := NewSet(ParsePrefixes([]byte(`
		# comment 10.0.0.0/8
		{"ipv4Prefix": "66.249.64.0/27"}, {"ipv6Prefix": "2001:4860:4801:10::/64"}
		192.168.1.5 10.1.0.0/16 0.0.0.0/32
	`)))
	cases := map[string]bool{
		"10.255.255.255":           true,
		"11.0.0.0":                 false,
		"9.255.255.255":            false,
		"66.249.64.31":             true,
		"66.249.64.32":             false,
		"192.168.1.5":              true,
		"192.168.1.6":              false,
		"2001:4860:4801:10::1":     true,
		"2001:4860:4801:11::1":     false,
		"::ffff:10.1.2.3":          true, // IPv4-mapped addresses match IPv4 ranges
		"0.0.0.0":                  true,
		"255.255.255.255":          false,
		"2001:4860:4801:10:ffff::": true,
	}
	for ip, want := range cases {
		if got := set.Contains(netip.MustParseAddr(ip)); got != want {
			t.Errorf("Contains(%s) = %v, want %v", ip, got, want)
		}
	}
	var empty *Set
	if empty.Contains(netip.MustParseAddr("1.1.1.1")) {
		t.Error("nil set must contain nothing")
	}
}

func TestUABotSignatures(t *testing.T) {
	p := newUAParser([]string{"MyCrawler"})
	bots := []string{
		"", "curl/8.4.0", "python-requests/2.31", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
		"facebookexternalhit/1.1", "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0 Safari/537.36", "mycrawler 1.0",
	}
	for _, ua := range bots {
		if !p.parse(ua).Bot {
			t.Errorf("%q should be a bot", ua)
		}
	}
	humans := []string{
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
		"Mozilla/5.0 (Linux; Android 13; CUBOT NOTE 21) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
		"Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 Instagram 330.0.0.40.92 Android",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 YaBrowser/24.4.0.0 Safari/537.36",
	}
	for _, ua := range humans {
		if u := p.parse(ua); u.Bot {
			t.Errorf("%q flagged as bot (%s)", ua, u.BotSig)
		}
	}
}
