package web

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"simpletds/internal/engine"
	"simpletds/internal/model"
	"simpletds/internal/store"
)

// Landings are whitepages with variables: tokens in the files, declared on
// the landing, given values by presets and by the streams that show it.

func (s *Server) landingRoutes(r chi.Router) {
	r.Get("/landings", handler(func(r *http.Request) (any, error) {
		all, err := store.List[model.Landing](r.Context(), s.st, "landings", "id DESC")
		return visibleOwned(r.Context(), all), err
	}))
	r.Post("/landings", handler(s.landingCreate))
	r.Post("/landings/from-whitepage/{id}", handler(s.landingFromWhitepage))
	r.Put("/landings/{id}", handler(s.landingUpdate))
	r.Post("/landings/{id}/upload", handler(s.landingUpload))
	r.Get("/landings/{id}/files", handler(func(r *http.Request) (any, error) {
		if _, err := ownedGet[model.Landing](r.Context(), s, "landings", pathID(r)); err != nil {
			return nil, err
		}
		return s.landings.Files(pathID(r)), nil
	}))
	r.Get("/landings/{id}/file", handler(func(r *http.Request) (any, error) {
		if _, err := ownedGet[model.Landing](r.Context(), s, "landings", pathID(r)); err != nil {
			return nil, err
		}
		data, err := s.landings.ReadFile(pathID(r), r.URL.Query().Get("path"))
		if err != nil {
			return nil, bad(err.Error())
		}
		return map[string]string{"content": string(data)}, nil
	}))
	r.Put("/landings/{id}/file", handler(s.landingFileSave))
	r.Get("/landings/{id}/preview-url", handler(s.landingPreviewURL))
	r.Delete("/landings/{id}", handler(s.landingDelete))
}

var reVarName = regexp.MustCompile(`^[A-Z0-9]+(_[A-Z0-9]+)*$`)

// rescan brings the landing's variables in line with its files: a token found
// in them becomes a variable, and every variable learns whether it is used.
func (s *Server) rescan(l *model.Landing) {
	found, templated := s.landings.Scan(l.ID)
	used := map[string]bool{}
	for _, name := range found {
		used[name] = true
	}
	for i := range l.Vars {
		l.Vars[i].Used = used[l.Vars[i].Name]
		delete(used, l.Vars[i].Name)
	}
	for _, name := range found { // sorted, so new variables arrive in a stable order
		if used[name] && len(l.Vars) < model.MaxLandingVars {
			l.Vars = append(l.Vars, model.LandingVar{Name: name, Kind: model.VarText, Used: true})
		}
	}
	l.Templated = templated
}

func (s *Server) landingCreate(r *http.Request) (any, error) {
	name, data, err := uploadedFile(r)
	if err != nil {
		return nil, err
	}
	l := model.Landing{Name: strings.TrimSpace(r.FormValue("name")), Note: r.FormValue("note"),
		InjectBase: r.FormValue("inject_base") != "false", OwnerID: currentUser(r).ID, Key: strings.ToLower(randToken(9)),
		Kind: "html", Entry: "index.html", NextID: 1}
	if l.Name == "" {
		l.Name = strings.TrimSuffix(name, ".zip")
	}
	return s.landingStore(r.Context(), &l, func(page *model.Whitepage) error { return s.landings.Save(page, name, data) })
}

// landingStore inserts a new landing and fills its folder with fill.
func (s *Server) landingStore(ctx context.Context, l *model.Landing, fill func(page *model.Whitepage) error) (any, error) {
	if err := store.Insert(ctx, s.st, "landings", l); err != nil {
		return nil, err
	}
	page := l.Page()
	if err := fill(page); err != nil {
		s.st.Delete(ctx, "landings", l.ID)
		s.landings.Delete(l.ID)
		return nil, bad(err.Error())
	}
	l.Kind, l.Entry, l.FileCount, l.Size = page.Kind, page.Entry, page.FileCount, page.Size
	s.rescan(l)
	if err := store.Update(ctx, s.st, "landings", l.ID, l); err != nil {
		return nil, err
	}
	return l, s.reload(ctx)
}

