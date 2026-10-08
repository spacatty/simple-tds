package web

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"

	"simpletds/internal/model"
	"simpletds/internal/store"
)

const sessionCookie = "tds_s"

type sessionEntry struct {
	user    *model.User
	expires time.Time
	cached  time.Time
}

type apiError struct {
	status int
	msg    string
}

func (e *apiError) Error() string { return e.msg }

func bad(format string) error      { return &apiError{http.StatusBadRequest, format} }
func conflict(format string) error { return &apiError{http.StatusConflict, format} }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	var ae *apiError
	switch {
	case errors.As(err, &ae):
		writeJSON(w, ae.status, map[string]string{"error": ae.msg})
	case errors.Is(err, store.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	case errors.Is(err, store.ErrConflict):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "an item with this name already exists"})
	default:
		slog.Error("api", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error: " + err.Error()})
	}
}

func readJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 4<<20))
	if err := dec.Decode(v); err != nil {
		return bad("invalid JSON: " + err.Error())
	}
	return nil
}

func pathID(r *http.Request) int64 {
	id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	return id
}

func randToken(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func hashToken(t string) string {
	h := sha256.Sum256([]byte(t))
	return hex.EncodeToString(h[:])
}

// handler adapts a function returning (value, error) to net/http.
func handler(fn func(r *http.Request) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v, err := fn(r)
		if err != nil {
			writeErr(w, err)
			return
		}
		if v == nil {
			v = map[string]bool{"ok": true}
		}
		writeJSON(w, http.StatusOK, v)
	}
}

// reload republishes the configuration after a change.
func (s *Server) reload(ctx context.Context) error {
	if err := s.eng.Reload(ctx); err != nil {
		return err
	}
	s.syncCerts()
	return nil
}

// ---- sessions ---------------------------------------------------------------

func (s *Server) sessionUser(r *http.Request) *model.User {
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return nil
	}
	h := hashToken(c.Value)
	now := time.Now()
	s.sessMu.Lock()
	e, ok := s.sessions[h]
	s.sessMu.Unlock()
	if ok && now.Before(e.expires) && now.Sub(e.cached) < time.Minute {
		return e.user
	}
	u, exp, err := s.st.SessionUser(r.Context(), h)
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	if err != nil {
		delete(s.sessions, h)
		return nil
	}
	s.sessions[h] = sessionEntry{user: u, expires: exp, cached: now}
	return u
}

func (s *Server) dropSessions() {
	s.sessMu.Lock()
	s.sessions = map[string]sessionEntry{}
	s.sessMu.Unlock()
}

type userKey struct{}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u := s.sessionUser(r)
		if u == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in required"})
			return
		}
		// Browsers cannot set this header cross-site without a CORS preflight,
		// which we never approve: a cheap, sufficient CSRF barrier.
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("X-TDS") == "" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "missing X-TDS header"})
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey{}, u)))
	})
}

func currentUser(r *http.Request) *model.User { return r.Context().Value(userKey{}).(*model.User) }

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Username, Password, Code string
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	ip := remoteAddr(r).String()
	if !s.eng.Allow("login|"+ip, 10) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many attempts, wait a minute"})
		return
	}
	u, err := s.st.UserByName(r.Context(), strings.TrimSpace(in.Username))
	// Compare against a dummy hash for unknown users so timing does not reveal them.
	hash := "$2a$12$C6UzMDM.H6dfI/f/IKcEeO5KQ0YI8mCqSmEoY1nQO4p6y5yq0gT6y"
	if err == nil {
		hash = u.PasswordHash
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Password)) != nil || err != nil || !u.Enabled {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "wrong username or password"})
		return
	}
	if u.TOTPEnabled {
		if in.Code == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "enter the code from your authenticator app", "totp_required": true})
			return
		}
		if !totp.Validate(strings.TrimSpace(in.Code), u.TOTPSecret) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "wrong code", "totp_required": true})
			return
		}
	}
	hours := s.eng.Snap().Settings.SessionHours
	if hours <= 0 {
		hours = 72
	}
	token := randToken(32)
	exp := time.Now().Add(time.Duration(hours) * time.Hour)
	if err := s.st.CreateSession(r.Context(), hashToken(token), u.ID, exp); err != nil {
		writeErr(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: token, Path: "/", Expires: exp, HttpOnly: true,
		SameSite: http.SameSiteLaxMode, Secure: isSecure(r, s.eng.Snap())})
	writeJSON(w, http.StatusOK, u)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.st.DeleteSession(r.Context(), hashToken(c.Value))
	}
	s.dropSessions()
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Path: "/", MaxAge: -1})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) changePassword(r *http.Request) (any, error) {
	var in struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	u := currentUser(r)
	if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(in.Current)) != nil {
		return nil, bad("current password is wrong")
	}
	if len(in.New) < 10 {
		return nil, bad("new password must be at least 10 characters")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(in.New), 12)
	if err != nil {
		return nil, err
	}
	if _, err := s.st.Pool.Exec(r.Context(), "UPDATE users SET password_hash=$2 WHERE id=$1", u.ID, string(hash)); err != nil {
		return nil, err
	}
	// Sign out every other device.
	s.st.DeleteUserSessions(r.Context(), u.ID)
	s.dropSessions()
	return nil, nil
}

