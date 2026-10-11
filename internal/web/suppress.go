package web

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"simpletds/internal/engine"
	"simpletds/internal/events"
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

// bannedSets hands a report the viewer's own suppress rules, so that traffic a
// source sent before it was suppressed can be left out as well. Like the
// click path, a rule without campaigns covers what its owner owns and a rule
// naming campaigns covers those; the report's scope still decides which of
// them the viewer sees at all.
func (s *Server) bannedSets(ctx context.Context, owner int64, q *events.Query) error {
	if q.Banned == "all" {
		return nil
	}
	rows, err := s.st.Pool.Query(ctx, "SELECT kind, value, campaign_ids FROM suppress_rules WHERE owner_id=$1 ORDER BY id", owner)
	if err != nil {
		return err
	}
	defer rows.Close()
	sets := map[string]*events.BannedSet{}
	var order []string
	for rows.Next() {
		var kind, value string
		var ids []int64
		if err := rows.Scan(&kind, &value, &ids); err != nil {
			return err
		}
		key := fmt.Sprint(ids)
		set := sets[key]
		if set == nil {
			set = &events.BannedSet{}
			for _, id := range ids {
				set.Campaigns = append(set.Campaigns, uint32(id))
			}
			sets[key] = set
			order = append(order, key)
		}
		switch kind {
		case model.SuppressIP:
			p, _, err := engine.ParseSuppressIP(value)
			switch {
			case err != nil:
			case p.IsSingleIP():
				set.IPs = append(set.IPs, p.Addr().String())
			default:
				set.Nets = append(set.Nets, p.String())
			}
		case model.SuppressReferer:
			set.Refs = append(set.Refs, strings.ToLower(value))
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(order) == 0 {
		return nil
	}
	// The rules without campaigns: everything the viewer owns.
	if everywhere := sets[fmt.Sprint([]int64(nil))]; everywhere != nil {
		own, err := s.st.Pool.Query(ctx, "SELECT id FROM campaigns WHERE owner_id=$1", owner)
		if err != nil {
			return err
		}
		defer own.Close()
		for own.Next() {
			var id int64
			if err := own.Scan(&id); err != nil {
				return err
			}
			everywhere.Campaigns = append(everywhere.Campaigns, uint32(id))
		}
		if err := own.Err(); err != nil {
			return err
		}
	}
	for _, key := range order {
		q.BannedSets = append(q.BannedSets, *sets[key])
	}
	return nil
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