// landingFromWhitepage copies a whitepage into a new landing; the whitepage
// and the streams showing it stay as they are.
func (s *Server) landingFromWhitepage(r *http.Request) (any, error) {
	ctx := r.Context()
	wp, err := ownedGet[model.Whitepage](ctx, s, "whitepages", pathID(r))
	if err != nil {
		return nil, err
	}
	l := model.Landing{Name: wp.Name, Note: wp.Note, InjectBase: wp.InjectBase, OwnerID: wp.OwnerID,
		Key: strings.ToLower(randToken(9)), Kind: wp.Kind, Entry: wp.Entry, NextID: 1}
	return s.landingStore(ctx, &l, func(page *model.Whitepage) error {
		page.Kind, page.Entry, page.FileCount, page.Size = wp.Kind, wp.Entry, wp.FileCount, wp.Size
		return s.landings.CopyFrom(s.pages, wp.ID, l.ID)
	})
}

func (s *Server) landingUpload(r *http.Request) (any, error) {
	ctx := r.Context()
	l, err := ownedGet[model.Landing](ctx, s, "landings", pathID(r))
	if err != nil {
		return nil, err
	}
	name, data, err := uploadedFile(r)
	if err != nil {
		return nil, err
	}
	page := l.Page()
	if err := s.landings.Save(page, name, data); err != nil {
		return nil, bad(err.Error())
	}
	l.Kind, l.Entry, l.FileCount, l.Size = page.Kind, page.Entry, page.FileCount, page.Size
	s.rescan(l)
	if err := store.Update(ctx, s.st, "landings", l.ID, l); err != nil {
		return nil, err
	}
	return l, s.reload(ctx)
}

func (s *Server) landingFileSave(r *http.Request) (any, error) {
	ctx := r.Context()
	l, err := ownedGet[model.Landing](ctx, s, "landings", pathID(r))
	if err != nil {
		return nil, err
	}
	var in struct {
		Content string `json:"content"`
	}
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	page := l.Page()
	if err := s.landings.WriteFile(page, r.URL.Query().Get("path"), []byte(in.Content)); err != nil {
		return nil, bad(err.Error())
	}
	l.Kind, l.FileCount, l.Size = page.Kind, page.FileCount, page.Size
	s.rescan(l)
	if err := store.Update(ctx, s.st, "landings", l.ID, l); err != nil {
		return nil, err
	}
	return l, s.reload(ctx)
}

// cleanVars validates the declared variables.
func cleanVars(vars []model.LandingVar) ([]model.LandingVar, error) {
	if len(vars) > model.MaxLandingVars {
		return nil, bad(fmt.Sprintf("a landing can have at most %d variables", model.MaxLandingVars))
	}
	seen := map[string]bool{}
	out := make([]model.LandingVar, 0, len(vars))
	for _, v := range vars {
		v.Name = strings.TrimPrefix(strings.ToUpper(strings.TrimSpace(v.Name)), model.LandingVarPrefix)
		if len(v.Name) > 64 || !reVarName.MatchString(v.Name) {
			return nil, bad(fmt.Sprintf("variable %q: the name is 1-64 capital letters, digits or _", v.Name))
		}
		if seen[v.Name] {
			return nil, bad(fmt.Sprintf("variable %s is declared twice", v.Name))
		}
		seen[v.Name] = true
		if v.Kind == "" {
			v.Kind = model.VarText
		}
		if !oneOf(v.Kind, model.LandingVarKinds...) {
			return nil, bad(fmt.Sprintf("variable %s: unknown kind", v.Name))
		}
		if v.Label = strings.TrimSpace(v.Label); len(v.Label) > 100 || len(v.Default) > model.MaxLandingValue {
			return nil, bad(fmt.Sprintf("variable %s: the value is too long", v.Name))
		}
		out = append(out, v)
	}
	return out, nil
}

