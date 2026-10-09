package web

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strings"

	"simpletds/internal/engine"
	"simpletds/internal/model"
	"simpletds/internal/whitepage"
)

const (
	checkPath    = "/.well-known/tds-check"
	postbackPath = "/postback"
	jsPrefix     = "/_j/"
	eventPrefix  = engine.EventPrefix
	phpAPIPath   = "/_api/click"
	maxBody      = 1 << 20
)

// ReservedAliases cannot be used as campaign aliases: they are routes.
var ReservedAliases = []string{"postback", "_a", "_j", "_e", "_api", ".well-known", "favicon.ico", "robots.txt"}

func hostOnly(hostport string) string {
	h := hostport
	if i := strings.LastIndexByte(h, ':'); i >= 0 && !strings.HasSuffix(h, "]") {
		h = h[:i]
	}
	return strings.ToLower(strings.Trim(h, "[]"))
}

func remoteAddr(r *http.Request) netip.Addr {
	if ap, err := netip.ParseAddrPort(r.RemoteAddr); err == nil {
		return ap.Addr().Unmap()
	}
	return netip.IPv4Unspecified()
}

// clientIP returns the visitor address according to the domain's real-IP
// source. Forwarding headers are honoured only from trusted proxies, so a
// visitor cannot spoof them on a directly exposed domain.
func clientIP(r *http.Request, source string, snap *engine.Snapshot) netip.Addr {
	remote := remoteAddr(r)
	if source == "" || source == model.IPDirect || !snap.Trusted.Contains(remote) {
		return remote
	}
	parse := func(s string) (netip.Addr, bool) {
		a, err := netip.ParseAddr(strings.TrimSpace(s))
		return a.Unmap(), err == nil
	}
	switch source {
	case model.IPCF:
		if a, ok := parse(r.Header.Get("CF-Connecting-IP")); ok {
			return a
		}
	case model.IPXReal:
		if a, ok := parse(r.Header.Get("X-Real-IP")); ok {
			return a
		}
	case model.IPXFF:
		// Walk from the right: the first hop that is not one of our proxies
		// is the client. Anything further left is client-controlled.
		parts := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
		for i := len(parts) - 1; i >= 0; i-- {
			if a, ok := parse(parts[i]); ok && !snap.Trusted.Contains(a) {
				return a
			}
		}
	}
	return remote
}

// panelIP is the address of whoever is using the panel. Behind a CDN every
// user shares the proxy's socket address, and with it one login rate limit.
func panelIP(r *http.Request) netip.Addr {
	if a, ok := r.Context().Value(clientIPKey).(netip.Addr); ok {
		return a
	}
	return remoteAddr(r)
}

func isSecure(r *http.Request, snap *engine.Snapshot) bool {
	if r.TLS != nil {
		return true
	}
	if !snap.Trusted.Contains(remoteAddr(r)) {
		return false
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") || strings.Contains(r.Header.Get("CF-Visitor"), "https")
}

func (s *Server) checkToken(host string) string {
	m := hmac.New(sha256.New, s.cfg.Secret)
	m.Write([]byte("domain-check|" + host))
	return "tds-" + hex.EncodeToString(m.Sum(nil)[:12])
}

func stock404(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html")
	w.Header().Set("Server", "nginx")
	w.WriteHeader(http.StatusNotFound)
	io.WriteString(w, "<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n")
}

// servePublic handles everything arriving on the traffic ports.
func (s *Server) servePublic(w http.ResponseWriter, r *http.Request) {
	snap := s.eng.Snap()
	host := hostOnly(r.Host)
	path := r.URL.Path

	if strings.HasPrefix(path, checkPath) {
		// Proves to the domain checker that this hostname reaches this server.
		io.WriteString(w, s.checkToken(host))
		return
	}
	d := snap.Domains[host]
	if d == nil {
		stock404(w)
		return
	}
	w.Header().Set("Server", "nginx")

	if d.AdminEnabled {
		prefix := "/" + snap.Settings.AdminPath
		if path == prefix {
			http.Redirect(w, r, prefix+"/", http.StatusFound)
			return
		}
		if strings.HasPrefix(path, prefix+"/") {
			r = r.WithContext(context.WithValue(r.Context(), clientIPKey, clientIP(r, d.IPSource, snap)))
			http.StripPrefix(prefix, s.panel).ServeHTTP(w, r)
			return
		}
	}

	switch {
	case path == postbackPath:
		s.servePostback(w, r, clientIP(r, d.IPSource, snap))
	case strings.HasPrefix(path, whitepage.AssetPrefix):
		s.serveAsset(w, r, d, snap)
	case strings.HasPrefix(path, jsPrefix):
		alias := strings.TrimSuffix(strings.TrimPrefix(path, jsPrefix), ".js")
		if c := snap.ByAlias[strings.ToLower(alias)]; c != nil && c.UsableBy(d.OwnerID) {
			s.serveJS(w, r, d, c, snap)
		} else {
			stock404(w)
		}
	case strings.HasPrefix(path, eventPrefix):
		s.serveEvent(w, r, d, snap)
	case path == phpAPIPath:
		s.servePHPAPI(w, r, d, snap)
	case path == "/":
		if d.Campaign == nil {
			stock404(w)
			return
		}
		s.serveClick(w, r, d, d.Campaign, snap)
	default:
		// A campaign answers only on domains of people who run it, so one
		// user's links never work on another user's domain.
		alias, _, _ := strings.Cut(path[1:], "/")
		if c := snap.ByAlias[strings.ToLower(alias)]; c != nil && c.UsableBy(d.OwnerID) {
			s.serveClick(w, r, d, c, snap)
		} else {
			stock404(w)
		}
	}
}

func cookieGetter(r *http.Request) func(string) string {
	return func(name string) string {
		if c, err := r.Cookie(name); err == nil {
			return c.Value
		}
		return ""
	}
}

func readBody(w http.ResponseWriter, r *http.Request) []byte {
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		return nil
	}
	b, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	return b
}

