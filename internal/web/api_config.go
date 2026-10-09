package web

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"golang.org/x/net/idna"

	"simpletds/internal/antibot"
	"simpletds/internal/engine"
	"simpletds/internal/events"
	"simpletds/internal/model"
	"simpletds/internal/store"
)

// resource wires list/create/update/delete for one table.
//
// By default rows belong to their creator (model.Owned): lists show only the
// caller's rows, and changes need ownership. Admins bypass both.
type resource[T any] struct {
	table string
	order string
	// validate normalises and checks v; old is nil on create.
	validate func(ctx context.Context, v *T, old *T) error
	// canDelete may veto a delete.
	canDelete func(ctx context.Context, old *T) error
	// changed runs after any successful change.
	changed func(ctx context.Context, id int64, deleted bool)
	// created runs once after a row is inserted, before the reload.
	created func(ctx context.Context, v *T)
	// adminOnly: admins only, even for reading. adminWrite: anyone reads
	// (see public), admins change.
	adminOnly, adminWrite bool
	// public lists every row to every user.
	public bool
	// visible replaces the ownership filter on lists.
	visible func(ctx context.Context, items []T) []T
	// writable / deletable replace the ownership check on update / delete.
	// deletable falls back to writable.
	writable  func(ctx context.Context, old *T) error
	deletable func(ctx context.Context, old *T) error
}

var errAdminOnly = &apiError{http.StatusForbidden, "administrators only"}

func mount[T any](s *Server, r chi.Router, path string, res resource[T]) {
	after := func(ctx context.Context, id int64, deleted bool) error {
		if res.changed != nil {
			res.changed(ctx, id, deleted)
		}
		return s.reload(ctx)
	}
	// load fetches the row for a change and enforces who may make it.
	load := func(r *http.Request, del bool) (*T, error) {
		ctx := r.Context()
		if (res.adminOnly || res.adminWrite) && !userFrom(ctx).IsAdmin() {
			return nil, errAdminOnly
		}
		old, err := store.Get[T](ctx, s.st, res.table, pathID(r))
		if err != nil {
			return nil, err
		}
		check := res.writable
		if del && res.deletable != nil {
			check = res.deletable
		}
		switch {
		case check != nil:
			err = check(ctx, old)
		case !res.adminOnly && !res.adminWrite && !owns(userFrom(ctx), old):
			err = store.ErrNotFound
		}
		return old, err
	}
	r.Get(path, handler(func(r *http.Request) (any, error) {
		ctx := r.Context()
		if res.adminOnly && !userFrom(ctx).IsAdmin() {
			return nil, errAdminOnly
		}
		items, err := store.List[T](ctx, s.st, res.table, res.order)
		switch {
		case err != nil:
			return nil, err
		case res.visible != nil:
			return res.visible(ctx, items), nil
		case res.public || res.adminOnly:
			return items, nil
		}
		return visibleOwned(ctx, items), nil
	}))
	r.Post(path, handler(func(r *http.Request) (any, error) {
		ctx := r.Context()
		if (res.adminOnly || res.adminWrite) && !userFrom(ctx).IsAdmin() {
			return nil, errAdminOnly
		}
		var v T
		if err := readJSON(r, &v); err != nil {
			return nil, err
		}
		if o, ok := any(&v).(model.Owned); ok {
			o.SetOwner(userFrom(ctx).ID)
		}
		if err := res.validate(ctx, &v, nil); err != nil {
			return nil, err
		}
		if err := store.Insert(ctx, s.st, res.table, &v); err != nil {
			return nil, err
		}
		if res.created != nil {
			res.created(ctx, &v)
		}
		return &v, after(ctx, idOf(&v), false)
	}))
	r.Put(path+"/{id}", handler(func(r *http.Request) (any, error) {
		old, err := load(r, false)
		if err != nil {
			return nil, err
		}
		v := *old // omitted fields keep their stored value
		if err := readPatch(r, &v); err != nil {
			return nil, err
		}
		if o, ok := any(&v).(model.Owned); ok {
			o.SetOwner(any(old).(model.Owned).Owner()) // ownership is not editable
		}
		if err := res.validate(r.Context(), &v, old); err != nil {
			return nil, err
		}
		if err := store.Update(r.Context(), s.st, res.table, pathID(r), &v); err != nil {
			return nil, err
		}
		return &v, after(r.Context(), pathID(r), false)
	}))
	r.Delete(path+"/{id}", handler(func(r *http.Request) (any, error) {
		old, err := load(r, true)
		if err != nil {
			return nil, err
		}
		if res.canDelete != nil {
			if err := res.canDelete(r.Context(), old); err != nil {
				return nil, err
			}
		}
		if err := s.st.Delete(r.Context(), res.table, pathID(r)); err != nil {
			return nil, err
		}
		return nil, after(r.Context(), pathID(r), true)
	}))
}