// cleanPresets validates the presets and numbers the new ones. Values of
// variables that are not declared (any more) are dropped.
func cleanPresets(l *model.Landing, old []model.LandingPreset, presets []model.LandingPreset) ([]model.LandingPreset, error) {
	if len(presets) > model.MaxLandingPresets {
		return nil, bad(fmt.Sprintf("a landing can have at most %d presets", model.MaxLandingPresets))
	}
	known := map[int64]bool{}
	for _, p := range old {
		known[p.ID] = true
	}
	names, ids := map[string]bool{}, map[int64]bool{}
	out := make([]model.LandingPreset, 0, len(presets))
	for _, p := range presets {
		if p.Name = strings.TrimSpace(p.Name); p.Name == "" || len(p.Name) > 100 {
			return nil, bad("a preset needs a name of up to 100 characters")
		}
		if names[strings.ToLower(p.Name)] {
			return nil, bad(fmt.Sprintf("preset %q is listed twice", p.Name))
		}
		names[strings.ToLower(p.Name)] = true
		if !known[p.ID] || ids[p.ID] {
			if l.NextID < 1 {
				l.NextID = 1
			}
			p.ID = l.NextID
			l.NextID++
		}
		ids[p.ID] = true
		values := map[string]string{}
		for name, val := range p.Values {
			if l.Var(name) == nil {
				continue
			}
			if len(val) > model.MaxLandingValue {
				return nil, bad(fmt.Sprintf("variable %s: the value is too long", name))
			}
			values[name] = val
		}
		p.Values = values
		out = append(out, p)
	}
	return out, nil
}

func (s *Server) landingUpdate(r *http.Request) (any, error) {
	ctx := r.Context()
	l, err := ownedGet[model.Landing](ctx, s, "landings", pathID(r))
	if err != nil {
		return nil, err
	}
	in := struct {
		Name       *string                `json:"name"`
		Note       *string                `json:"note"`
		Entry      *string                `json:"entry"`
		InjectBase *bool                  `json:"inject_base"`
		Vars       *[]model.LandingVar    `json:"vars"`
		Presets    *[]model.LandingPreset `json:"presets"`
	}{}
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	if in.Name != nil {
		if l.Name = strings.TrimSpace(*in.Name); l.Name == "" {
			return nil, bad("name is required")
		}
	}
	if in.Note != nil {
		l.Note = *in.Note
	}
	if in.InjectBase != nil {
		l.InjectBase = *in.InjectBase
	}
	if in.Entry != nil && *in.Entry != l.Entry {
		found := false
		for _, f := range s.landings.Files(l.ID) {
			found = found || f.Name == *in.Entry
		}
		if !found {
			return nil, bad("entry file does not exist in this landing")
		}
		l.Entry = *in.Entry
	}
	oldPresets := l.Presets
	if in.Vars != nil {
		if l.Vars, err = cleanVars(*in.Vars); err != nil {
			return nil, err
		}
		// A token in the files stays a variable whether it was sent or not.
		s.rescan(l)
	}
	presets := l.Presets
	if in.Presets != nil {
		presets = *in.Presets
	}
	if l.Presets, err = cleanPresets(l, oldPresets, presets); err != nil {
		return nil, err
	}
	if in.Vars != nil || in.Presets != nil {
		if err := s.checkLandingUse(ctx, l); err != nil {
			return nil, err
		}
	}
	if err := store.Update(ctx, s.st, "landings", l.ID, l); err != nil {
		return nil, err
	}
	return l, s.reload(ctx)
}

// landingStreams lists the streams that show a landing.
func (s *Server) landingStreams(ctx context.Context, id int64) ([]model.Stream, error) {
	streams, err := store.List[model.Stream](ctx, s.st, "streams", "id")
	if err != nil {
		return nil, err
	}
	out := streams[:0]
	for _, st := range streams {
		if engine.LandingID(&st) == id {
			out = append(out, st)
		}
	}
	return out, nil
}

