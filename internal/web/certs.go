package web

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"

	"github.com/caddyserver/certmagic"
	"golang.org/x/net/publicsuffix"

	"simpletds/internal/model"
)

// managedCert is one auto-TLS domain under certificate management.
type managedCert struct {
	cfg    *certmagic.Config
	email  string
	ca     string
	cancel context.CancelFunc
}

// certManager obtains and renews certificates for auto-TLS domains. Every
// domain is managed explicitly (not on demand), so certmagic's background
// maintenance renews it well before expiry whether or not it gets traffic.
// Each domain uses its own ACME account, registered as acme@<its domain>.
type certManager struct {
	mu      sync.Mutex
	cache   *certmagic.Cache
	storage certmagic.Storage
	managed map[string]*managedCert
	// challenge answers HTTP-01 for every account: pending challenges are
	// process-wide, so any issuer can serve them.
	challenge *certmagic.ACMEIssuer
	onEvent   func(ctx context.Context, event string, data map[string]any) error
}

func newCertManager(dataDir string, onEvent func(context.Context, string, map[string]any) error) *certManager {
	m := &certManager{storage: &certmagic.FileStorage{Path: filepath.Join(dataDir, "certs")},
		managed: map[string]*managedCert{}, onEvent: onEvent}
	var fallback *certmagic.Config
	m.cache = certmagic.NewCache(certmagic.CacheOptions{
		GetConfigForCert: func(cert certmagic.Certificate) (*certmagic.Config, error) {
			m.mu.Lock()
			defer m.mu.Unlock()
			for _, name := range cert.Names {
				if mc := m.managed[strings.ToLower(name)]; mc != nil {
					return mc.cfg, nil
				}
			}
			return fallback, nil
		},
	})
	fallback = certmagic.New(m.cache, certmagic.Config{Storage: m.storage})
	m.challenge = certmagic.NewACMEIssuer(fallback, certmagic.ACMEIssuer{Agreed: true})
	return m
}

// acmeEmail is the contact for the ACME account of a domain: the configured
// address if there is one, otherwise acme@<registrable domain>, so
// shop.sample.com and sample.com share the account acme@sample.com.
func acmeEmail(domain string, st model.Settings) string {
	if st.ACMEEmail != "" {
		return st.ACMEEmail
	}
	base, err := publicsuffix.EffectiveTLDPlusOne(domain)
	if err != nil {
		base = domain
	}
	return "acme@" + base
}

func acmeCA(st model.Settings) string {
	if st.ACMEStaging {
		return certmagic.LetsEncryptStagingCA
	}
	return certmagic.LetsEncryptProductionCA
}

// sync brings the managed set in line with the configured auto-TLS domains:
// new ones start issuance, removed ones stop being renewed, and a changed
// account email or CA re-registers the domain.
func (m *certManager) sync(domains map[string]bool, st model.Settings) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ca := acmeCA(st)
	for name, mc := range m.managed {
		if !domains[name] || mc.email != acmeEmail(name, st) || mc.ca != ca {
			mc.cancel()
			delete(m.managed, name)
			// Takes the cache lock, which may call back into us: do it unlocked.
			go m.cache.RemoveManaged([]certmagic.SubjectIssuer{{Subject: name}})
		}
	}
	for name := range domains {
		if m.managed[name] != nil {
			continue
		}
		cfg := certmagic.New(m.cache, certmagic.Config{Storage: m.storage, OnEvent: m.onEvent})
		email := acmeEmail(name, st)
		cfg.Issuers = []certmagic.Issuer{certmagic.NewACMEIssuer(cfg, certmagic.ACMEIssuer{CA: ca, Email: email, Agreed: true})}
		ctx, cancel := context.WithCancel(context.Background())
		m.managed[name] = &managedCert{cfg: cfg, email: email, ca: ca, cancel: cancel}
		// Async: loads an existing certificate from disk or obtains one,
		// retrying with backoff while DNS is not ready yet.
		go func(name string) {
			if err := cfg.ManageAsync(ctx, []string{name}); err != nil {
				slog.Warn("certificate management failed to start", "domain", name, "err", err)
			}
		}(name)
		slog.Info("managing certificate", "domain", name, "account", email)
	}
}

// certificate returns the certificate for a handshake, or nil when the name
// is not a managed domain or has no certificate yet.
func (m *certManager) certificate(hello *tls.ClientHelloInfo) *tls.Certificate {
	m.mu.Lock()
	mc := m.managed[strings.ToLower(hello.ServerName)]
	m.mu.Unlock()
	if mc == nil {
		return nil
	}
	cert, err := mc.cfg.GetCertificate(hello) // also answers TLS-ALPN challenges
	if err != nil {
		return nil
	}
	return cert
}

// account reports the ACME account email a domain is registered under.
func (m *certManager) account(domain string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if mc := m.managed[domain]; mc != nil {
		return mc.email
	}
	return ""
}

// syncCerts applies the current snapshot to the certificate manager.
func (s *Server) syncCerts() {
	snap := s.eng.Snap()
	auto := map[string]bool{}
	for name, d := range snap.Domains {
		if d.TLSMode == model.TLSAuto {
			auto[name] = true
		}
	}
	s.certs.sync(auto, snap.Settings)
}

// certEvent turns issuance results into domain statuses, so the panel shows
// why a certificate is missing instead of a generic TLS error.
func (s *Server) certEvent(_ context.Context, event string, data map[string]any) error {
	name, _ := data["identifier"].(string)
	d := s.eng.Snap().Domains[strings.ToLower(name)]
	if d == nil {
		return nil
	}
	switch event {
	case "cert_obtained":
		slog.Info("certificate obtained", "domain", name)
		go s.checkDomains(context.Background(), []int64{d.ID})
	case "cert_failed":
		msg := fmt.Sprint(data["error"])
		slog.Warn("certificate not issued", "domain", name, "err", msg)
		if len(msg) > 300 {
			msg = msg[:300]
		}
		go func() {
			ctx := context.Background()
			s.st.SetDomainStatus(ctx, d.ID, "error", "Certificate: "+msg+" (will retry automatically)")
			s.eng.Reload(ctx)
		}()
	}
	return nil
}
