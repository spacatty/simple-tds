package web

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"simpletds/internal/events"
	"simpletds/internal/model"
	"simpletds/internal/store"
)

// Test campaigns: a fork of a campaign that answers only its own key, with a
// pool of click ids issued in advance. The runtime half is in
// internal/engine/testmode.go.

func (s *Server) testRoutes(r chi.Router) {
	r.Post("/campaigns/{id}/fork", handler(s.campaignFork))
	r.Post("/campaigns/{id}/sync", handler(s.campaignSync))
	r.Post("/campaigns/{id}/test-key", handler(s.testKeyRegenerate))
	r.Get("/campaigns/{id}/test-clicks", handler(s.testClicks))
	r.Post("/campaigns/{id}/test-clicks", handler(s.testClicksIssue))
	r.Post("/campaigns/{id}/test-clicks/clear", handler(s.testClicksClear))
	r.Delete("/campaigns/{id}/test-clicks/{click}", handler(s.testClickDelete))
}

func (s *Server) streamsOf(ctx context.Context, campaignID int64) ([]model.Stream, error) {
	rows, err := s.st.Pool.Query(ctx, "SELECT * FROM streams WHERE campaign_id=$1 ORDER BY position, id", campaignID)
	if err != nil {
		return nil, err
	}
	return collect[model.Stream](rows)
}

// forkHash sums up what a fork takes from its source: the settings that route
// and count traffic, the funnel and the streams. When it no longer matches
// the one kept at the last sync, the fork is outdated.
func forkHash(c *model.Campaign, streams []model.Stream) string {
	type stream struct {
		ID       int64
		Name     string
		Kind     string
		Position int
		Weight   int
		Enabled  bool
		FilterOp string
		Filters  []model.Filter
		Action   string
		Config   json.RawMessage
		JSCheck  bool
	}
	doc := struct {
		Rotation, CostModel string
		CostValue           float64
		Currency            string
		UniqueHours         int
		Stages              []model.Stage
		Streams             []stream
	}{c.Rotation, c.CostModel, c.CostValue, c.Currency, c.UniqueHours, c.Stages, nil}
	for _, st := range streams {
		doc.Streams = append(doc.Streams, stream{st.ID, st.Name, st.Kind, st.Position, st.Weight, st.Enabled,
			st.FilterOp, st.Filters, st.ActionType, st.ActionConfig, st.JSCheck})
	}
	sum := sha256.Sum256(mustMarshal(doc))
	return hex.EncodeToString(sum[:16])
}

// listCampaigns is the campaign list as its viewer sees it, with every fork
// told whether its source has moved on since the last sync.
func (s *Server) listCampaigns(ctx context.Context, all []model.Campaign) []model.Campaign {
	out := s.visibleCampaigns(ctx, all)
	byID := make(map[int64]*model.Campaign, len(all))
	for i := range all {
		byID[all[i].ID] = &all[i]
	}
	visible := map[int64]bool{}
	forks := false
	for _, c := range out {
		visible[c.ID] = true
		forks = forks || c.SourceID != nil
	}
	if !forks {
		return out
	}
	streams, err := store.List[model.Stream](ctx, s.st, "streams", "position, id")
	if err != nil {
		return out
	}
	bySource := map[int64][]model.Stream{}
	for _, st := range streams {
		bySource[st.CampaignID] = append(bySource[st.CampaignID], st)
	}
	for i := range out {
		c := &out[i]
		if c.SourceID == nil || byID[*c.SourceID] == nil {
			continue
		}
		src := byID[*c.SourceID]
		c.Outdated = forkHash(src, bySource[src.ID]) != byID[c.ID].SourceHash
		// The name of a campaign is for those who can see the campaign.
		if visible[src.ID] {
			c.SourceName = src.Name
		}
	}
	return out
}

