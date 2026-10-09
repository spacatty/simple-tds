package web

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"

	"simpletds/internal/model"
	"simpletds/internal/store"
)

// Dashboards are personal: even an admin sees and changes only their own.
// They are not part of the engine's configuration, so nothing here reloads it.

const (
	maxDashboards  = 20
	maxDashWidgets = 40
	minDashHeight  = 100
	maxDashHeight  = 1200
)

var (
	dashWidths = map[string]int{"stat": 3, "chart": 6, "funnel": 6, "top": 4, "domains": 4}
	reDashWord = regexp.MustCompile(`^[a-z0-9_]{0,32}$`)
)

func validateDashboard(d *model.Dashboard) error {
	d.Name = strings.TrimSpace(d.Name)
	switch {
	case d.Name == "":
		return bad("name is required")
	case len(d.Name) > 64:
		return bad("the name is too long")
	case len(d.Widgets) > maxDashWidgets:
		return bad(fmt.Sprintf("a dashboard can have at most %d widgets", maxDashWidgets))
	}
	seen := map[string]bool{}
	for i := range d.Widgets {
		w := &d.Widgets[i]
		def, ok := dashWidths[w.Type]
		if !ok {
			return bad("unknown widget type")
		}
		if w.Title = strings.TrimSpace(w.Title); len(w.Title) > 80 {
			return bad("the widget title is too long")
		}
		if !reDashWord.MatchString(w.Metric) || !reDashWord.MatchString(w.Dim) || w.CampaignID < 0 || w.StreamID < 0 {
			return bad("bad widget settings")
		}
		if w.W < 2 || w.W > 12 {
			w.W = def
		}
		if w.H != 0 {
			w.H = min(max(w.H, minDashHeight), maxDashHeight)
		}
		if len(w.ID) > 24 || w.ID == "" || seen[w.ID] {
			w.ID = randToken(6)
		}
		seen[w.ID] = true
	}
	return nil
}

func (s *Server) dashboardRoutes(r chi.Router) {
	mine := func(r *http.Request) ([]model.Dashboard, error) {
		rows, err := s.st.Pool.Query(r.Context(), "SELECT * FROM dashboards WHERE owner_id=$1 ORDER BY position, id", currentUser(r).ID)
		if err != nil {
			return nil, err
		}
		return collect[model.Dashboard](rows)
	}
	// Someone else's dashboard does not exist as far as the caller can tell.
	own := func(r *http.Request) (*model.Dashboard, error) {
		d, err := store.Get[model.Dashboard](r.Context(), s.st, "dashboards", pathID(r))
		if err != nil {
			return nil, err
		}
		if d.OwnerID != currentUser(r).ID {
			return nil, store.ErrNotFound
		}
		return d, nil
	}

	r.Get("/dashboards", handler(func(r *http.Request) (any, error) {
		list, err := mine(r)
		if list == nil {
			list = []model.Dashboard{}
		}
		return list, err
	}))
	r.Post("/dashboards", handler(func(r *http.Request) (any, error) {
		var d model.Dashboard
		if err := readJSON(r, &d); err != nil {
			return nil, err
		}
		list, err := mine(r)
		if err != nil {
			return nil, err
		}
		if len(list) >= maxDashboards {
			return nil, bad(fmt.Sprintf("you can have at most %d dashboards", maxDashboards))
		}
		d.OwnerID, d.Position = currentUser(r).ID, len(list)
		if err := validateDashboard(&d); err != nil {
			return nil, err
		}
		if err := store.Insert(r.Context(), s.st, "dashboards", &d); err != nil {
			return nil, err
		}
		return &d, nil
	}))
	r.Put("/dashboards/{id}", handler(func(r *http.Request) (any, error) {
		old, err := own(r)
		if err != nil {
			return nil, err
		}
		d := *old
		if err := readPatch(r, &d); err != nil {
			return nil, err
		}
		d.OwnerID = old.OwnerID
		if err := validateDashboard(&d); err != nil {
			return nil, err
		}
		if err := store.Update(r.Context(), s.st, "dashboards", old.ID, &d); err != nil {
			return nil, err
		}
		return &d, nil
	}))
	r.Delete("/dashboards/{id}", handler(func(r *http.Request) (any, error) {
		d, err := own(r)
		if err != nil {
			return nil, err
		}
		return nil, s.st.Delete(r.Context(), "dashboards", d.ID)
	}))
}
