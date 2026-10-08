// Package web is the HTTP surface: traffic listeners (HTTP, HTTPS with
// automatic certificates, PROXY protocol), the campaign endpoints and the
// admin panel API.
package web

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/mholt/acmez/v3"
	"github.com/pires/go-proxyproto"

	"simpletds/internal/antibot"
	"simpletds/internal/engine"
	"simpletds/internal/events"
	"simpletds/internal/geo"
	"simpletds/internal/store"
	"simpletds/internal/whitepage"
)

type Config struct {
	HTTPAddr  string
	HTTPSAddr string
	PanelAddr string
	DataDir   string
	Secret    []byte
	// ForcePanelIP keeps ip:port panel access on regardless of settings (rescue switch).
	ForcePanelIP bool
}

type Server struct {
	cfg    Config
	st     *store.Store
	ev     *events.DB
	eng    *engine.Engine
	geo    *geo.DB
	lists  *antibot.Lists
	pages  *whitepage.Manager
	panel  http.Handler
	certs  *certManager
	selfTS *tls.Certificate

	sessMu   sync.Mutex
	sessions map[string]sessionEntry

	// needSetup is true until the first administrator exists; see setup.
	needSetup atomic.Bool
	setupMu   sync.Mutex

	publicIP atomic.Value // string; this server's public address, for DNS hints

	checkMu sync.Mutex
	servers []*http.Server
}

func New(cfg Config, st *store.Store, ev *events.DB, eng *engine.Engine, g *geo.DB, lists *antibot.Lists, pages *whitepage.Manager) (*Server, error) {
	s := &Server{cfg: cfg, st: st, ev: ev, eng: eng, geo: g, lists: lists, pages: pages, sessions: map[string]sessionEntry{}}
	cert, err := selfSigned()
	if err != nil {
		return nil, err
	}
	s.selfTS = cert
	var users int
	if err := st.Pool.QueryRow(context.Background(), "SELECT count(*) FROM users").Scan(&users); err != nil {
		return nil, err
	}
	if users == 0 {
		s.needSetup.Store(true)
		slog.Info("no users yet: open the panel to create the administrator")
	}
	s.panel = s.panelHandler()
	s.certs = newCertManager(cfg.DataDir, s.certEvent)
	return s, nil
}

func selfSigned() (*tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tmpl := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: "localhost"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(10, 0, 0),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames: []string{"localhost"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	return &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

// fpConn carries the TLS fingerprint from the handshake to the request.
type fpConn struct {
	net.Conn
	tls *antibot.TLSInfo
}

type fpListener struct{ net.Listener }

func (l fpListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &fpConn{Conn: c}, nil
}

type ctxKey int

const (
	tlsInfoKey ctxKey = 1
	// clientIPKey carries the visitor address of a panel request that came
	// through a domain, where the socket address may be a proxy's.
	clientIPKey ctxKey = 2
)

func (s *Server) tlsConfig() *tls.Config {
	cfg := &tls.Config{NextProtos: []string{"h2", "http/1.1", acmez.ACMETLS1Protocol}, MinVersion: tls.VersionTLS12}
	cfg.GetCertificate = func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
		if cert := s.certs.certificate(hello); cert != nil {
			return cert, nil
		}
		// Proxied domains (the CDN does not validate the origin certificate),
		// domains still waiting for their certificate and unknown names get
		// a throwaway one.
		return s.selfTS, nil
	}
	cfg.GetConfigForClient = func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
		if c, ok := hello.Conn.(*fpConn); ok {
			c.tls = antibot.Fingerprint(hello)
		}
		return nil, nil
	}
	return cfg
}

// proxyPolicy accepts a PROXY protocol header only from trusted proxies, and
// only while the feature is switched on. It reads live settings, so toggling
// it needs no restart.
func (s *Server) proxyPolicy(upstream net.Addr) (proxyproto.Policy, error) {
	snap := s.eng.Snap()
	if !snap.Settings.ProxyProtocol {
		return proxyproto.SKIP, nil
	}
	if ap, err := netip.ParseAddrPort(upstream.String()); err == nil && snap.Trusted.Contains(ap.Addr()) {
		return proxyproto.USE, nil
	}
	return proxyproto.REJECT, nil
}

func (s *Server) newHTTPServer(h http.Handler) *http.Server {
	srv := &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    32 << 10,
		ErrorLog:          slog.NewLogLogger(slog.Default().Handler(), slog.LevelDebug),
		ConnContext: func(ctx context.Context, c net.Conn) context.Context {
			if tc, ok := c.(*tls.Conn); ok {
				if fc, ok := tc.NetConn().(*fpConn); ok {
					return context.WithValue(ctx, tlsInfoKey, fc)
				}
			}
			return ctx
		},
	}
	s.servers = append(s.servers, srv)
	return srv
}