// readPatch decodes a partial update over v. Fields absent from the body keep
// their value; maps and slices that are present replace the old ones outright
// (plain decoding would merge into the old map and reuse the old slice or pointer).
func readPatch(r *http.Request, v any) error {
	body, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, 4<<20))
	if err != nil {
		return bad("request too large")
	}
	var present map[string]json.RawMessage
	if err := json.Unmarshal(body, &present); err != nil {
		return bad("invalid JSON: " + err.Error())
	}
	rv := reflect.ValueOf(v).Elem()
	for i := 0; i < rv.NumField(); i++ {
		name, _, _ := strings.Cut(rv.Type().Field(i).Tag.Get("json"), ",")
		if _, ok := present[name]; !ok {
			continue
		}
		// Pointers too: v starts as a shallow copy of the stored row, and decoding
		// through a shared pointer would rewrite that row as well, hiding the
		// change from every "did this field change" check.
		if f := rv.Field(i); f.Kind() == reflect.Map || f.Kind() == reflect.Slice || f.Kind() == reflect.Pointer {
			f.Set(reflect.Zero(f.Type()))
		}
	}
	if err := json.Unmarshal(body, v); err != nil {
		return bad("invalid JSON: " + err.Error())
	}
	return nil
}

// idOf reads the ID field every model struct has.
func idOf(v any) int64 {
	switch t := v.(type) {
	case *model.Domain:
		return t.ID
	case *model.DomainGroup:
		return t.ID
	case *model.Campaign:
		return t.ID
	case *model.CampaignGroup:
		return t.ID
	case *model.Stream:
		return t.ID
	case *model.ConvKey:
		return t.ID
	case *model.StreamPreset:
		return t.ID
	case *model.GeoPreset:
		return t.ID
	case *model.IPList:
		return t.ID
	case *model.Integration:
		return t.ID
	}
	return 0
}

func oneOf(v string, allowed ...string) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}