// campaignFork copies a campaign and its streams into a test campaign of the
// caller's own, which remembers where every stream came from.
func (s *Server) campaignFork(r *http.Request) (any, error) {
	ctx := r.Context()
	src, err := s.campaign(ctx, pathID(r), model.AccessRead)
	if err != nil {
		return nil, err
	}
	if src.Test {
		return nil, bad("a test campaign cannot be forked: fork the campaign it tests")
	}
	streams, err := s.streamsOf(ctx, src.ID)
	if err != nil {
		return nil, err
	}
	c := *src
	c.Name, c.Alias, c.Token, c.Enabled = src.Name+" (test)", newAlias(), randToken(24), true
	c.OwnerID = currentUser(r).ID
	if c.OwnerID != src.OwnerID {
		c.GroupID = nil // the group is the original owner's, and so is the funnel preset
		c.FunnelPresetID, c.FunnelPresetRev = nil, 0
	}
	c.Test, c.TestKey, c.SourceID, c.SourceHash = true, randToken(24), &src.ID, forkHash(src, streams)
	if err := store.Insert(ctx, s.st, "campaigns", &c); err != nil {
		return nil, err
	}
	for _, st := range streams {
		from := st.ID
		st.CampaignID, st.SourceID = c.ID, &from
		if err := store.Insert(ctx, s.st, "streams", &st); err != nil {
			return nil, err
		}
	}
	return &c, s.reload(ctx)
}

// testCampaign loads a test campaign the caller may change.
func (s *Server) testCampaign(r *http.Request) (*model.Campaign, error) {
	c, err := s.campaign(r.Context(), pathID(r), model.AccessEdit)
	if err != nil {
		return nil, err
	}
	if !c.Test {
		return nil, bad("this is not a test campaign")
	}
	return c, nil
}

// campaignSync makes a fork equal to its source again. A stream that mirrors
// a source stream is updated in place, so the click ids issued for it and its
// statistics stay; streams the source does not have are removed.
func (s *Server) campaignSync(r *http.Request) (any, error) {
	ctx := r.Context()
	c, err := s.testCampaign(r)
	if err != nil {
		return nil, err
	}
	if c.SourceID == nil {
		return nil, bad("the campaign this one was forked from no longer exists")
	}
	src, err := s.campaign(ctx, *c.SourceID, model.AccessRead)
	if err != nil {
		return nil, bad("the source campaign is no longer shared with you")
	}
	theirs, err := s.streamsOf(ctx, src.ID)
	if err != nil {
		return nil, err
	}
	mine, err := s.streamsOf(ctx, c.ID)
	if err != nil {
		return nil, err
	}
	c.Rotation, c.CostModel, c.CostValue, c.Currency, c.UniqueHours = src.Rotation, src.CostModel, src.CostValue, src.Currency, src.UniqueHours
	c.Stages, c.FunnelPresetID, c.FunnelPresetRev = src.Stages, nil, 0
	if c.OwnerID == src.OwnerID {
		c.FunnelPresetID, c.FunnelPresetRev = src.FunnelPresetID, src.FunnelPresetRev
	}
	c.SourceHash = forkHash(src, theirs)
	if err := store.Update(ctx, s.st, "campaigns", c.ID, c); err != nil {
		return nil, err
	}
	mirror := map[int64]int64{} // source stream → the fork's copy of it
	for _, st := range mine {
		if st.SourceID != nil {
			mirror[*st.SourceID] = st.ID
		}
	}
	kept := map[int64]bool{}
	for _, st := range theirs {
		from := st.ID
		st.CampaignID, st.SourceID = c.ID, &from
		if id, ok := mirror[from]; ok {
			err, kept[id] = store.Update(ctx, s.st, "streams", id, &st), true
		} else {
			err = store.Insert(ctx, s.st, "streams", &st)
		}
		if err != nil {
			s.reload(ctx) // what was copied so far is already saved
			return nil, err
		}
	}
	for _, st := range mine {
		if !kept[st.ID] {
			if err := s.st.Delete(ctx, "streams", st.ID); err != nil {
				s.reload(ctx)
				return nil, err
			}
		}
	}
	return c, s.reload(ctx)
}

// testKeyRegenerate replaces the key of a test campaign. The old one stops
// working immediately.
func (s *Server) testKeyRegenerate(r *http.Request) (any, error) {
	c, err := s.testCampaign(r)
	if err != nil {
		return nil, err
	}
	c.TestKey = randToken(24)
	if _, err := s.st.Pool.Exec(r.Context(), "UPDATE campaigns SET test_key=$2 WHERE id=$1", c.ID, c.TestKey); err != nil {
		return nil, err
	}
	return c, s.reload(r.Context())
}

// ---- the pool of click ids --------------------------------------------------

type testClickRow struct {
	model.TestClick
	// Events are what arrived for the click so far, oldest first.
	Events []events.Row `json:"events"`
}

