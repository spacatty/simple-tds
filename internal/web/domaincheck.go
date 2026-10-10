package web

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"simpletds/internal/model"
	"simpletds/internal/store"
)

// probeSeen is how a check request looked when it reached the traffic port.
type probeSeen struct {
	arrived   bool
	host      string // the Host header it carried
	forwarded bool   // it carried headers only a proxy adds
}

// proxyHeaders are added by HTTP proxies and CDNs, never by the checker.
var proxyHeaders = []string{"Via", "Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP", "CF-Ray", "CF-Connecting-IP"}

// answerCheck serves a one-time key of a check in progress and notes how the
// request arrived. Any other key is not answered, so the path tells a scanner
// nothing about what runs here.
func (s *Server) answerCheck(w http.ResponseWriter, r *http.Request, key string) bool {
	s.probeMu.Lock()
	p := s.probes[key]
	if p != nil {
		p.arrived, p.host = true, hostOnly(r.Host)
		for _, h := range proxyHeaders {
			if r.Header.Get(h) != "" {
				p.forwarded = true
			}
		}
	}
	s.probeMu.Unlock()
	if p == nil {
		return false
	}
	w.Header().Set("Cache-Control", "no-store")
	io.WriteString(w, s.checkToken(key))
	return true
}

// probe asks a domain over the given scheme for the answer to a fresh
// one-time key. The answer does not depend on the Host header, so it proves
// the request reached this server whatever a proxy in between did to it.
func (s *Server) probe(ctx context.Context, scheme, host string, verifyTLS bool) (probeSeen, error) {
	raw := make([]byte, 16)
	rand.Read(raw)
	key := hex.EncodeToString(raw)
	seen := &probeSeen{}
	s.probeMu.Lock()
	if s.probes == nil {
		s.probes = map[string]*probeSeen{}
	}
	s.probes[key] = seen
	s.probeMu.Unlock()
	defer func() {
		s.probeMu.Lock()
		delete(s.probes, key)
		s.probeMu.Unlock()
	}()

	path := checkPath + "/" + key
	client := &http.Client{
		Timeout: 90 * time.Second, // the first HTTPS hit may wait for certificate issuance
		Transport: &http.Transport{
			TLSClientConfig:   &tls.Config{InsecureSkipVerify: !verifyTLS},
			DisableKeepAlives: true,
		},
		// A CDN may send plain HTTP on to HTTPS; nothing else is followed.
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 3 || !strings.EqualFold(req.URL.Hostname(), host) || req.URL.Path != path {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, scheme+"://"+host+path, nil)
	if err != nil {
		return probeSeen{}, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return probeSeen{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
	s.probeMu.Lock()
	got := *seen
	s.probeMu.Unlock()
	if strings.TrimSpace(string(body)) != s.checkToken(key) {
		return got, errors.New("the domain answers, but not from this server (DNS points elsewhere, or a proxy is not forwarding to it)")
	}
	if got.host != host {
		// It gets here, but under a name no domain is served on.
		return got, errors.New("a proxy forwards the domain here as \"" + got.host + "\"; it must pass the original Host header")
	}
	return got, nil
}

// pointsHere reports whether one of the addresses a domain resolves to is
// this server's own. known is false when the server has no idea of its public
// address, and then nothing can be said either way.
func (s *Server) pointsHere(addrs []string) (here, known bool) {
	own := map[netip.Addr]bool{}
	if a, err := netip.ParseAddr(s.serverIP()); err == nil {
		own[a.Unmap()] = true
		known = true
	}
	if ifaces, err := net.InterfaceAddrs(); err == nil {
		for _, ia := range ifaces {
			if p, err := netip.ParsePrefix(ia.String()); err == nil {
				own[p.Addr().Unmap()] = true
			}
		}
	}
	for _, raw := range addrs {
		a, err := netip.ParseAddr(raw)
		if err != nil {
			continue
		}
		if a = a.Unmap(); own[a] || a.IsLoopback() {
			return true, true
		}
	}
	return false, known
}

// domainCheck is the outcome of checking one domain.
type domainCheck struct {
	status, msg string
	ips         []string // what the name resolves to
	proxied     bool     // reaches this server through somebody else's address
}

// checkDomain verifies a domain end to end: DNS, routing to this server and,
// for auto-TLS domains, a valid certificate. A domain that answers the
// one-time key while its DNS points elsewhere is behind a proxy.
func (s *Server) checkDomain(ctx context.Context, d model.Domain) domainCheck {
	addrs, err := net.DefaultResolver.LookupHost(ctx, d.Name)
	if err != nil || len(addrs) == 0 {
		return domainCheck{status: "error", msg: "DNS: the domain does not resolve yet"}
	}
	if len(addrs) > 8 {
		addrs = addrs[:8]
	}
	c := domainCheck{ips: addrs}
	here, known := s.pointsHere(addrs)
	reached := func(p probeSeen) { c.proxied = c.proxied || p.forwarded || known && !here }
	done := func(status, msg string) domainCheck {
		c.status, c.msg = status, msg
		return c
	}

	if d.TLSMode == model.TLSAuto {
		// HTTP first: it fails fast and tells DNS problems apart from certificate ones.
		p, err := s.probe(ctx, "http", d.Name, false)
		if err != nil {
			return done("error", "HTTP: "+short(err))
		}
		reached(p)
		p, err = s.probe(ctx, "https", d.Name, true)
		if err != nil {
			return done("pending", "Reachable; waiting for the certificate (account "+s.certs.account(d.Name)+")")
		}
		reached(p)
		if c.proxied {
			return done("ok", "HTTPS OK through proxy")
		}
		return done("ok", "HTTPS OK, certificate valid and auto-renewing (account "+s.certs.account(d.Name)+")")
	}
	p, errS := s.probe(ctx, "https", d.Name, true)
	if errS == nil {
		reached(p)
		return done("ok", "HTTPS OK through proxy")
	}
	p, err = s.probe(ctx, "http", d.Name, false)
	if err != nil {
		return done("error", "HTTPS: "+short(errS)+"; HTTP: "+short(err))
	}
	reached(p)
	if !c.proxied {
		return done("ok", "HTTP OK (HTTPS failed: "+short(errS)+")")
	}
	return done("ok", "HTTP OK through proxy (HTTPS failed: "+short(errS)+")")
}

func short(err error) string {
	msg := err.Error()
	if i := strings.LastIndex(msg, ": "); i >= 0 && len(msg) > 160 {
		msg = msg[i+2:]
	}
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}

// checkDomains re-verifies the given domains (all when ids is nil) and
// publishes the new statuses.
func (s *Server) checkDomains(ctx context.Context, ids []int64) {
	s.checkMu.Lock()
	defer s.checkMu.Unlock()
	domains, err := store.List[model.Domain](ctx, s.st, "domains", "id")
	if err != nil {
		return
	}
	want := map[int64]bool{}
	for _, id := range ids {
		want[id] = true
	}
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for _, d := range domains {
		if ids != nil && !want[d.ID] || !d.Enabled {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(d model.Domain) {
			defer wg.Done()
			defer func() { <-sem }()
			cctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
			defer cancel()
			c := s.checkDomain(cctx, d)
			s.st.SetDomainCheck(ctx, d.ID, c.status, c.msg, c.ips, c.proxied)
		}(d)
	}
	wg.Wait()
	if err := s.eng.Reload(ctx); err != nil {
		slog.Error("reload after domain check", "err", err)
	}
}