// serveClick is the direct integration: the visitor opens the campaign URL.
func (s *Server) serveClick(w http.ResponseWriter, r *http.Request, d *engine.DomainRT, c *engine.CampaignRT, snap *engine.Snapshot) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	res := s.eng.Process(&engine.Input{
		Ctx: r.Context(), Integration: "direct", Campaign: c, Domain: d.Name, Path: r.URL.Path, Method: r.Method,
		IP: clientIP(r, d.IPSource, snap), Header: r.Header, Query: r.URL.Query(), Referer: r.Referer(),
		Proto: r.Proto, Secure: isSecure(r, snap), TLS: tlsInfo(r), Cookie: cookieGetter(r), Body: readBody(w, r),
	})
	writeResult(w, r, res)
}

func writeResult(w http.ResponseWriter, r *http.Request, res *engine.Result) {
	h := w.Header()
	for k, vals := range res.Header {
		h[k] = vals
	}
	for _, c := range res.Cookies {
		http.SetCookie(w, c)
	}
	if h.Get("Cache-Control") == "" {
		h.Set("Cache-Control", "no-store, no-cache, must-revalidate")
	}
	if res.Location != "" && res.Status >= 300 && res.Status < 400 {
		h.Set("Location", res.Location)
		w.WriteHeader(res.Status)
		return
	}
	status := res.Status
	if status == 0 {
		status = http.StatusOK
	}
	if res.ContentType != "" {
		h.Set("Content-Type", res.ContentType)
	}
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		w.Write(res.Body)
	}
}