// stageProblem says why a landing configuration cannot run in a campaign: it
// reports a funnel stage the campaign does not accept from a browser.
func stageProblem(l *model.Landing, cfg *engine.LandingConfig, c *model.Campaign) string {
	for _, ref := range cfg.StageRefs(l) {
		if st := c.Stage(ref.Stage); st != nil && st.Public {
			continue
		}
		if ref.Var == "" {
			return fmt.Sprintf("the offer link reports the stage %q, which is not a browser stage of this campaign's funnel", ref.Stage)
		}
		return fmt.Sprintf("variable %s reports the stage %q, which is not a browser stage of this campaign's funnel", ref.Var, ref.Stage)
	}
	return ""
}

// checkLandingUse refuses a change to a landing's variables or presets that
// would break a stream showing it.
func (s *Server) checkLandingUse(ctx context.Context, l *model.Landing) error {
	streams, err := s.landingStreams(ctx, l.ID)
	if err != nil {
		return err
	}
	for _, st := range streams {
		cfg, err := engine.ParseLandingConfig(st.ActionConfig)
		if err != nil {
			continue
		}
		c, err := store.Get[model.Campaign](ctx, s.st, "campaigns", st.CampaignID)
		if err != nil {
			return err
		}
		for _, p := range cfg.Presets {
			if l.Preset(p.ID) == nil {
				return conflict(fmt.Sprintf("stream %q of campaign %q: it shows a preset this change removes — change that stream first", st.Name, c.Name))
			}
		}
		if msg := stageProblem(l, cfg, c); msg != "" {
			return conflict(fmt.Sprintf("stream %q of campaign %q: %s", st.Name, c.Name, msg))
		}
	}
	return nil
}

// checkLandingStream makes sure a stream's landing action can run: the editor
// may use the landing, the campaign's people run it, the presets and variables
// exist, and every funnel stage it reports is one the campaign takes from a
// browser.
func (s *Server) checkLandingStream(ctx context.Context, st *model.Stream, old *model.Stream) error {
	cfg, err := engine.ParseLandingConfig(st.ActionConfig)
	if err != nil {
		return bad(err.Error())
	}
	l, err := store.Get[model.Landing](ctx, s.st, "landings", cfg.LandingID)
	if err != nil {
		return bad("landing not found")
	}
	c, err := store.Get[model.Campaign](ctx, s.st, "campaigns", st.CampaignID)
	if err != nil {
		return err
	}
	// A landing already in place is left alone, so an editor can save a
	// stream the owner configured.
	if old == nil || engine.LandingID(old) != l.ID {
		if !owns(userFrom(ctx), l) && l.OwnerID != c.OwnerID {
			return bad("landing not found")
		}
		if rt := s.eng.Snap().ByID[c.ID]; rt == nil || !rt.UsableBy(l.OwnerID) {
			return bad("this landing belongs to someone who does not run this campaign, so it would not be shown")
		}
	}
	for _, p := range cfg.Presets {
		if l.Preset(p.ID) == nil {
			return bad("the landing has no such preset any more — choose the presets again")
		}
	}
	for name := range cfg.Values {
		if l.Var(name) == nil {
			return bad(fmt.Sprintf("variable %s is not declared in this landing", name))
		}
	}
	if msg := stageProblem(l, cfg, c); msg != "" {
		return bad(msg)
	}
	return nil
}

func (s *Server) landingDelete(r *http.Request) (any, error) {
	ctx := r.Context()
	id := pathID(r)
	if _, err := ownedGet[model.Landing](ctx, s, "landings", id); err != nil {
		return nil, err
	}
	// Refuse while a stream still serves it: that stream would start failing.
	streams, err := s.landingStreams(ctx, id)
	if err != nil {
		return nil, err
	}
	if len(streams) > 0 {
		return nil, conflict(fmt.Sprintf("still used by stream %q — change that stream first", streams[0].Name))
	}
	if err := s.st.Delete(ctx, "landings", id); err != nil {
		return nil, err
	}
	s.landings.Delete(id)
	return nil, s.reload(ctx)
}

// ---- preview ----------------------------------------------------------------

