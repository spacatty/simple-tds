package web

import (
	"context"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"simpletds/internal/engine"
	"simpletds/internal/model"
	"simpletds/internal/store"
)

// maxSuppress caps how many suppress rules one user may keep.
const maxSuppress = 20000

// suppressRoutes: every user keeps their own rules. Ownership is enforced by
// mount; the numbers and the log are always the caller's own, for
// administrators too.
func (s *Server) suppressRoutes(r chi.Router) {
	mount(s, r, "/suppress-rules", resource[model.SuppressRule]{table: "suppress_rules", order: "id DESC", validate: s.validateSuppress})
	r.Post("/suppress-rules/bulk", handler(s.suppressBulkAdd))
	r.Get("/suppress/{kind}/stats", handler(func(r *http.Request) (any, error) {
		kind, err := suppressKind(r)
		if err != nil {
			return nil, err
		}
		return s.ev.SuppressedStats(r.Context(), uint32(currentUser(r).ID), kind)
	}))
	r.Get("/suppress/{kind}/log", handler(func(r *http.Request) (any, error) {
		kind, err := suppressKind(r)
		if err != nil {
			return nil, err
		}
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		if limit <= 0 || limit > 500 {
			limit = 100
		}
		rows, total, err := s.ev.SuppressedLog(r.Context(), uint32(currentUser(r).ID), kind, limit, max(offset, 0))
		if err != nil {
			return nil, err
		}
		return map[string]any{"rows": rows, "total": total}, nil
	}))
	r.Post("/suppress/{kind}/clear", handler(func(r *http.Request) (any, error) {
		kind, err := suppressKind(r)
		if err != nil {
			return nil, err
		}
		return nil, s.ev.ClearSuppressed(r.Context(), uint32(currentUser(r).ID), kind)
	}))
}

func suppressKind(r *http.Request) (string, error) {
	kind := chi.URLParam(r, "kind")
	if !oneOf(kind, model.SuppressIP, model.SuppressReferer) {
		return "", bad("unknown kind of suppress rule")
	}
	return kind, nil
}

// suppressValue brings an address, a network or a referrer domain to the
// form it is stored in.
func suppressValue(kind, raw string) (string, error) {
	switch kind {
	case model.SuppressIP:
		p, value, err := engine.ParseSuppressIP(raw)
		if err != nil {
			return "", bad(err.Error())
		}
		if p.Bits() == 0 {
			return "", bad("a suppress rule cannot cover every address")
		}
		return value, nil
	case model.SuppressReferer:
		d, err := normalizeDomain(strings.TrimPrefix(strings.TrimSpace(raw), "*."))
		if err != nil {
			return "", bad(err.Error())
		}
		return d, nil
	}
	return "", bad("unknown kind of suppress rule")
}

// suppressCampaigns checks the campaigns a rule is narrowed to: the caller
// must be able to change each of them.
func (s *Server) suppressCampaigns(ctx context.Context, ids []int64) ([]int64, error) {
	out := []int64{}
	for _, id := range ids {
		if slices.Contains(out, id) {
			continue
		}
		if _, err := s.campaign(ctx, id, model.AccessEdit); err != nil {
			return nil, bad("pick campaigns you can edit")
		}
		out = append(out, id)
	}
	return out, nil
}

func (s *Server) validateSuppress(ctx context.Context, v *model.SuppressRule, old *model.SuppressRule) error {
	if old != nil {
		v.Kind = old.Kind // a rule keeps its kind, and its numbers with it
	}
	var err error
	if v.Value, err = suppressValue(v.Kind, v.Value); err != nil {
		return err
	}
	// Campaigns that were already there stay valid: the rule may outlive the
	// owner's access to one of them, and runtime ignores it from then on.
	var fresh []int64
	for _, id := range v.CampaignIDs {
		if old == nil || !slices.Contains(old.CampaignIDs, id) {
			fresh = append(fresh, id)
		}
	}
	if _, err := s.suppressCampaigns(ctx, fresh); err != nil {
		return err
	}
	v.CampaignIDs = slices.Compact(slices.Sorted(slices.Values(v.CampaignIDs)))
	if v.Store == "" {
		v.Store = model.SuppressCount
	}
	if !oneOf(v.Store, model.SuppressOff, model.SuppressCount, model.SuppressLog) {
		return bad("unknown way to keep suppressed requests")
	}
	if old == nil {
		return s.suppressRoom(ctx, v.OwnerID, 1)
	}
	return nil
}

func (s *Server) suppressRoom(ctx context.Context, owner int64, adding int) error {
	var n int
	if err := s.st.Pool.QueryRow(ctx, "SELECT count(*) FROM suppress_rules WHERE owner_id=$1", owner).Scan(&n); err != nil {
		return err
	}
	if n+adding > maxSuppress {
		return bad("a user can keep at most 20000 suppress rules")
	}
	return nil
}

// suppressBulkAdd adds many rules of one kind at once. Values the caller
// already suppresses for the same campaigns are skipped.
func (s *Server) suppressBulkAdd(r *http.Request) (any, error) {
	var in struct {
		Kind        string  `json:"kind"`
		Values      string  `json:"values"` // any separator: newline, comma, semicolon, space
		CampaignIDs []int64 `json:"campaign_ids"`
		Store       string  `json:"store"`
	}
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	if in.Store == "" {
		in.Store = model.SuppressCount
	}
	if !oneOf(in.Store, model.SuppressOff, model.SuppressCount, model.SuppressLog) {
		return nil, bad("unknown way to keep suppressed requests")
	}
	ctx, u := r.Context(), currentUser(r)
	campaigns, err := s.suppressCampaigns(ctx, in.CampaignIDs)
	if err != nil {
		return nil, err
	}
	slices.Sort(campaigns)
	all, err := store.List[model.SuppressRule](ctx, s.st, "suppress_rules", "id")
	if err != nil {
		return nil, err
	}
	have := map[string]bool{}
	for _, e := range all {
		if e.OwnerID == u.ID && e.Kind == in.Kind && slices.Equal(e.CampaignIDs, campaigns) {
			have[e.Value] = true
		}
	}
	var values []string
	for _, raw := range strings.FieldsFunc(in.Values, func(c rune) bool { return c == '\n' || c == '\r' || c == ',' || c == ';' || c == ' ' || c == '\t' }) {
		value, err := suppressValue(in.Kind, raw)
		if err != nil {
			return nil, err
		}
		if !have[value] {
			have[value] = true
			values = append(values, value)
		}
	}
	if err := s.suppressRoom(ctx, u.ID, len(values)); err != nil {
		return nil, err
	}
	for _, value := range values {
		rule := model.SuppressRule{OwnerID: u.ID, Kind: in.Kind, Value: value, CampaignIDs: campaigns, Store: in.Store}
		if err := store.Insert(ctx, s.st, "suppress_rules", &rule); err != nil {
			return nil, err
		}
	}
	return map[string]int{"added": len(values)}, s.reload(ctx)
}