func (s *Server) totpSetup(r *http.Request) (any, error) {
	u := currentUser(r)
	key, err := totp.Generate(totp.GenerateOpts{Issuer: "TDS", AccountName: u.Username})
	if err != nil {
		return nil, err
	}
	if _, err := s.st.Pool.Exec(r.Context(), "UPDATE users SET totp_secret=$2, totp_enabled=false WHERE id=$1", u.ID, key.Secret()); err != nil {
		return nil, err
	}
	s.dropSessions()
	return map[string]string{"secret": key.Secret(), "url": key.URL()}, nil
}

func (s *Server) totpEnable(r *http.Request) (any, error) {
	var in struct{ Code string }
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	u, err := store.Get[model.User](r.Context(), s.st, "users", currentUser(r).ID)
	if err != nil {
		return nil, err
	}
	if u.TOTPSecret == "" || !totp.Validate(strings.TrimSpace(in.Code), u.TOTPSecret) {
		return nil, bad("wrong code")
	}
	_, err = s.st.Pool.Exec(r.Context(), "UPDATE users SET totp_enabled=true WHERE id=$1", u.ID)
	s.dropSessions()
	return nil, err
}

func (s *Server) totpDisable(r *http.Request) (any, error) {
	var in struct{ Password string }
	if err := readJSON(r, &in); err != nil {
		return nil, err
	}
	u := currentUser(r)
	if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(in.Password)) != nil {
		return nil, bad("password is wrong")
	}
	_, err := s.st.Pool.Exec(r.Context(), "UPDATE users SET totp_enabled=false, totp_secret='' WHERE id=$1", u.ID)
	s.dropSessions()
	return nil, err
}

// ---- whitepage preview ------------------------------------------------------

// Previews are opened by signed URL rather than session cookie: the page is
// served sandboxed (opaque origin), so uploaded scripts cannot reach the
// panel API with the admin's session.
func (s *Server) previewToken(id int64, exp int64) string {
	m := hmac.New(sha256.New, s.cfg.Secret)
	m.Write([]byte("preview|" + strconv.FormatInt(id, 10) + "|" + strconv.FormatInt(exp, 10)))
	return strconv.FormatInt(exp, 36) + "-" + hex.EncodeToString(m.Sum(nil)[:16])
}

func (s *Server) servePreview(w http.ResponseWriter, r *http.Request) {
	// /preview/<token>/<id>/<path...>
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/preview/"), "/", 3)
	if len(parts) < 3 {
		http.NotFound(w, r)
		return
	}
	id, _ := strconv.ParseInt(parts[1], 10, 64)
	expStr, _, _ := strings.Cut(parts[0], "-")
	exp, _ := strconv.ParseInt(expStr, 36, 64)
	if time.Now().Unix() > exp || !hmac.Equal([]byte(parts[0]), []byte(s.previewToken(id, exp))) {
		http.Error(w, "preview link expired — reopen it from the panel", http.StatusForbidden)
		return
	}
	wp := s.eng.Snap().Whitepages[id]
	if wp == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups")
	w.Header().Set("X-Robots-Tag", "noindex")
	req := s.pageRequest(r, w, hostOnly(r.Host), remoteAddr(r), r.TLS != nil)
	req.Env = map[string]string{"TDS_CLICK_ID": "preview", "TDS_COUNTRY": "", "TDS_IS_BOT": "false"}
	s.pages.Serve(w, r, wp, parts[2], req, false)
}

// ---- panel ------------------------------------------------------------------

// panelHandler serves the SPA, its API and whitepage previews. It is mounted
// at the root of the ip:port listener and under the admin path on domains.
func (s *Server) panelHandler() http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			h := w.Header()
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("Referrer-Policy", "no-referrer")
			h.Set("X-Robots-Tag", "noindex, nofollow")
			next.ServeHTTP(w, req)
		})
	})
	r.Get("/preview/*", s.servePreview)
	r.Post("/preview/*", s.servePreview)

	r.Route("/api", func(r chi.Router) {
		r.Post("/login", s.login)
		r.Post("/logout", s.logout)
		r.Group(func(r chi.Router) {
			r.Use(s.requireAuth)
			r.Get("/me", handler(func(r *http.Request) (any, error) { return currentUser(r), nil }))
			r.Post("/me/password", handler(s.changePassword))
			r.Post("/me/totp/setup", handler(s.totpSetup))
			r.Post("/me/totp/enable", handler(s.totpEnable))
			r.Post("/me/totp/disable", handler(s.totpDisable))
			s.routes(r)
		})
	})

	dist, _ := fs.Sub(uiFS, "ui/dist")
	files := http.FileServer(http.FS(dist))
	r.NotFound(func(w http.ResponseWriter, req *http.Request) {
		if strings.HasPrefix(req.URL.Path, "/api/") {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		w.Header().Set("X-Frame-Options", "DENY")
		// Hashed assets are immutable; the shell must always be fresh.
		if strings.HasPrefix(req.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if _, err := fs.Stat(dist, strings.TrimPrefix(req.URL.Path, "/")); err != nil {
			req = req.Clone(req.Context())
			req.URL.Path = "/" // SPA fallback
		}
		files.ServeHTTP(w, req)
	})
	return r
}
