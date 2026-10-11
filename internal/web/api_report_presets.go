package web

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"

	"simpletds/internal/model"
	"simpletds/internal/store"
)

// Report presets are personal, like dashboards: a row is its owner's alone,
// admins included. A preset is only a saved address of the report constructor,
// so opening one runs the usual report queries with the usual scope, and
// nothing here reloads the engine.

const (
	maxReportPresets     = 50
	maxReportPresetQuery = 4000
)

func validateReportPreset(p *model.ReportPreset) error {
	p.Name = strings.TrimSpace(p.Name)
	p.Query = strings.TrimPrefix(strings.TrimSpace(p.Query), "?")
	switch {
	case p.Name == "":
		return bad("name is required")
	case len(p.Name) > 64:
		return bad("the name is too long")
	case len(p.Query) > maxReportPresetQuery:
		return bad("this report has too many filters to be saved")
	}
	if _, err := url.ParseQuery(p.Query); err != nil {
		return bad("bad report address")
	}
	return nil
}

func (s *Server) reportPresetRoutes(r chi.Router) {
	mine := func(r *http.Request) ([]model.ReportPreset, error) {
		rows, err := s.st.Pool.Query(r.Context(), "SELECT * FROM report_presets WHERE owner_id=$1 ORDER BY lower(name), id", currentUser(r).ID)
		if err != nil {
			return nil, err
		}
		return collect[model.ReportPreset](rows)
	}
	// Someone else's preset does not exist as far as the caller can tell.
	own := func(r *http.Request) (*model.ReportPreset, error) {
		p, err := store.Get[model.ReportPreset](r.Context(), s.st, "report_presets", pathID(r))
		if err != nil {
			return nil, err
		}
		if p.OwnerID != currentUser(r).ID {
			return nil, store.ErrNotFound
		}
		return p, nil
	}

	r.Get("/report-presets", handler(func(r *http.Request) (any, error) { return mine(r) }))
	r.Post("/report-presets", handler(func(r *http.Request) (any, error) {
		p := model.ReportPreset{Pinned: true}
		if err := readJSON(r, &p); err != nil {
			return nil, err
		}
		list, err := mine(r)
		if err != nil {
			return nil, err
		}
		if len(list) >= maxReportPresets {
			return nil, bad(fmt.Sprintf("you can have at most %d report presets", maxReportPresets))
		}
		p.ID, p.OwnerID = 0, currentUser(r).ID
		if err := validateReportPreset(&p); err != nil {
			return nil, err
		}
		if err := store.Insert(r.Context(), s.st, "report_presets", &p); err != nil {
			return nil, err
		}
		return &p, nil
	}))
	r.Put("/report-presets/{id}", handler(func(r *http.Request) (any, error) {
		old, err := own(r)
		if err != nil {
			return nil, err
		}
		p := *old
		if err := readPatch(r, &p); err != nil {
			return nil, err
		}
		p.OwnerID = old.OwnerID
		if err := validateReportPreset(&p); err != nil {
			return nil, err
		}
		if err := store.Update(r.Context(), s.st, "report_presets", old.ID, &p); err != nil {
			return nil, err
		}
		return &p, nil
	}))
	r.Delete("/report-presets/{id}", handler(func(r *http.Request) (any, error) {
		p, err := own(r)
		if err != nil {
			return nil, err
		}
		return nil, s.st.Delete(r.Context(), "report_presets", p.ID)
	}))
}
