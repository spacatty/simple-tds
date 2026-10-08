package web

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"simpletds/internal/antibot"
	"simpletds/internal/engine"
	"simpletds/internal/events"
	"simpletds/internal/extapi"
	"simpletds/internal/model"
	"simpletds/internal/store"
)

func collect[T any](rows pgx.Rows) ([]T, error) {
	out, err := pgx.CollectRows(rows, pgx.RowToStructByName[T])
	if out == nil {
		out = []T{}
	}
	return out, err
}

func mustMarshal(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func unmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

func testIntegration(ctx context.Context, in model.Integration, ip string) (any, error) {
	doc, err := extapi.New(in).Lookup(ctx, ip, "Mozilla/5.0")
	if err != nil {
		return nil, bad("request failed: " + err.Error())
	}
	mapped := map[string]any{}
	for field, path := range in.Mapping {
		if field == "threshold" {
			continue
		}
		mapped[field] = extapi.Path(doc, path)
	}
	out := map[string]any{"response": doc, "mapped": mapped}
	if in.Kind == "antibot" {
		th, _ := strconv.ParseFloat(in.Mapping["threshold"], 64)
		out["is_bot"] = extapi.Truthy(extapi.Path(doc, in.Mapping["bot"]), th)
	}
	return out, nil
}

// ---- whitepages -------------------------------------------------------------

const maxUpload = 256 << 20

func (s *Server) whitepageRoutes(r chi.Router) {
	r.Get("/whitepages", handler(func(r *http.Request) (any, error) {
		return store.List[model.Whitepage](r.Context(), s.st, "whitepages", "id DESC")
	}))
	r.Post("/whitepages", handler(s.whitepageCreate))
	r.Put("/whitepages/{id}", handler(s.whitepageUpdate))
	r.Post("/whitepages/{id}/upload", handler(s.whitepageUpload))
	r.Get("/whitepages/{id}/files", handler(func(r *http.Request) (any, error) {
		return s.pages.Files(pathID(r)), nil
	}))
	r.Get("/whitepages/{id}/preview-url", handler(func(r *http.Request) (any, error) {
		if _, err := store.Get[model.Whitepage](r.Context(), s.st, "whitepages", pathID(r)); err != nil {
			return nil, err
		}
		exp := time.Now().Add(2 * time.Hour).Unix()
		// Relative to the panel root, so it works on ip:port and under the admin path alike.
		return map[string]string{"url": fmt.Sprintf("preview/%s/%d/", s.previewToken(pathID(r), exp), pathID(r))}, nil
	}))
	r.Delete("/whitepages/{id}", handler(s.whitepageDelete))
}

func uploadedFile(r *http.Request) (string, []byte, error) {
	r.Body = http.MaxBytesReader(nil, r.Body, maxUpload)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		return "", nil, bad("upload failed or is larger than 256 MB")
	}
	f, head, err := r.FormFile("file")
	if err != nil {
		return "", nil, bad("choose a file to upload")
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	return head.Filename, data, err
}

func (s *Server) whitepageCreate(r *http.Request) (any, error) {
	name, data, err := uploadedFile(r)
	if err != nil {
		return nil, err
	}
	wp := model.Whitepage{Name: strings.TrimSpace(r.FormValue("name")), Note: r.FormValue("note"),
		InjectBase: r.FormValue("inject_base") != "false", Key: strings.ToLower(randToken(9)), Kind: "html", Entry: "index.html"}
	if wp.Name == "" {
		wp.Name = strings.TrimSuffix(name, ".zip")
	}
	ctx := r.Context()
	if err := store.Insert(ctx, s.st, "whitepages", &wp); err != nil {
		return nil, err
	}
	if err := s.pages.Save(&wp, name, data); err != nil {
		s.st.Delete(ctx, "whitepages", wp.ID)
		s.pages.Delete(wp.ID)
		return nil, bad(err.Error())
	}
	if err := store.Update(ctx, s.st, "whitepages", wp.ID, &wp); err != nil {
		return nil, err
	}
	return &wp, s.reload(ctx)
}

func (s *Server) whitepageUpload(r *http.Request) (any, error) {
	ctx := r.Context()
	wp, err := store.Get[model.Whitepage](ctx, s.st, "whitepages", pathID(r))
	if err != nil {
		return nil, err
	}
	name, data, err := uploadedFile(r)
	if err != nil {
		return nil, err
	}
	if err := s.pages.Save(wp, name, data); err != nil {
		return nil, bad(err.Error())
	}
	if err := store.Update(ctx, s.st, "whitepages", wp.ID, wp); err != nil {
		return nil, err
	}
	return wp, s.reload(ctx)
}

func (s *Server) whitepageUpdate(r *http.Request) (any, error) {
	ctx := r.Context()
	wp, err := store.Get[model.Whitepage](ctx, s.st, "whitepages", pathID(r))
	if err != nil {
		return nil, err
	}
	in := struct {
		Name       *string `json:"name"`
		Note       *string `json:"note"`
		Entry      *string `json:"entry"`
		InjectBase *bool   `json:"inject_base"`
	}{}
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	if in.Name != nil {
		if wp.Name = strings.TrimSpace(*in.Name); wp.Name == "" {
			return nil, bad("name is required")
		}
	}
	if in.Note != nil {
		wp.Note = *in.Note
	}
	if in.InjectBase != nil {
		wp.InjectBase = *in.InjectBase
	}
	if in.Entry != nil && *in.Entry != wp.Entry {
		found := false
		for _, f := range s.pages.Files(wp.ID) {
			found = found || f.Name == *in.Entry
		}
		if !found {
			return nil, bad("entry file does not exist in this whitepage")
		}
		wp.Entry = *in.Entry
	}
	if err := store.Update(ctx, s.st, "whitepages", wp.ID, wp); err != nil {
		return nil, err
	}
	return wp, s.reload(ctx)
}

func (s *Server) whitepageDelete(r *http.Request) (any, error) {
	ctx := r.Context()
	id := pathID(r)
	// Refuse while a stream still serves it: that stream would start failing.
	streams, err := store.List[model.Stream](ctx, s.st, "streams", "id")
	if err != nil {
		return nil, err
	}
	for _, st := range streams {
		var cfg struct {
			ID int64 `json:"whitepage_id"`
		}
		if st.ActionType == "whitepage" && json.Unmarshal(st.ActionConfig, &cfg) == nil && cfg.ID == id {
			return nil, conflict(fmt.Sprintf("still used by stream %q — change that stream first", st.Name))
		}
	}
	if err := s.st.Delete(ctx, "whitepages", id); err != nil {
		return nil, err
	}
	s.pages.Delete(id)
	return nil, s.reload(ctx)
}

// ---- settings, reports, tools -----------------------------------------------

var reAdminPath = regexp.MustCompile(`^[A-Za-z0-9_-]{3,64}$`)

func (s *Server) dataRoutes(r chi.Router) {
	r.Get("/settings", handler(func(r *http.Request) (any, error) { return s.st.Settings(r.Context()) }))
	r.Put("/settings", handler(s.settingsSave))

	r.Get("/meta", handler(s.meta))
	r.Get("/system", handler(s.system))
	r.Post("/simulate", handler(func(r *http.Request) (any, error) {
		var in engine.SimInput
		if err := readJSON(r, &in); err != nil {
			return nil, err
		}
		res, err := s.eng.Simulate(r.Context(), in)
		if err != nil {
			return nil, bad(err.Error())
		}
		return res, nil
	}))
	r.Post("/cache/purge", handler(func(*http.Request) (any, error) { s.eng.PurgeRemoteCache(); return nil, nil }))

	r.Get("/geo/status", handler(func(*http.Request) (any, error) { return s.geo.Status(), nil }))
	r.Post("/geo/refresh", handler(func(r *http.Request) (any, error) {
		if err := s.geo.Refresh(r.Context(), s.eng.Snap().Settings, true); err != nil {
			return nil, bad(err.Error())
		}
		return s.geo.Status(), nil
	}))
	r.Post("/geo/upload", handler(func(r *http.Request) (any, error) {
		r.Body = http.MaxBytesReader(nil, r.Body, 1<<30)
		f, _, err := r.FormFile("file")
		if err != nil {
			return nil, bad("choose an .mmdb file")
		}
		defer f.Close()
		if err := s.geo.Install(r.FormValue("kind"), f); err != nil {
			return nil, bad(err.Error())
		}
		return s.geo.Status(), nil
	}))

	r.Get("/reports", handler(func(r *http.Request) (any, error) {
		q, err := parseQuery(r)
		if err != nil {
			return nil, err
		}
		group := r.URL.Query().Get("group")
		if group == "" {
			group = "day"
		}
		rows, err := s.ev.Report(r.Context(), group, q)
		if err != nil {
			return nil, bad(err.Error())
		}
		return map[string]any{"rows": rows}, nil
	}))
	r.Get("/clicks", handler(func(r *http.Request) (any, error) {
		q, err := parseQuery(r)
		if err != nil {
			return nil, err
		}
		rows, total, err := s.ev.Clicks(r.Context(), q)
		if err != nil {
			return nil, err
		}
		return map[string]any{"rows": rows, "total": total}, nil
	}))
	r.Get("/conversions", s.conversions)
	r.Get("/postbacks/rejected", handler(func(*http.Request) (any, error) {
		items, total := s.eng.Reject.List()
		return map[string]any{"rows": items, "total": total}, nil
	}))
}

func parseTime(v string) (time.Time, error) {
	if v == "" {
		return time.Time{}, nil
	}
	if n, err := strconv.ParseInt(v, 10, 64); err == nil {
		return time.Unix(n, 0), nil
	}
	return time.Parse(time.RFC3339, v)
}

// parseQuery reads the filters shared by reports and logs. from/to are unix
// seconds or RFC 3339; p.<name>=<value> filters conversions by postback param.
func parseQuery(r *http.Request) (events.Query, error) {
	v := r.URL.Query()
	q := events.Query{TZ: v.Get("tz"), Country: strings.ToUpper(v.Get("country")), Domain: v.Get("domain"), Type: v.Get("type"),
		IP: v.Get("ip"), ClickID: v.Get("click_id"), Bots: v.Get("bots"), Params: map[string]string{}}
	var err error
	if q.From, err = parseTime(v.Get("from")); err != nil {
		return q, bad("bad from")
	}
	if q.To, err = parseTime(v.Get("to")); err != nil {
		return q, bad("bad to")
	}
	u32 := func(name string) uint32 {
		n, _ := strconv.ParseUint(v.Get(name), 10, 32)
		return uint32(n)
	}
	q.CampaignID, q.StreamID, q.KeyID = u32("campaign_id"), u32("stream_id"), u32("key_id")
	q.Limit, _ = strconv.Atoi(v.Get("limit"))
	q.Offset, _ = strconv.Atoi(v.Get("offset"))
	for k, vals := range v {
		if name, ok := strings.CutPrefix(k, "p."); ok && name != "" && len(vals) > 0 && vals[0] != "" {
			q.Params[name] = vals[0]
		}
	}
	return q, nil
}

func (s *Server) conversions(w http.ResponseWriter, r *http.Request) {
	q, err := parseQuery(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	if r.URL.Query().Get("format") == "csv" {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="conversions-`+time.Now().UTC().Format("20060102-150405")+`.csv"`)
		w.Write([]byte{0xEF, 0xBB, 0xBF}) // BOM so Excel reads UTF-8
		if err := s.ev.ConversionsCSV(r.Context(), w, q, s.eng.Snap().KeyNames); err != nil {
			// Headers are gone; all we can do is leave a trace in the file.
			fmt.Fprintf(w, "\nERROR: %v\n", err)
		}
		return
	}
	rows, keys, total, err := s.ev.Conversions(r.Context(), q)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rows": rows, "param_keys": keys, "total": total})
}

func (s *Server) settingsSave(r *http.Request) (any, error) {
	ctx := r.Context()
	old, err := s.st.Settings(ctx)
	if err != nil {
		return nil, err
	}
	st := old
	if err := readJSON(r, &st); err != nil {
		return nil, err
	}
	if !reAdminPath.MatchString(st.AdminPath) {
		return nil, bad("admin path: 3-64 letters, digits, - or _")
	}
	if oneOf(strings.ToLower(st.AdminPath), ReservedAliases...) {
		return nil, bad("this admin path is reserved")
	}
	if c := s.eng.Snap().ByAlias[strings.ToLower(st.AdminPath)]; c != nil {
		return nil, bad("admin path collides with the alias of campaign " + c.Name)
	}
	for _, p := range st.TrustedProxies {
		if strings.TrimSpace(p) != "" && len(antibot.ParsePrefixes([]byte(p))) != 1 {
			return nil, bad(fmt.Sprintf("trusted proxy %q is not an IP or CIDR", p))
		}
	}
	if st.ProxyProtocol && len(st.TrustedProxies) == 0 {
		return nil, bad("PROXY protocol needs at least one trusted proxy address: only those may send the header")
	}
	if !st.PanelIPAccess && old.PanelIPAccess && !s.eng.Snap().AdminDomainOK {
		return nil, conflict("ip:port access can only be turned off once a domain with panel access enabled has passed its check")
	}
	if st.BotThreshold <= 0 {
		st.BotThreshold = 100
	}
	if st.RetentionDays < 1 {
		st.RetentionDays = 180
	}
	if st.SessionHours < 1 {
		st.SessionHours = 72
	}
	for _, p := range st.BotUAPatterns {
		if len(p) > 200 {
			return nil, bad("User-Agent pattern is too long")
		}
	}
	if err := s.st.SaveSettings(ctx, st); err != nil {
		return nil, err
	}
	if st.RetentionDays != old.RetentionDays {
		if err := s.ev.SetRetention(ctx, st.RetentionDays); err != nil {
			return nil, err
		}
	}
	if st.GeoCityURL != old.GeoCityURL || st.GeoASNURL != old.GeoASNURL || st.MaxMindKey != old.MaxMindKey {
		go s.geo.Refresh(context.Background(), st, true)
	}
	return st, s.reload(ctx)
}

type integrationPreset struct {
	Name        string            `json:"name"`
	Kind        string            `json:"kind"`
	URL         string            `json:"url"`
	Mapping     map[string]string `json:"mapping"`
	Description string            `json:"description"`
}

var integrationPresets = []integrationPreset{
	{"ip-api.com (geo)", "geo", "http://ip-api.com/json/{ip}?fields=countryCode,regionName,city,isp,as",
		map[string]string{"country": "countryCode", "region": "regionName", "city": "city", "isp": "isp"},
		"Free, no key, 45 requests/minute. Fine for testing."},
	{"ip-api.com (proxy / hosting)", "antibot", "http://ip-api.com/json/{ip}?fields=proxy,hosting",
		map[string]string{"bot": "hosting"}, "Flags hosting addresses. Free tier is rate limited."},
	{"ipinfo.io (geo)", "geo", "https://ipinfo.io/{ip}?token=YOUR_TOKEN",
		map[string]string{"country": "country", "region": "region", "city": "city", "isp": "org"}, "Replace YOUR_TOKEN."},
	{"IPQualityScore", "antibot", "https://ipqualityscore.com/api/json/ip/YOUR_KEY/{ip}?strictness=1&user_agent={ua}",
		map[string]string{"bot": "fraud_score", "threshold": "85"}, "Replace YOUR_KEY. A fraud score of 85+ counts as a bot."},
	{"Custom endpoint", "antibot", "https://example.com/check?ip={ip}&ua={ua}",
		map[string]string{"bot": "is_bot"}, "Any JSON API: point the mapping at the right fields."},
}

func (s *Server) meta(*http.Request) (any, error) {
	return map[string]any{
		"actions":             engine.ActionDefs(),
		"filters":             engine.FilterDefs(),
		"macros":              engine.Macros,
		"conversion_types":    model.ConversionTypes,
		"cost_models":         model.CostModels,
		"report_groups":       events.Dimensions(),
		"integration_presets": integrationPresets,
		"postback_path":       postbackPath,
		"reserved_aliases":    ReservedAliases,
	}, nil
}

func (s *Server) system(r *http.Request) (any, error) {
	snap := s.eng.Snap()
	health := map[string]string{"postgres": "ok", "clickhouse": "ok"}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.st.Pool.Ping(ctx); err != nil {
		health["postgres"] = err.Error()
	}
	if err := s.ev.Ping(ctx); err != nil {
		health["clickhouse"] = err.Error()
	}
	return map[string]any{
		"stats":  s.eng.Stats(),
		"geo":    s.geo.Status(),
		"health": health,
		"panel": map[string]any{
			"ip_access":       snap.Settings.PanelIPAccess || s.cfg.ForcePanelIP,
			"ip_access_force": s.cfg.ForcePanelIP,
			"admin_domain_ok": snap.AdminDomainOK,
			"admin_path":      snap.Settings.AdminPath,
		},
		"php_enabled": s.pages.FCGIAddr != "",
	}, nil
}