// serveJS is the JS integration: a page embeds a script that reports its own
// URL parameters and referrer, and receives the stream action as JavaScript.
func (s *Server) serveJS(w http.ResponseWriter, r *http.Request, d *engine.DomainRT, c *engine.CampaignRT, snap *engine.Snapshot) {
	q := r.URL.Query()
	referer := q.Get("_ref")
	// Tracking parameters live on the embedding page, not on the script URL.
	if page, err := url.Parse(q.Get("_url")); err == nil {
		for k, vals := range page.Query() {
			if _, ok := q[k]; !ok {
				q[k] = vals
			}
		}
	}
	res := s.eng.Process(&engine.Input{
		Ctx: r.Context(), Integration: "js", Campaign: c, Domain: d.Name, Path: r.URL.Path, Method: http.MethodGet,
		IP: clientIP(r, d.IPSource, snap), Header: r.Header, Query: q, Referer: referer,
		Proto: r.Proto, Secure: isSecure(r, snap), TLS: tlsInfo(r),
	})
	h := w.Header()
	h.Set("Content-Type", "application/javascript; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	w.Write(res.AsScript())
}

type phpClick struct {
	Token   string            `json:"token"`
	IP      string            `json:"ip"`
	Headers map[string]string `json:"headers"`
	Query   string            `json:"query"`
	Referer string            `json:"referer"`
	Host    string            `json:"host"`
	URI     string            `json:"uri"`
	Secure  bool              `json:"https"`
}

type phpAnswer struct {
	Status      int               `json:"status"`
	Location    string            `json:"location,omitempty"`
	ContentType string            `json:"content_type,omitempty"`
	Body        string            `json:"body"`
	Headers     map[string]string `json:"headers,omitempty"`
	ClickID     string            `json:"click_id,omitempty"`
}

// servePHPAPI is the server-side integration: the customer's own site
// forwards each visitor and applies whatever the tracker answers.
func (s *Server) servePHPAPI(w http.ResponseWriter, r *http.Request, d *engine.DomainRT, snap *engine.Snapshot) {
	if r.Method != http.MethodPost {
		stock404(w)
		return
	}
	var in phpClick
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&in); err != nil || in.Token == "" {
		stock404(w)
		return
	}
	var c *engine.CampaignRT
	for _, cand := range snap.ByID {
		if cand.Enabled && cand.UsableBy(d.OwnerID) && hmac.Equal([]byte(cand.Token), []byte(in.Token)) {
			c = cand
		}
	}
	if c == nil {
		stock404(w)
		return
	}
	ip, err := netip.ParseAddr(strings.TrimSpace(in.IP))
	if err != nil {
		ip = clientIP(r, d.IPSource, snap)
	}
	header := http.Header{}
	for k, v := range in.Headers {
		header.Set(k, v)
	}
	q, _ := url.ParseQuery(in.Query)
	host := in.Host
	if host == "" {
		host = d.Name
	}
	res := s.eng.Process(&engine.Input{
		Ctx: r.Context(), Integration: "php", Campaign: c, Domain: hostOnly(host), Path: in.URI, Method: http.MethodGet,
		IP: ip, Header: header, Query: q, Referer: in.Referer, Secure: in.Secure,
	})
	out := phpAnswer{Status: res.Status, Location: res.Location, ContentType: res.ContentType, Body: string(res.Body), Headers: map[string]string{}}
	if out.Status == 0 {
		out.Status = http.StatusOK
	}
	if out.Location != "" && (out.Status < 300 || out.Status > 399) {
		out.Status = http.StatusFound // meta/js redirects become real ones server-side
	}
	for k, vals := range res.Header {
		if len(vals) > 0 && k != "Set-Cookie" {
			out.Headers[k] = vals[0]
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// servePostback accepts a conversion by GET or POST (form or flat JSON).
func (s *Server) servePostback(w http.ResponseWriter, r *http.Request, ip netip.Addr) {
	params := r.URL.Query()
	if r.Method == http.MethodPost {
		body, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
		if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			var doc map[string]any
			if json.Unmarshal(body, &doc) == nil {
				for k, v := range doc {
					switch t := v.(type) {
					case string:
						params.Set(k, t)
					case float64, bool:
						b, _ := json.Marshal(t)
						params.Set(k, string(b))
					}
				}
			}
		} else if form, err := url.ParseQuery(string(body)); err == nil {
			for k, vals := range form {
				params[k] = vals
			}
		}
	}
	status, body := s.eng.Postback(&engine.PostbackInput{Ctx: r.Context(), IP: ip, Params: params,
		HeaderKey: r.Header.Get("X-TDS-Key"), HeaderSig: r.Header.Get("X-TDS-Signature")})
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	io.WriteString(w, body)
}

// serveEvent records a public funnel stage reported by the visitor's browser:
// /_e/<stage>?cid=<click id> (or any other name of click_id), as a beacon, a pixel or a fetch from any origin.
// &outcome=<key> says how the stage ended; a few other parameters are kept with the event.
// The answer never tells whether the event was accepted.
func (s *Server) serveEvent(w http.ResponseWriter, r *http.Request, d *engine.DomainRT, snap *engine.Snapshot) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Cache-Control", "no-store")
	if r.Method == http.MethodGet || r.Method == http.MethodPost {
		q := r.URL.Query()
		s.eng.Event(&engine.EventInput{Ctx: r.Context(), IP: clientIP(r, d.IPSource, snap), OwnerID: d.OwnerID,
			ClickID: snap.Params.Get(q, "click_id"), Stage: strings.TrimPrefix(r.URL.Path, eventPrefix), Params: q})
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) pageRequest(r *http.Request, w http.ResponseWriter, host string, ip netip.Addr, secure bool) *whitepage.Request {
	return &whitepage.Request{Method: r.Method, URI: r.URL.RequestURI(), Query: r.URL.RawQuery, Host: host,
		RemoteIP: ip.String(), Secure: secure, Header: r.Header, Body: readBody(w, r)}
}

// serveAsset serves whitepage and landing files and sub-pages under /_a/<key>/.
func (s *Server) serveAsset(w http.ResponseWriter, r *http.Request, d *engine.DomainRT, snap *engine.Snapshot) {
	key, sub, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, whitepage.AssetPrefix), "/")
	wp := snap.WhitepageKeys[key]
	if wp == nil {
		if l := snap.LandingKeys[key]; l != nil {
			s.serveLanding(w, r, d, l, sub, snap)
			return
		}
		stock404(w)
		return
	}
	s.pages.Serve(w, r, wp, sub, s.pageRequest(r, w, d.Name, clientIP(r, d.IPSource, snap), isSecure(r, snap)), true)
}