func tlsInfo(r *http.Request) *antibot.TLSInfo {
	if fc, ok := r.Context().Value(tlsInfoKey).(*fpConn); ok {
		return fc.tls
	}
	return nil
}

// Run starts every listener and blocks until one fails or ctx ends.
func (s *Server) Run(ctx context.Context) error {
	errc := make(chan error, 3)
	listen := func(addr string) (net.Listener, error) {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			return nil, err
		}
		return &proxyproto.Listener{Listener: ln, Policy: s.proxyPolicy, ReadHeaderTimeout: 5 * time.Second}, nil
	}

	public := http.HandlerFunc(s.servePublic)
	if s.cfg.HTTPAddr != "" {
		ln, err := listen(s.cfg.HTTPAddr)
		if err != nil {
			return err
		}
		srv := s.newHTTPServer(s.certs.challenge.HTTPChallengeHandler(public))
		go func() { errc <- srv.Serve(ln) }()
		slog.Info("http listening", "addr", s.cfg.HTTPAddr)
	}
	if s.cfg.HTTPSAddr != "" {
		ln, err := listen(s.cfg.HTTPSAddr)
		if err != nil {
			return err
		}
		srv := s.newHTTPServer(public)
		srv.TLSConfig = s.tlsConfig()
		go func() { errc <- srv.ServeTLS(fpListener{ln}, "", "") }()
		slog.Info("https listening", "addr", s.cfg.HTTPSAddr)
	}
	if s.cfg.PanelAddr != "" {
		ln, err := net.Listen("tcp", s.cfg.PanelAddr)
		if err != nil {
			return err
		}
		srv := s.newHTTPServer(http.HandlerFunc(s.servePanelPort))
		go func() { errc <- srv.Serve(ln) }()
		slog.Info("panel listening", "addr", s.cfg.PanelAddr)
	}
	s.syncCerts()
	go s.background(ctx)

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		for _, srv := range s.servers {
			srv.Shutdown(sctx)
		}
		return nil
	}
}

// serverIP is the address users should point their domains at.
func (s *Server) serverIP() string {
	ip, _ := s.publicIP.Load().(string)
	return ip
}

// detectPublicIP learns the server's public address: from TDS_PUBLIC_IP if
// set, otherwise by asking an echo service. Purely informational.
func (s *Server) detectPublicIP(ctx context.Context) {
	if ip := strings.TrimSpace(os.Getenv("TDS_PUBLIC_IP")); ip != "" {
		s.publicIP.Store(ip)
		return
	}
	client := &http.Client{Timeout: 5 * time.Second}
	for _, u := range []string{"https://1.1.1.1/cdn-cgi/trace", "https://api.ipify.org"} {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		text := strings.TrimSpace(string(body))
		for _, line := range strings.Split(text, "\n") {
			if v, ok := strings.CutPrefix(line, "ip="); ok {
				text = v
			}
		}
		if addr, err := netip.ParseAddr(strings.TrimSpace(text)); err == nil {
			s.publicIP.Store(addr.String())
			return
		}
	}
}

// background runs the periodic jobs: list and geo refresh, domain checks.
func (s *Server) background(ctx context.Context) {
	go s.detectPublicIP(ctx)
	s.lists.Reload(ctx)
	go func() {
		s.lists.Refresh(ctx, 0, false)
		s.geo.Refresh(ctx, s.eng.Snap().Settings, false)
	}()
	go s.checkDomains(ctx, nil)
	hourly := time.NewTicker(time.Hour)
	checks := time.NewTicker(30 * time.Minute)
	defer hourly.Stop()
	defer checks.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-hourly.C:
			s.lists.Refresh(ctx, 0, false)
			s.geo.Refresh(ctx, s.eng.Snap().Settings, false)
		case <-checks.C:
			s.checkDomains(ctx, nil)
		}
	}
}

// servePanelPort is the ip:port panel. It can be switched off once a verified
// domain serves the panel instead.
func (s *Server) servePanelPort(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.ForcePanelIP && !s.eng.Snap().Settings.PanelIPAccess {
		drop(w)
		return
	}
	s.panel.ServeHTTP(w, r)
}

// drop closes the connection without an HTTP response where possible, so the
// port looks dead to scanners.
func drop(w http.ResponseWriter) {
	if hj, ok := w.(http.Hijacker); ok {
		if c, _, err := hj.Hijack(); err == nil {
			c.Close()
			return
		}
	}
	w.WriteHeader(http.StatusNotFound)
}
