package engine

import (
	"net/url"
	"testing"

	lru "github.com/hashicorp/golang-lru/v2"

	"simpletds/internal/model"
)

func TestTestEntry(t *testing.T) {
	used, _ := lru.New[string, struct{}](16)
	e := &Engine{secret: []byte("0123456789abcdef0123456789abcdef"), testUsed: used}
	st := &StreamRT{Stream: model.Stream{ID: 7}}
	c := &CampaignRT{Campaign: model.Campaign{ID: 3, Test: true, TestKey: "dev-key"}, Regular: []*StreamRT{st}}
	issued, unlisted := e.IssueClickID(3, 7), e.IssueClickID(3, 7)
	foreign, gone := e.IssueClickID(4, 7), e.IssueClickID(3, 8)
	snap := &Snapshot{testClicks: map[string]bool{issued: true, foreign: true, gone: true}}
	enter := func(q url.Values) (*testEntry, *Input) {
		in := &Input{Campaign: c, Query: q}
		return e.testEntry(in, snap), in
	}

	for name, q := range map[string]url.Values{
		"no key":                    {"sub1": {"x"}},
		"wrong key":                 {"key": {"dev-kez"}},
		"an id without the key":     {"click_id": {issued}},
		"an id outside the pool":    {"key": {"dev-key"}, "click_id": {unlisted}},
		"another campaign's id":     {"key": {"dev-key"}, "click_id": {foreign}},
		"an id of a missing stream": {"key": {"dev-key"}, "click_id": {gone}},
		"a made-up id":              {"key": {"dev-key"}, "click_id": {"nope"}},
	} {
		if got, _ := enter(q); got != nil {
			t.Errorf("%s: let in", name)
		}
	}

	got, in := enter(url.Values{"key": {"dev-key"}, "sub1": {"x"}})
	if got == nil || got.clickID != "" || got.stream != nil {
		t.Fatalf("key alone: got %+v", got)
	}
	if len(in.Query) != 1 || in.Query.Get("sub1") != "x" {
		t.Errorf("the key stayed in the query: %v", in.Query)
	}

	// The id may come under any name of click_id, and is entered once.
	got, in = enter(url.Values{"key": {"dev-key"}, "cid": {issued}})
	if got == nil || got.clickID != issued || got.stream != st || got.at.IsZero() {
		t.Fatalf("issued id: got %+v", got)
	}
	if len(in.Query) != 0 {
		t.Errorf("the id stayed in the query: %v", in.Query)
	}
	if got, _ := enter(url.Values{"key": {"dev-key"}, "click_id": {issued}}); got != nil {
		t.Error("an id was entered twice")
	}

	// A campaign that lost its key lets nobody in, an empty key included.
	c.TestKey = ""
	if got, _ := enter(url.Values{}); got != nil {
		t.Error("an empty key opened a campaign without one")
	}
}
