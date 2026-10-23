package web

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"

	"simpletds/internal/model"
	"simpletds/internal/store"
)

// Copying configuration between campaigns: one stream into another campaign,
// or a campaign's funnel, settings and streams into an existing campaign.
// Every copy goes through validateStream as a new stream, so it is held to
// the same rules as one typed in by hand: edit access to the target, and
// whitepages, landings and target campaigns its owner may use.

func (s *Server) streamCopyRoutes(r chi.Router) {
	r.Post("/streams/{id}/copy", handler(s.streamCopy))
	r.Post("/campaigns/{id}/inherit", handler(s.campaignInherit))
}

// copyOf prepares a stream of another campaign to be inserted into this one.
func (s *Server) copyOf(ctx context.Context, st model.Stream, campaignID int64) (model.Stream, error) {
	weight := st.Weight
	st.ID, st.CampaignID, st.SourceID = 0, campaignID, nil
	if err := s.validateStream(ctx, &st, nil); err != nil {
		return st, err
	}
	st.Weight = weight // a weight of 0 is a choice here, not a missing value
	return st, nil
}

// streamCopy copies a stream to the end of its lane in a campaign the caller
// may edit. Reading the stream is enough to copy it.
func (s *Server) streamCopy(r *http.Request) (any, error) {
	var in struct {
		CampaignID int64 `json:"campaign_id"`
	}
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	ctx := r.Context()
	src, err := store.Get[model.Stream](ctx, s.st, "streams", pathID(r))
	if err != nil {
		return nil, err
	}
	if _, err := s.campaign(ctx, src.CampaignID, model.AccessRead); err != nil {
		return nil, err
	}
	if _, err := s.campaign(ctx, in.CampaignID, model.AccessEdit); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, bad("target campaign not found or not editable by you")
		}
		return nil, err
	}
	st, err := s.copyOf(ctx, *src, in.CampaignID)
	if err != nil {
		return nil, err
	}
	if err := store.Insert(ctx, s.st, "streams", &st); err != nil {
		return nil, err
	}
	return &st, s.reload(ctx)
}

// campaignInherit makes a campaign take its funnel and traffic settings, its
// streams, or both from another campaign. The name, link, domains, group,
// sharing and statistics stay the campaign's own. Streams are replaced, not
// merged: the copy is meant to behave like the source.
func (s *Server) campaignInherit(r *http.Request) (any, error) {
	var in struct {
		SourceID int64 `json:"source_id"`
		Settings bool  `json:"settings"`
		Streams  bool  `json:"streams"`
	}
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	if !in.Settings && !in.Streams {
		return nil, bad("choose what to take from the other campaign")
	}
	ctx := r.Context()
	c, err := s.campaign(ctx, pathID(r), model.AccessEdit)
	if err != nil {
		return nil, err
	}
	if c.Test {
		return nil, bad("a test campaign takes its configuration from its source: sync it instead")
	}
	if in.SourceID == c.ID {
		return nil, bad("choose another campaign")
	}
	src, err := s.campaign(ctx, in.SourceID, model.AccessRead)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, bad("source campaign not found")
		}
		return nil, err
	}
	before := *c
	if in.Settings {
		c.Rotation, c.CostModel, c.CostValue, c.Currency, c.UniqueHours = src.Rotation, src.CostModel, src.CostValue, src.Currency, src.UniqueHours
		c.Stages, c.FunnelPresetID, c.FunnelPresetRev = src.Stages, nil, 0
		// The funnel preset is its owner's: only the same owner keeps the link.
		if c.OwnerID == src.OwnerID {
			c.FunnelPresetID, c.FunnelPresetRev = src.FunnelPresetID, src.FunnelPresetRev
		}
		if err := store.Update(ctx, s.st, "campaigns", c.ID, c); err != nil {
			return nil, err
		}
	}
	// Landing streams are checked against the funnel stored above, so the
	// streams are validated after it and the funnel goes back if one fails.
	undo := func(err error) (any, error) {
		if in.Settings {
			store.Update(ctx, s.st, "campaigns", c.ID, &before)
		}
		return nil, err
	}
	if in.Streams {
		theirs, err := s.streamsOf(ctx, src.ID)
		if err != nil {
			return undo(err)
		}
		mine, err := s.streamsOf(ctx, c.ID)
		if err != nil {
			return undo(err)
		}
		copies := make([]model.Stream, 0, len(theirs))
		for i, st := range theirs {
			cp, err := s.copyOf(ctx, st, c.ID)
			if err != nil {
				if e, ok := err.(*apiError); ok {
					err = bad(fmt.Sprintf("stream %q: %s", st.Name, e.msg))
				}
				return undo(err)
			}
			cp.Position = i
			copies = append(copies, cp)
		}
		for _, st := range mine {
			if err := s.st.Delete(ctx, "streams", st.ID); err != nil {
				s.reload(ctx)
				return nil, err
			}
		}
		for _, st := range copies {
			if err := store.Insert(ctx, s.st, "streams", &st); err != nil {
				s.reload(ctx) // what was copied so far is already saved
				return nil, err
			}
		}
	}
	return c, s.reload(ctx)
}
