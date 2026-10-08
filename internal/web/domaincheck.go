package web

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"simpletds/internal/model"
	"simpletds/internal/store"
)

// probe fetches the check token from a domain over the given scheme.
func (s *Server) probe(ctx context.Context, scheme, host string, verifyTLS bool) error {
	client := &http.Client{
		Timeout: 90 * time.Second, // the first HTTPS hit may wait for certificate issuance
		Transport: &http.Transport{
			TLSClientConfig:   &tls.Config{InsecureSkipVerify: !verifyTLS},
			DisableKeepAlives: true,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, scheme+"://"+host+checkPath, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
	if strings.TrimSpace(string(body)) != s.checkToken(host) {
		return errors.New("the domain answers, but not from this server (DNS points elsewhere, or a proxy is not forwarding to it)")
	}
	return nil
}

// checkDomain verifies a domain end to end: DNS, routing to this server and,
// for auto-TLS domains, a valid certificate.
func (s *Server) checkDomain(ctx context.Context, d model.Domain) (status, msg string) {
	addrs, err := net.DefaultResolver.LookupHost(ctx, d.Name)
	if err != nil || len(addrs) == 0 {
		return "error", "DNS: the domain does not resolve yet"
	}
	where := " (resolves to " + strings.Join(addrs, ", ") + ")"
	if d.TLSMode == model.TLSAuto {
		// HTTP first: it fails fast and tells DNS problems apart from certificate ones.
		if err := s.probe(ctx, "http", d.Name, false); err != nil {
			return "error", "HTTP: " + short(err) + where
		}
		if err := s.probe(ctx, "https", d.Name, true); err != nil {
			return "pending", "Reachable; waiting for the certificate (account " + s.certs.account(d.Name) + ")"
		}
		return "ok", "HTTPS OK, certificate valid and auto-renewing (account " + s.certs.account(d.Name) + ")"
	}
	errS := s.probe(ctx, "https", d.Name, true)
	if errS == nil {
		return "ok", "HTTPS OK through proxy"
	}
	if err := s.probe(ctx, "http", d.Name, false); err != nil {
		return "error", "HTTPS: " + short(errS) + "; HTTP: " + short(err) + where
	}
	return "ok", "HTTP OK through proxy (HTTPS failed: " + short(errS) + ")"
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
			status, msg := s.checkDomain(cctx, d)
			s.st.SetDomainStatus(ctx, d.ID, status, msg)
		}(d)
	}
	wg.Wait()
	if err := s.eng.Reload(ctx); err != nil {
		slog.Error("reload after domain check", "err", err)
	}
}
