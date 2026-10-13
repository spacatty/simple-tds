package engine

import (
	"context"
	"crypto/hmac"
	"log/slog"
	"time"
)

// A test campaign is a fork of a real one that only its owner can reach: it
// answers requests carrying its key and gives everyone else the 404 of a dead
// link. Whoever holds the key stands in for a clean first-time visitor, so a
// funnel can be walked from a developer's machine, as often as needed, without
// a fresh address and browser for every attempt. What it records belongs to
// the test campaign, which the reports leave out unless asked for it.

// testEntry is a request a test campaign lets in.
type testEntry struct {
	// clickID, at and stream belong to a click id issued in advance: the visit
	// takes that id and goes to the stream it was issued for. Without one the
	// campaign routes the visit and mints an id, as for any click.
	clickID string
	at      time.Time
	stream  *StreamRT
}

// stream finds one of the campaign's working streams by id.
func (c *CampaignRT) stream(id int64) *StreamRT {
	for _, list := range [][]*StreamRT{c.Forced, c.Regular, c.Default} {
		for _, s := range list {
			if s.ID == id {
				return s
			}
		}
	}
	return nil
}

// testEntry checks a request to a test campaign and returns nil for one that
// must not get in: no key, a wrong one, or a click id that is not an unused
// one of this campaign's pool.
func (e *Engine) testEntry(in *Input, snap *Snapshot) *testEntry {
	c, names := in.Campaign, snap.Params
	key, id := names.Get(in.Query, "key"), names.Get(in.Query, "click_id")
	// Neither is the visitor's: they must not end up in the click's parameters
	// or travel on to the offer with the rest of the query.
	for _, name := range []string{"key", "click_id"} {
		for _, n := range names.Names(name) {
			delete(in.Query, n)
		}
	}
	if c.TestKey == "" || !hmac.Equal([]byte(key), []byte(c.TestKey)) {
		return nil
	}
	if id == "" {
		return &testEntry{}
	}
	ref, err := e.parseClickID(id)
	if err != nil || int64(ref.CampaignID) != c.ID || !snap.testClicks[id] {
		return nil
	}
	st := c.stream(int64(ref.StreamID))
	if st == nil {
		return nil // the stream was deleted, disabled or broken since
	}
	// An id is entered once. The snapshot knows what was unused when it was
	// built; this covers the time until the next one.
	if seen, _ := e.testUsed.ContainsOrAdd(id, struct{}{}); seen {
		return nil
	}
	e.markTestClick(id)
	return &testEntry{clickID: id, at: ref.At, stream: st}
}

// markTestClick records that an issued id was entered. Like the click itself
// it is written behind the request, not by it.
func (e *Engine) markTestClick(id string) {
	if e.Store == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := e.Store.UseTestClick(ctx, id); err != nil {
			slog.Warn("test click not marked as used", "err", err)
		}
	}()
}

// IssueClickID mints a click id of a campaign's stream ahead of any visit.
func (e *Engine) IssueClickID(campaignID, streamID int64) string {
	return e.newClickID(time.Now(), campaignID, streamID)
}