// A landing preview shows one preset; campaign, when given, is the campaign
// whose browser stages {event:…} is resolved against.
func (s *Server) landingPreviewToken(id, preset, campaign, exp int64) string {
	m := hmac.New(sha256.New, s.cfg.Secret)
	fmt.Fprintf(m, "landing-preview|%d|%d|%d|%d", id, preset, campaign, exp)
	return strconv.FormatInt(exp, 36) + "-" + hex.EncodeToString(m.Sum(nil)[:16])
}

func (s *Server) landingPreviewURL(r *http.Request) (any, error) {
	ctx := r.Context()
	l, err := ownedGet[model.Landing](ctx, s, "landings", pathID(r))
	if err != nil {
		return nil, err
	}
	q := r.URL.Query()
	preset, _ := strconv.ParseInt(q.Get("preset"), 10, 64)
	campaign, _ := strconv.ParseInt(q.Get("campaign_id"), 10, 64)
	if preset != 0 && l.Preset(preset) == nil {
		return nil, bad("the landing has no such preset any more — choose the presets again")
	}
	if campaign != 0 {
		if _, err := s.campaign(ctx, campaign, model.AccessRead); err != nil {
			return nil, err
		}
	}
	exp := time.Now().Add(2 * time.Hour).Unix()
	// Relative to the panel root, so it works on ip:port and under the admin path alike.
	return map[string]string{"url": fmt.Sprintf("preview-l/%s/%d/%d/%d/", s.landingPreviewToken(l.ID, preset, campaign, exp), l.ID, preset, campaign)}, nil
}

func (s *Server) serveLandingPreview(w http.ResponseWriter, r *http.Request) {
	// /preview-l/<token>/<id>/<preset>/<campaign>/<path...>
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/preview-l/"), "/", 5)
	if len(parts) < 5 {
		http.NotFound(w, r)
		return
	}
	id, _ := strconv.ParseInt(parts[1], 10, 64)
	preset, _ := strconv.ParseInt(parts[2], 10, 64)
	campaign, _ := strconv.ParseInt(parts[3], 10, 64)
	expStr, _, _ := strings.Cut(parts[0], "-")
	exp, _ := strconv.ParseInt(expStr, 36, 64)
	if time.Now().Unix() > exp || !hmac.Equal([]byte(parts[0]), []byte(s.landingPreviewToken(id, preset, campaign, exp))) {
		http.Error(w, "preview link expired — reopen it from the panel", http.StatusForbidden)
		return
	}
	snap := s.eng.Snap()
	l := snap.Landings[id]
	if l == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups")
	w.Header().Set("X-Robots-Tag", "noindex")
	req := s.pageRequest(r, w, hostOnly(r.Host), remoteAddr(r), r.TLS != nil)
	s.landings.ServeLanding(w, r, l, parts[4], req, func() *engine.LandingValues {
		return s.eng.PreviewLanding(r.Context(), l, preset, snap.ByID[campaign], hostOnly(r.Host), r.TLS != nil, r.URL.Query())
	}, false)
}

// ---- traffic port -----------------------------------------------------------

// serveLanding serves a landing's files and sub-pages under /_a/<key>/, and
// its offer link.
func (s *Server) serveLanding(w http.ResponseWriter, r *http.Request, d *engine.DomainRT, l *model.Landing, sub string, snap *engine.Snapshot) {
	ip, secure := clientIP(r, d.IPSource, snap), isSecure(r, snap)
	in := &engine.LandingInput{Ctx: r.Context(), Landing: l, Cookie: cookieGetter(r)(engine.LandingCookie),
		Domain: d.Name, OwnerID: d.OwnerID, IP: ip, Header: r.Header, Secure: secure}
	if sub == engine.LandingGo {
		in.ClickID = snap.Params.Get(r.URL.Query(), "click_id")
		target, ok := s.eng.LandingOffer(in)
		if !ok {
			stock404(w)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, target, http.StatusFound)
		return
	}
	s.landings.ServeLanding(w, r, l, sub, s.pageRequest(r, w, d.Name, ip, secure),
		func() *engine.LandingValues { return s.eng.LandingValues(in) }, true)
}
