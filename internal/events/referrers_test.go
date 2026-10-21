package events

import (
	"testing"
	"time"
)

func TestFuzzyScore(t *testing.T) {
	cases := []struct {
		text, query string
		match       bool
	}{
		{"facebook.com", "face", true},
		{"m.facebook.com", "FACEBOOK", true},
		{"facebook.com", "fbk", true},      // letters in order
		{"facebook.com", "faecbook", true}, // a typo
		{"facebook.com", "google", false},
		{"news.google.com", "google news", true},
		{"news.google.com", "google bing", false},
		{"t.co", "x", false},
	}
	for _, c := range cases {
		if _, ok := fuzzyScore(c.text, c.query); ok != c.match {
			t.Errorf("fuzzyScore(%q, %q) = %v, want %v", c.text, c.query, ok, c.match)
		}
	}
	// What contains the word ranks above what only resembles it.
	exact, _ := fuzzyScore("google.com", "goog")
	loose, _ := fuzzyScore("gxoxoxg.com", "goog")
	if exact <= loose {
		t.Errorf("a substring scored %v, a subsequence %v", exact, loose)
	}
}

func TestRefStatus(t *testing.T) {
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		ago  time.Duration
		want string
	}{
		{time.Minute, RefActive},
		{23 * time.Hour, RefActive},
		{25 * time.Hour, RefRecent},
		{6 * 24 * time.Hour, RefRecent},
		{8 * 24 * time.Hour, RefDead},
	}
	for _, c := range cases {
		if got := refStatus(now.Add(-c.ago), now, 24*time.Hour); got != c.want {
			t.Errorf("silent for %v: %s, want %s", c.ago, got, c.want)
		}
	}
	// An idle time past the dead line leaves nothing recently dead.
	if got := refStatus(now.Add(-8*24*time.Hour), now, 10*24*time.Hour); got != RefActive {
		t.Errorf("got %s", got)
	}
}