func (s *Server) testClickRows(ctx context.Context, campaignID int64) ([]model.TestClick, error) {
	rows, err := s.st.Pool.Query(ctx, "SELECT * FROM test_clicks WHERE campaign_id=$1 ORDER BY id DESC", campaignID)
	if err != nil {
		return nil, err
	}
	return collect[model.TestClick](rows)
}

func (s *Server) testClicks(r *http.Request) (any, error) {
	ctx := r.Context()
	// The ids convert like real clicks: they are for those who run the campaign.
	c, err := s.testCampaign(r)
	if err != nil {
		return nil, err
	}
	clicks, err := s.testClickRows(ctx, c.ID)
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(clicks))
	since := time.Now()
	for i, t := range clicks {
		ids[i] = t.ClickID
		if t.CreatedAt.Before(since) {
			since = t.CreatedAt
		}
	}
	evs, err := s.ev.ClickEvents(ctx, c.ID, ids, since)
	if err != nil {
		return nil, err
	}
	out := make([]testClickRow, len(clicks))
	for i, t := range clicks {
		out[i] = testClickRow{TestClick: t, Events: evs[t.ClickID]}
		if out[i].Events == nil {
			out[i].Events = []events.Row{}
		}
	}
	return map[string]any{"rows": out}, nil
}

const maxTestClickBatch = 50

// testClicksIssue mints click ids for one stream of a test campaign.
func (s *Server) testClicksIssue(r *http.Request) (any, error) {
	ctx := r.Context()
	var in struct {
		StreamID int64  `json:"stream_id"`
		Count    int    `json:"count"`
		Note     string `json:"note"`
	}
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	c, err := s.testCampaign(r)
	if err != nil {
		return nil, err
	}
	st, err := store.Get[model.Stream](ctx, s.st, "streams", in.StreamID)
	if err != nil || st.CampaignID != c.ID {
		return nil, bad("choose a stream of this campaign")
	}
	if !st.Enabled {
		return nil, bad("this stream is disabled: a click id issued for it could not be entered")
	}
	if in.Count < 1 {
		in.Count = 1
	}
	if in.Count > maxTestClickBatch {
		return nil, bad(fmt.Sprintf("at most %d click ids at a time", maxTestClickBatch))
	}
	var have int
	if err := s.st.Pool.QueryRow(ctx, "SELECT count(*) FROM test_clicks WHERE campaign_id=$1", c.ID).Scan(&have); err != nil {
		return nil, err
	}
	if have+in.Count > model.MaxTestClicks {
		return nil, conflict(fmt.Sprintf("a test campaign keeps at most %d click ids — delete the ones you no longer need", model.MaxTestClicks))
	}
	note := strings.TrimSpace(in.Note)
	if len(note) > 200 {
		return nil, bad("the note is too long")
	}
	out := make([]model.TestClick, 0, in.Count)
	for i := 0; i < in.Count; i++ {
		t := model.TestClick{CampaignID: c.ID, StreamID: st.ID, Note: note, ClickID: s.eng.IssueClickID(c.ID, st.ID)}
		if err := store.Insert(ctx, s.st, "test_clicks", &t); err != nil {
			s.reload(ctx) // the ids issued so far are already saved
			return nil, err
		}
		out = append(out, t)
	}
	return map[string]any{"rows": out}, s.reload(ctx)
}

func (s *Server) testClickDelete(r *http.Request) (any, error) {
	c, err := s.testCampaign(r)
	if err != nil {
		return nil, err
	}
	id, _ := strconv.ParseInt(chi.URLParam(r, "click"), 10, 64)
	tag, err := s.st.Pool.Exec(r.Context(), "DELETE FROM test_clicks WHERE id=$1 AND campaign_id=$2", id, c.ID)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, store.ErrNotFound
	}
	return nil, s.reload(r.Context())
}

// testClicksClear drops the ids that were already entered: they cannot be
// entered again, and what they recorded stays in the campaign's statistics.
func (s *Server) testClicksClear(r *http.Request) (any, error) {
	c, err := s.testCampaign(r)
	if err != nil {
		return nil, err
	}
	tag, err := s.st.Pool.Exec(r.Context(), "DELETE FROM test_clicks WHERE campaign_id=$1 AND used_at IS NOT NULL", c.ID)
	if err != nil {
		return nil, err
	}
	return map[string]int64{"deleted": tag.RowsAffected()}, nil
}
