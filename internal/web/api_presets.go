package web

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"simpletds/internal/model"
	"simpletds/internal/store"
)

// Funnel presets are personal, like dashboards: a set of stages its owner
// copies into campaigns. A campaign keeps the copy, so nothing here reloads
// the engine; it only remembers which preset, and which revision of it, the
// copy was made from.

const maxFunnelPresets = 100

func validateFunnelPreset(p *model.FunnelPreset) error {
	p.Name, p.Note = strings.TrimSpace(p.Name), strings.TrimSpace(p.Note)
	switch {
	case p.Name == "":
		return bad("name is required")
	case len(p.Name) > 64:
		return bad("the name is too long")
	case len(p.Note) > 500:
		return bad("the note is too long")
	case len(p.Stages) == 0:
		return bad("a preset needs at least one stage")
	}
	// The same rules as a campaign's own funnel; the slice is shared, so the
	// normalised stages land in the preset.
	return validateStages(&model.Campaign{Stages: p.Stages})
}

// ownFunnelPreset loads a preset of the given user. Someone else's does not
// exist as far as the caller can tell.
func (s *Server) ownFunnelPreset(ctx context.Context, id, userID int64) (*model.FunnelPreset, error) {
	p, err := store.Get[model.FunnelPreset](ctx, s.st, "funnel_presets", id)
	if err != nil {
		return nil, err
	}
	if p.OwnerID != userID {
		return nil, store.ErrNotFound
	}
	return p, nil
}

// checkFunnelPreset keeps a campaign's note of its preset honest: a preset
// can only be named by its owner. A note that was already there stays, so
// someone the campaign is shared with can save it without losing the link.
func (s *Server) checkFunnelPreset(ctx context.Context, c, old *model.Campaign) error {
	if c.FunnelPresetID == nil {
		c.FunnelPresetRev = 0
		return nil
	}
	if old != nil && old.FunnelPresetID != nil && *old.FunnelPresetID == *c.FunnelPresetID {
		return nil
	}
	if _, err := s.ownFunnelPreset(ctx, *c.FunnelPresetID, userFrom(ctx).ID); err != nil {
		return bad("funnel preset not found")
	}
	return nil
}

func (s *Server) funnelPresetRoutes(r chi.Router) {
	mine := func(r *http.Request) ([]model.FunnelPreset, error) {
		rows, err := s.st.Pool.Query(r.Context(), "SELECT * FROM funnel_presets WHERE owner_id=$1 ORDER BY name, id", currentUser(r).ID)
		if err != nil {
			return nil, err
		}
		return collect[model.FunnelPreset](rows)
	}
	own := func(r *http.Request) (*model.FunnelPreset, error) {
		return s.ownFunnelPreset(r.Context(), pathID(r), currentUser(r).ID)
	}

	r.Get("/funnel-presets", handler(func(r *http.Request) (any, error) {
		list, err := mine(r)
		if list == nil {
			list = []model.FunnelPreset{}
		}
		return list, err
	}))
	r.Post("/funnel-presets", handler(func(r *http.Request) (any, error) {
		var p model.FunnelPreset
		if err := readJSON(r, &p); err != nil {
			return nil, err
		}
		list, err := mine(r)
		if err != nil {
			return nil, err
		}
		if len(list) >= maxFunnelPresets {
			return nil, bad(fmt.Sprintf("you can have at most %d funnel presets", maxFunnelPresets))
		}
		p.OwnerID, p.Rev = currentUser(r).ID, 1
		if err := validateFunnelPreset(&p); err != nil {
			return nil, err
		}
		if err := store.Insert(r.Context(), s.st, "funnel_presets", &p); err != nil {
			return nil, err
		}
		return &p, nil
	}))
	r.Put("/funnel-presets/{id}", handler(func(r *http.Request) (any, error) {
		old, err := own(r)
		if err != nil {
			return nil, err
		}
		before, _ := json.Marshal(old.Stages)
		p := *old
		if err := readPatch(r, &p); err != nil {
			return nil, err
		}
		p.OwnerID, p.Rev = old.OwnerID, old.Rev
		if err := validateFunnelPreset(&p); err != nil {
			return nil, err
		}
		// A new revision only when the stages changed: that is what campaigns
		// copied, and what they are offered to update.
		if after, _ := json.Marshal(p.Stages); string(after) != string(before) {
			p.Rev++
		}
		if err := store.Update(r.Context(), s.st, "funnel_presets", old.ID, &p); err != nil {
			return nil, err
		}
		return &p, nil
	}))
	r.Delete("/funnel-presets/{id}", handler(func(r *http.Request) (any, error) {
		p, err := own(r)
		if err != nil {
			return nil, err
		}
		// Campaigns keep their stages and forget where they came from.
		return nil, s.st.Delete(r.Context(), "funnel_presets", p.ID)
	}))
}