var (
	reHost = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$`)
)

// normalizeDomain accepts what people paste: URLs, upper case, IDN, trailing dots.
func normalizeDomain(raw string) (string, error) {
	s := strings.TrimSpace(strings.ToLower(raw))
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	s, _, _ = strings.Cut(s, "/")
	s, _, _ = strings.Cut(s, ":")
	s = strings.Trim(s, ".")
	ascii, err := idna.Lookup.ToASCII(s)
	if err != nil || !reHost.MatchString(ascii) {
		return "", fmt.Errorf("%q is not a valid domain name", strings.TrimSpace(raw))
	}
	return ascii, nil
}

// newAlias returns a 33-character random campaign alias that starts with a
// letter or digit.
func newAlias() string {
	for {
		a := randToken(25)[:33]
		if c := a[0]; c != '-' && c != '_' {
			return a
		}
	}
}

// Filters of the stream every new campaign starts with: anything that looks
// automated, repeated or off-target is stopped before the real streams.
var junkFilters = []model.Filter{
	{Type: "bot", Mode: "is", Values: []string{}},
	{Type: "unique", Mode: "is_not", Values: []string{}},
	{Type: "empty_referer", Mode: "is", Values: []string{}},
	{Type: "datacenter", Mode: "is", Values: []string{}},
	{Type: "empty_language", Mode: "is", Values: []string{}},
	{Type: "device_type", Mode: "is_not", Values: []string{"desktop"}},
}

var stop404 = json.RawMessage(`{"code":404}`)

// builtinPresets are offered next to the user's own presets.
var builtinPresets = []model.StreamPreset{
	{Name: "Strict traffic filter", Kind: "filters", Builtin: true,
		Data: mustMarshal(map[string]any{"filter_op": "or", "filters": junkFilters})},
	{Name: "Bots and datacenters only", Kind: "filters", Builtin: true,
		Data: mustMarshal(map[string]any{"filter_op": "or", "filters": []model.Filter{junkFilters[0], junkFilters[3]}})},
	{Name: "Stop (404)", Kind: "action", Builtin: true,
		Data: mustMarshal(map[string]any{"action_type": "status", "action_config": stop404})},
}

// seedStreams gives a new campaign a working funnel to edit: a forced filter
// stream and a fallback, both answering 404 until pointed at a whitepage.
func (s *Server) seedStreams(ctx context.Context, c *model.Campaign) {
	for i, st := range []model.Stream{
		{Name: "Traffic filter", Kind: model.StreamForced, FilterOp: "or", Filters: junkFilters},
		{Name: "Fallback", Kind: model.StreamDefault, FilterOp: "and", Filters: []model.Filter{}},
	} {
		st.CampaignID, st.Position, st.Weight, st.Enabled = c.ID, i, 100, true
		st.ActionType, st.ActionConfig = "status", stop404
		if err := store.Insert(ctx, s.st, "streams", &st); err != nil {
			slog.Warn("default stream not created", "campaign", c.Name, "err", err)
		}
	}
}

func (s *Server) validatePreset(_ context.Context, p *model.StreamPreset, _ *model.StreamPreset) error {
	if p.Name = strings.TrimSpace(p.Name); p.Name == "" {
		return bad("name is required")
	}
	switch p.Kind {
	case "filters":
		var d struct {
			FilterOp string         `json:"filter_op"`
			Filters  []model.Filter `json:"filters"`
		}
		if json.Unmarshal(p.Data, &d) != nil || len(d.Filters) == 0 {
			return bad("a filter preset needs at least one filter")
		}
		if !oneOf(d.FilterOp, "and", "or") {
			d.FilterOp = "and"
		}
		if err := engine.ValidateFilters(d.Filters); err != nil {
			return bad(err.Error())
		}
		p.Data = mustMarshal(d)
	case "action":
		var d struct {
			ActionType   string          `json:"action_type"`
			ActionConfig json.RawMessage `json:"action_config"`
		}
		if json.Unmarshal(p.Data, &d) != nil || d.ActionType == "" {
			return bad("an action preset needs an action")
		}
		if err := s.eng.ValidateStream(&model.Stream{ActionType: d.ActionType, ActionConfig: d.ActionConfig}); err != nil {
			return bad(err.Error())
		}
		p.Data = mustMarshal(d)
	default:
		return bad("kind must be filters or action")
	}
	return nil
}

// campaignNewAlias replaces a campaign's public link. The old one stops
// working immediately.
func (s *Server) campaignNewAlias(r *http.Request) (any, error) {
	c, err := s.campaign(r.Context(), pathID(r), model.AccessEdit)
	if err != nil {
		return nil, err
	}
	if _, err := s.st.Pool.Exec(r.Context(), "UPDATE campaigns SET alias=$2 WHERE id=$1", c.ID, newAlias()); err != nil {
		return nil, err
	}
	if err := s.reload(r.Context()); err != nil {
		return nil, err
	}
	return store.Get[model.Campaign](r.Context(), s.st, "campaigns", c.ID)
}

// wouldLockOut reports whether, with ip:port access off, removing the given
// domain's panel role would leave no way into the panel.
func (s *Server) wouldLockOut(ctx context.Context, losingID int64) bool {
	snap := s.eng.Snap()
	if snap.Settings.PanelIPAccess {
		return false
	}
	domains, err := store.List[model.Domain](ctx, s.st, "domains", "id")
	if err != nil {
		return true
	}
	for _, d := range domains {
		if d.ID != losingID && d.Enabled && d.AdminEnabled && d.Status == "ok" {
			return false
		}
	}
	return true
}

const lockoutMsg = "this is the only verified domain serving the panel and ip:port access is off — enable ip:port access in Settings first"

func (s *Server) validateDomain(ctx context.Context, d *model.Domain, old *model.Domain) error {
	name, err := normalizeDomain(d.Name)
	if err != nil {
		return bad(err.Error())
	}
	d.Name = name
	if d.TLSMode == "" {
		d.TLSMode = model.TLSAuto
	}
	if d.IPSource == "" {
		d.IPSource = model.IPDirect
	}
	if !oneOf(d.TLSMode, model.TLSAuto, model.TLSProxy) {
		return bad("tls_mode must be auto or proxy")
	}
	if !oneOf(d.IPSource, model.IPDirect, model.IPCF, model.IPXFF, model.IPXReal) {
		return bad("unknown ip_source")
	}
	u := userFrom(ctx)
	// The default campaign and group must be the caller's to use.
	if d.CampaignID != nil && (old == nil || old.CampaignID == nil || *old.CampaignID != *d.CampaignID) {
		if _, err := s.campaign(ctx, *d.CampaignID, model.AccessEdit); err != nil {
			return bad("campaign not found or not editable by you")
		}
	}
	if d.GroupID != nil && (old == nil || old.GroupID == nil || *old.GroupID != *d.GroupID) {
		if _, err := ownedGet[model.DomainGroup](ctx, s, "domain_groups", *d.GroupID); err != nil {
			return bad("group not found")
		}
	}
	// A panel domain is an entrance to the whole system.
	if !u.IsAdmin() && d.AdminEnabled != (old != nil && old.AdminEnabled) {
		return &apiError{http.StatusForbidden, "only administrators can change panel access on a domain"}
	}
	if old == nil {
		d.Status, d.StatusMsg, d.CheckedAt = "pending", "", nil
		return nil
	}
	// Status is owned by the checker.
	d.Status, d.StatusMsg, d.CheckedAt = old.Status, old.StatusMsg, old.CheckedAt
	if old.Name != d.Name || old.TLSMode != d.TLSMode {
		d.Status, d.StatusMsg = "pending", ""
	}
	losing := old.AdminEnabled && old.Status == "ok" && (!d.AdminEnabled || !d.Enabled || d.Status != "ok")
	if losing && s.wouldLockOut(ctx, old.ID) {
		return conflict(lockoutMsg)
	}
	return nil
}

func (s *Server) validateCampaign(ctx context.Context, c *model.Campaign, old *model.Campaign) error {
	c.Name = strings.TrimSpace(c.Name)
	if c.Name == "" {
		return bad("name is required")
	}
	if err := s.checkCampaignGroup(ctx, c, old); err != nil {
		return err
	}
	// The alias is the public campaign link. It is always generated, so it
	// cannot be guessed or enumerated; use "regenerate" to replace it.
	if old == nil {
		c.Alias = newAlias()
	} else {
		c.Alias = old.Alias
	}
	if c.Rotation == "" {
		c.Rotation = "position"
	}
	if c.CostModel == "" {
		c.CostModel = "none"
	}
	if c.Currency == "" {
		c.Currency = "USD"
	}
	if !oneOf(c.Rotation, "position", "weight") {
		return bad("rotation must be position or weight")
	}
	if !oneOf(c.CostModel, model.CostModels...) {
		return bad("unknown cost model")
	}
	if c.CostValue < 0 {
		return bad("cost cannot be negative")
	}
	if c.UniqueHours <= 0 {
		c.UniqueHours = 24
	}
	if err := validateStages(c); err != nil {
		return err
	}
	if old == nil {
		c.Token = randToken(24)
	} else {
		c.Token = old.Token
	}
	return nil
}

// validateStages normalises the campaign's conversion funnel.
func validateStages(c *model.Campaign) error {
	if len(c.Stages) > model.MaxStages {
		return bad(fmt.Sprintf("a funnel can have at most %d stages", model.MaxStages))
	}
	seen := map[string]bool{}
	goals := 0
	for i := range c.Stages {
		st := &c.Stages[i]
		st.Key = strings.ToLower(strings.TrimSpace(st.Key))
		st.Name = strings.TrimSpace(st.Name)
		switch {
		case !events.ValidStageKey(st.Key):
			return bad(fmt.Sprintf("stage %d: the key is what postbacks send as type — 1-32 lowercase letters, digits or _", i+1))
		case st.Key == model.TypeRejected:
			return bad(`"rejected" is reserved for declined conversions and cannot be a stage`)
		case seen[st.Key]:
			return bad(fmt.Sprintf("stage key %q is used twice", st.Key))
		case len(st.Name) > 64:
			return bad(fmt.Sprintf("stage %q: the name is too long", st.Key))
		case st.Goal && st.Public:
			return bad(fmt.Sprintf("stage %q: the goal cannot be reported from the browser — anyone holding a click id could trigger it", st.Key))
		}
		if st.Name == "" {
			st.Name = st.Key
		}
		seen[st.Key] = true
		if st.Goal {
			goals++
		}
	}
	if goals > 1 {
		return bad("only one stage can be the goal")
	}
	// Without an explicit goal the end of the funnel is the conversion.
	if n := len(c.Stages); goals == 0 && n > 0 {
		if c.Stages[n-1].Public {
			return bad("mark the stage that counts as the conversion as the goal")
		}
		c.Stages[n-1].Goal = true
	}
	return nil
}

func (s *Server) validateStream(ctx context.Context, st *model.Stream, old *model.Stream) error {
	st.Name = strings.TrimSpace(st.Name)
	if st.Name == "" {
		return bad("name is required")
	}
	if old != nil {
		st.CampaignID = old.CampaignID
	} else {
		if _, err := s.campaign(ctx, st.CampaignID, model.AccessEdit); err != nil {
			return err
		}
		if st.Weight == 0 {
			st.Weight = 100
		}
		// New streams go to the end of the funnel.
		s.st.Pool.QueryRow(ctx, "SELECT coalesce(max(position)+1, 0) FROM streams WHERE campaign_id=$1", st.CampaignID).Scan(&st.Position)
	}
	if st.Kind == "" {
		st.Kind = model.StreamRegular
	}
	if st.FilterOp == "" {
		st.FilterOp = "and"
	}
	if !oneOf(st.Kind, model.StreamForced, model.StreamRegular, model.StreamDefault) {
		return bad("kind must be forced, regular or default")
	}
	if !oneOf(st.FilterOp, "and", "or") {
		return bad("filter_op must be and or or")
	}
	if st.Weight < 0 || st.Weight > 100000 {
		return bad("weight must be 0-100000")
	}
	for i := range st.Filters {
		if st.Filters[i].Mode != "is_not" {
			st.Filters[i].Mode = "is"
		}
		if st.Filters[i].Values == nil {
			st.Filters[i].Values = []string{}
		}
		if st.Filters[i].Type == "country" {
			for j, c := range st.Filters[i].Values {
				st.Filters[i].Values[j] = strings.ToUpper(strings.TrimSpace(c))
			}
		}
	}
	if err := s.eng.ValidateStream(st); err != nil {
		return bad(err.Error())
	}
	return s.checkActionRefs(ctx, st, old)
}

func (s *Server) validateKey(_ context.Context, k *model.ConvKey, old *model.ConvKey) error {
	k.Name = strings.TrimSpace(k.Name)
	if k.Name == "" {
		return bad("name is required")
	}
	if old == nil {
		k.Key = randToken(24)
	} else {
		k.Key = old.Key
	}
	if k.Attribution == "" {
		k.Attribution = model.AttrClickID
	}
	if !oneOf(k.Attribution, model.AttrClickID, model.AttrIP, model.AttrNone) {
		return bad("unknown attribution mode")
	}
	if k.Attribution == model.AttrNone {
		k.RequireClick = false
	}
	if k.DefaultType == "" {
		k.DefaultType = "lead"
	}
	if !oneOf(k.DefaultType, model.ConversionTypes...) {
		return bad("unknown conversion type")
	}
	if k.RequireSig && k.Secret == "" {
		k.Secret = randToken(32)
	}
	if k.WindowHours <= 0 {
		k.WindowHours = 72
	}
	if k.RateLimit < 0 || k.DefaultRevenue < 0 {
		return bad("limits and revenue cannot be negative")
	}
	clean := []string{}
	for _, a := range k.IPAllow {
		if a = strings.TrimSpace(a); a == "" {
			continue
		}
		if len(antibot.ParsePrefixes([]byte(a))) != 1 {
			return bad(fmt.Sprintf("%q is not an IP or CIDR", a))
		}
		clean = append(clean, a)
	}
	k.IPAllow = clean
	return nil
}

func validatePreset(_ context.Context, p *model.GeoPreset, old *model.GeoPreset) error {
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		return bad("name is required")
	}
	out := []string{}
	for _, c := range p.Countries {
		c = strings.ToUpper(strings.TrimSpace(c))
		if len(c) != 2 {
			return bad(fmt.Sprintf("%q is not a two-letter country code", c))
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		return bad("add at least one country")
	}
	p.Countries = out
	p.Builtin = old != nil && old.Builtin
	return nil
}

func validateList(_ context.Context, l *model.IPList, old *model.IPList) error {
	l.Name = strings.TrimSpace(l.Name)
	if l.Name == "" {
		return bad("name is required")
	}
	if !oneOf(l.Kind, model.ListBot, model.ListDatacenter, model.ListBlock, model.ListAllow) {
		return bad("kind must be bot, datacenter, block or allow")
	}
	if l.URL != "" {
		u, err := url.Parse(l.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return bad("URL must be http(s)")
		}
	}
	if l.RefreshHours <= 0 {
		l.RefreshHours = 24
	}
	if old != nil {
		l.Builtin, l.Entries, l.UpdatedAt, l.LastError = old.Builtin, old.Entries, old.UpdatedAt, old.LastError
		if old.URL != l.URL {
			l.UpdatedAt = nil // force a download
		}
	} else {
		l.Builtin, l.Entries, l.UpdatedAt, l.LastError = false, 0, nil, ""
	}
	return nil
}

func validateIntegration(_ context.Context, in *model.Integration, _ *model.Integration) error {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return bad("name is required")
	}
	if !oneOf(in.Kind, "geo", "antibot") {
		return bad("kind must be geo or antibot")
	}
	u, err := url.Parse(strings.NewReplacer("{ip}", "1.1.1.1", "{ua}", "x").Replace(in.URL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return bad("URL must be http(s)")
	}
	if !strings.Contains(in.URL, "{ip}") {
		return bad("URL must contain the {ip} placeholder")
	}
	if in.TimeoutMs <= 0 {
		in.TimeoutMs = 300
	}
	if in.TimeoutMs > 5000 {
		return bad("timeout above 5000 ms would stall every click")
	}
	if in.CacheMinutes <= 0 {
		in.CacheMinutes = 60
	}
	if in.Kind == "antibot" && in.Mapping["bot"] == "" {
		return bad("set the JSON path of the bot flag or score")
	}
	if in.Kind == "geo" && in.Mapping["country"] == "" {
		return bad("set the JSON path of the country code")
	}
	return nil
}

// routes mounts every authenticated API endpoint.
func (s *Server) routes(r chi.Router) {
	mount(s, r, "/domain-groups", resource[model.DomainGroup]{table: "domain_groups", order: "name",
		validate: func(_ context.Context, g *model.DomainGroup, _ *model.DomainGroup) error {
			if g.Name = strings.TrimSpace(g.Name); g.Name == "" {
				return bad("name is required")
			}
			return nil
		}})
	mount(s, r, "/domains", resource[model.Domain]{table: "domains", order: "name", validate: s.validateDomain,
		canDelete: func(ctx context.Context, d *model.Domain) error {
			if d.AdminEnabled && d.Status == "ok" && s.wouldLockOut(ctx, d.ID) {
				return conflict(lockoutMsg)
			}
			return nil
		},
		changed: func(_ context.Context, id int64, deleted bool) {
			if !deleted {
				go s.checkDomains(context.Background(), []int64{id})
			}
		}})
	r.Post("/domains/bulk", handler(s.domainsBulkAdd))
	r.Post("/domains/bulk-update", handler(s.domainsBulkUpdate))
	r.Post("/domains/bulk-delete", handler(s.domainsBulkDelete))
	r.Post("/domains/check", handler(s.domainsCheck))

	editable := func(ctx context.Context, c *model.Campaign) error {
		_, err := s.campaign(ctx, c.ID, model.AccessEdit)
		return err
	}
	mount(s, r, "/campaigns", resource[model.Campaign]{table: "campaigns", order: "id DESC", validate: s.validateCampaign,
		visible: s.visibleCampaigns, writable: editable, created: s.seedStreams,
		deletable: func(ctx context.Context, c *model.Campaign) error {
			_, err := s.campaign(ctx, c.ID, model.AccessOwner)
			return err
		}})
	s.groupRoutes(r)
	s.dashboardRoutes(r)
	r.Post("/campaigns/{id}/clone", handler(s.campaignClone))
	r.Post("/campaigns/{id}/alias", handler(s.campaignNewAlias))
	r.Post("/campaigns/{id}/reset-stats", handler(s.campaignResetStats))
	mount(s, r, "/stream-presets", resource[model.StreamPreset]{table: "stream_presets", order: "kind, name", validate: s.validatePreset})
	r.Get("/campaigns/{id}/streams", handler(s.campaignStreams))
	r.Put("/campaigns/{id}/streams/order", handler(s.streamsReorder))
	r.Get("/campaigns/{id}/integration", handler(s.campaignIntegration))
	mount(s, r, "/streams", resource[model.Stream]{table: "streams", order: "campaign_id, position, id", validate: s.validateStream,
		visible: func(ctx context.Context, items []model.Stream) []model.Stream {
			u := userFrom(ctx)
			if u.IsAdmin() {
				return items
			}
			shares, _ := s.shareMap(ctx, u)
			owned := map[int64]bool{}
			if cs, err := store.List[model.Campaign](ctx, s.st, "campaigns", "id"); err == nil {
				for _, c := range cs {
					owned[c.ID] = c.OwnerID == u.ID
				}
			}
			out := []model.Stream{}
			for _, st := range items {
				if owned[st.CampaignID] || shares[st.CampaignID] >= model.AccessRead {
					out = append(out, st)
				}
			}
			return out
		},
		writable: func(ctx context.Context, st *model.Stream) error {
			_, err := s.campaign(ctx, st.CampaignID, model.AccessEdit)
			return err
		}})

	mount(s, r, "/conversion-keys", resource[model.ConvKey]{table: "conv_keys", order: "id", validate: s.validateKey})
	r.Post("/conversion-keys/{id}/regenerate", handler(s.keyRegenerate))

	mount(s, r, "/geo-presets", resource[model.GeoPreset]{table: "geo_presets", order: "id", validate: validatePreset,
		public: true, adminWrite: true})
	admin := r.With(s.requireAdmin)
	mount(s, r, "/ip-lists", resource[model.IPList]{table: "ip_lists", order: "id", validate: validateList, adminOnly: true,
		canDelete: func(_ context.Context, l *model.IPList) error {
			if l.Builtin {
				return bad("built-in lists cannot be deleted; disable it instead")
			}
			return nil
		},
		changed: func(_ context.Context, id int64, deleted bool) {
			if deleted {
				s.lists.Remove(id)
				s.lists.Reload(context.Background())
				return
			}
			go s.lists.Refresh(context.Background(), id, false)
		}})
	admin.Post("/ip-lists/{id}/refresh", handler(func(r *http.Request) (any, error) {
		if err := s.lists.Refresh(r.Context(), pathID(r), true); err != nil {
			return nil, bad(err.Error())
		}
		return store.Get[model.IPList](r.Context(), s.st, "ip_lists", pathID(r))
	}))
	mount(s, r, "/integrations", resource[model.Integration]{table: "integrations", order: "id", validate: validateIntegration, adminOnly: true})
	admin.Post("/integrations/test", handler(s.integrationTest))

	s.userRoutes(r)

	s.whitepageRoutes(r)
	s.dataRoutes(r)
}

// ---- domains: bulk operations -----------------------------------------------

type bulkAdd struct {
	Names        string `json:"names"` // any separator: newline, comma, space
	GroupID      *int64 `json:"group_id"`
	CampaignID   *int64 `json:"campaign_id"`
	TLSMode      string `json:"tls_mode"`
	IPSource     string `json:"ip_source"`
	AdminEnabled bool   `json:"admin_enabled"`
}

func (s *Server) domainsBulkAdd(r *http.Request) (any, error) {
	var in bulkAdd
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	type result struct {
		Name  string `json:"name"`
		OK    bool   `json:"ok"`
		Error string `json:"error,omitempty"`
		ID    int64  `json:"id,omitempty"`
	}
	results := []result{}
	var ids []int64
	seen := map[string]bool{}
	for _, raw := range strings.FieldsFunc(in.Names, func(c rune) bool { return c == '\n' || c == '\r' || c == ',' || c == ';' || c == ' ' || c == '\t' }) {
		d := model.Domain{Name: raw, GroupID: in.GroupID, CampaignID: in.CampaignID, TLSMode: in.TLSMode,
			IPSource: in.IPSource, AdminEnabled: in.AdminEnabled, Enabled: true, OwnerID: currentUser(r).ID}
		if err := s.validateDomain(r.Context(), &d, nil); err != nil {
			results = append(results, result{Name: raw, Error: err.Error()})
			continue
		}
		if seen[d.Name] {
			continue
		}
		seen[d.Name] = true
		if err := store.Insert(r.Context(), s.st, "domains", &d); err != nil {
			msg := err.Error()
			if err == store.ErrConflict {
				msg = "already added"
			}
			results = append(results, result{Name: d.Name, Error: msg})
			continue
		}
		ids = append(ids, d.ID)
		results = append(results, result{Name: d.Name, OK: true, ID: d.ID})
	}
	if len(results) == 0 {
		return nil, bad("no domain names found")
	}
	if len(ids) > 0 {
		go s.checkDomains(context.Background(), ids)
	}
	return map[string]any{"results": results, "added": len(ids)}, s.reload(r.Context())
}

func (s *Server) domainsBulkUpdate(r *http.Request) (any, error) {
	var in struct {
		IDs []int64        `json:"ids"`
		Set map[string]any `json:"set"`
	}
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	if len(in.IDs) == 0 || len(in.Set) == 0 {
		return nil, bad("nothing to update")
	}
	// Only these columns may be set in bulk; values go through the normal validator.
	allowed := map[string]bool{"group_id": true, "campaign_id": true, "tls_mode": true, "ip_source": true, "enabled": true, "admin_enabled": true}
	for k := range in.Set {
		if !allowed[k] {
			return nil, bad("cannot bulk-update " + k)
		}
	}
	patch := mustMarshal(in.Set)
	updated := 0
	// Domains before the one that fails are already saved: publish them too.
	fail := func(err error) (any, error) {
		if updated > 0 {
			s.reload(r.Context())
		}
		return nil, err
	}
	for _, id := range in.IDs {
		old, err := ownedGet[model.Domain](r.Context(), s, "domains", id)
		if err != nil {
			continue
		}
		d := *old
		if err := unmarshal(patch, &d); err != nil {
			return fail(bad(err.Error()))
		}
		if err := s.validateDomain(r.Context(), &d, old); err != nil {
			return fail(fmt.Errorf("%s: %w", old.Name, err))
		}
		if err := store.Update(r.Context(), s.st, "domains", id, &d); err != nil {
			return fail(err)
		}
		updated++
	}
	if _, ok := in.Set["tls_mode"]; ok {
		go s.checkDomains(context.Background(), in.IDs)
	}
	return map[string]int{"updated": updated}, s.reload(r.Context())
}

func (s *Server) domainsBulkDelete(r *http.Request) (any, error) {
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	deleted := 0
	for _, id := range in.IDs {
		d, err := ownedGet[model.Domain](r.Context(), s, "domains", id)
		if err != nil {
			continue
		}
		if d.AdminEnabled && d.Status == "ok" && s.wouldLockOut(r.Context(), d.ID) {
			s.reload(r.Context())
			return nil, conflict(d.Name + ": " + lockoutMsg)
		}
		if s.st.Delete(r.Context(), "domains", id) == nil {
			deleted++
		}
	}
	return map[string]int{"deleted": deleted}, s.reload(r.Context())
}

func (s *Server) domainsCheck(r *http.Request) (any, error) {
	var in struct {
		IDs []int64 `json:"ids"`
	}
	readJSON(r, &in)
	// Limit the check to the caller's own domains ("all" means all of theirs).
	domains, err := store.List[model.Domain](r.Context(), s.st, "domains", "id")
	if err != nil {
		return nil, err
	}
	want := map[int64]bool{}
	for _, id := range in.IDs {
		want[id] = true
	}
	ids := []int64{}
	for _, d := range visibleOwned(r.Context(), domains) {
		if len(in.IDs) == 0 || want[d.ID] {
			ids = append(ids, d.ID)
		}
	}
	// Runs in the background: certificate issuance can take a while.
	go s.checkDomains(context.Background(), ids)
	return nil, nil
}

// ---- campaigns & streams ----------------------------------------------------

func (s *Server) campaignStreams(r *http.Request) (any, error) {
	if _, err := s.campaign(r.Context(), pathID(r), model.AccessRead); err != nil {
		return nil, err
	}
	rows, err := s.st.Pool.Query(r.Context(), "SELECT * FROM streams WHERE campaign_id=$1 ORDER BY position, id", pathID(r))
	if err != nil {
		return nil, err
	}
	streams, err := collect[model.Stream](rows)
	if err != nil {
		return nil, err
	}
	// Streams may point at whitepages and campaigns the viewer cannot list
	// (they belong to the campaign's owner): send their names along.
	pages, targets := map[int64]string{}, map[int64]string{}
	snap := s.eng.Snap()
	for _, st := range streams {
		var ref struct {
			Whitepage int64 `json:"whitepage_id"`
			Campaign  int64 `json:"campaign_id"`
		}
		json.Unmarshal(st.ActionConfig, &ref)
		if wp := snap.Whitepages[ref.Whitepage]; wp != nil && st.ActionType == "whitepage" {
			pages[wp.ID] = wp.Name
		}
		if c := snap.ByID[ref.Campaign]; c != nil && st.ActionType == "campaign" {
			targets[c.ID] = c.Name
		}
	}
	return map[string]any{"streams": streams, "errors": s.eng.StreamErrors(r.Context()),
		"whitepages": pages, "campaigns": targets}, nil
}

func (s *Server) streamsReorder(r *http.Request) (any, error) {
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	if _, err := s.campaign(r.Context(), pathID(r), model.AccessEdit); err != nil {
		return nil, err
	}
	for i, id := range in.IDs {
		if _, err := s.st.Pool.Exec(r.Context(), "UPDATE streams SET position=$1 WHERE id=$2 AND campaign_id=$3", i, id, pathID(r)); err != nil {
			return nil, err
		}
	}
	return nil, s.reload(r.Context())
}

// campaignResetStats deletes the campaign's clicks and conversions and makes
// its visitors unique again: a clean start after testing. Owner only, like
// deleting the campaign.
func (s *Server) campaignResetStats(r *http.Request) (any, error) {
	c, err := s.campaign(r.Context(), pathID(r), model.AccessOwner)
	if err != nil {
		return nil, err
	}
	if err := s.ev.DeleteCampaign(r.Context(), c.ID); err != nil {
		return nil, err
	}
	s.eng.ForgetVisitors(c.ID)
	return nil, nil
}

func (s *Server) campaignClone(r *http.Request) (any, error) {
	ctx := r.Context()
	src, err := s.campaign(ctx, pathID(r), model.AccessRead)
	if err != nil {
		return nil, err
	}
	c := *src
	c.Name, c.Alias, c.Token = src.Name+" (copy)", newAlias(), randToken(24)
	c.OwnerID = currentUser(r).ID // the copy belongs to whoever made it
	if c.OwnerID != src.OwnerID {
		c.GroupID = nil // the group is the original owner's
	}
	if err := store.Insert(ctx, s.st, "campaigns", &c); err != nil {
		return nil, err
	}
	rows, err := s.st.Pool.Query(ctx, "SELECT * FROM streams WHERE campaign_id=$1 ORDER BY position, id", src.ID)
	if err != nil {
		return nil, err
	}
	streams, err := collect[model.Stream](rows)
	if err != nil {
		return nil, err
	}
	for _, st := range streams {
		st.CampaignID = c.ID
		if err := store.Insert(ctx, s.st, "streams", &st); err != nil {
			return nil, err
		}
	}
	return &c, s.reload(ctx)
}

// campaignIntegration returns ready-to-paste snippets for each integration.
func (s *Server) campaignIntegration(r *http.Request) (any, error) {
	c, err := s.campaign(r.Context(), pathID(r), model.AccessEdit)
	if err != nil {
		return nil, err
	}
	domain := r.URL.Query().Get("domain")
	if domain == "" {
		domain = "YOUR-DOMAIN"
	}
	base := "https://" + domain
	js := fmt.Sprintf(`<script>(function(){var s=document.createElement("script");s.src=%q+"?_url="+encodeURIComponent(location.href)+"&_ref="+encodeURIComponent(document.referrer);s.async=true;document.head.appendChild(s)})();</script>`,
		base+jsPrefix+c.Alias)
	return map[string]string{
		"event_url":    base + eventPrefix + "{stage}?cid={click_id}",
		"direct_url":   base + "/" + c.Alias,
		"direct_note":  "Append your own parameters: ?sub1=..&sub2=..&keyword=..",
		"js":           js,
		"php":          strings.NewReplacer("__ENDPOINT__", base+phpAPIPath, "__TOKEN__", c.Token).Replace(phpClient),
		"php_filename": "tds.php",
	}, nil
}

const phpClient = `<?php
// TDS server-side integration. Include at the very top of your page:
//   require __DIR__ . '/tds.php';
// If the tracker is unreachable the script returns and your own page is shown.
(function () {
    $endpoint = '__ENDPOINT__';
    $token    = '__TOKEN__';

    $headers = [];
    foreach ($_SERVER as $k => $v) {
        if (strpos($k, 'HTTP_') === 0) {
            $headers[str_replace('_', '-', substr($k, 5))] = $v;
        }
    }
    // Behind a CDN, replace REMOTE_ADDR with the header your CDN sets.
    $payload = json_encode([
        'token'   => $token,
        'ip'      => $_SERVER['REMOTE_ADDR'] ?? '',
        'headers' => $headers,
        'query'   => $_SERVER['QUERY_STRING'] ?? '',
        'referer' => $_SERVER['HTTP_REFERER'] ?? '',
        'host'    => $_SERVER['HTTP_HOST'] ?? '',
        'uri'     => strtok($_SERVER['REQUEST_URI'] ?? '/', '?'),
        'https'   => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    ]);
    $ch = curl_init($endpoint);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $payload,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT        => 5,
    ]);
    $raw = curl_exec($ch);
    $ok  = $raw !== false && curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200;
    curl_close($ch);
    $r = $ok ? json_decode($raw, true) : null;
    if (!is_array($r)) {
        return;
    }
    if (!empty($r['location'])) {
        header('Location: ' . $r['location'], true, (int) $r['status']);
        exit;
    }
    if ((int) $r['status'] === 200 && $r['body'] === '') {
        return; // "do nothing": continue with your own page
    }
    http_response_code((int) $r['status']);
    foreach ($r['headers'] ?? [] as $k => $v) {
        header($k . ': ' . $v);
    }
    if (!empty($r['content_type'])) {
        header('Content-Type: ' . $r['content_type']);
    }
    echo $r['body'];
    exit;
})();
`

func (s *Server) keyRegenerate(r *http.Request) (any, error) {
	k, err := ownedGet[model.ConvKey](r.Context(), s, "conv_keys", pathID(r))
	if err != nil {
		return nil, err
	}
	k.Key = randToken(24)
	if k.Secret != "" {
		k.Secret = randToken(32)
	}
	if err := store.Update(r.Context(), s.st, "conv_keys", k.ID, k); err != nil {
		return nil, err
	}
	return k, s.reload(r.Context())
}

func (s *Server) integrationTest(r *http.Request) (any, error) {
	var in struct {
		Integration model.Integration `json:"integration"`
		IP          string            `json:"ip"`
	}
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	if err := validateIntegration(r.Context(), &in.Integration, nil); err != nil {
		return nil, err
	}
	if in.IP == "" {
		in.IP = "8.8.8.8"
	}
	in.Integration.TimeoutMs = 5000
	return testIntegration(r.Context(), in.Integration, in.IP)
}
