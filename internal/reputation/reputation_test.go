package reputation

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"simpletds/internal/model"
)

// fakeDNS answers from a table keyed by "server|host"; a missing key is a
// name that does not exist.
func fakeDNS(table map[string]string) func(context.Context, string, string) ([]netip.Addr, error) {
	return func(_ context.Context, server, host string) ([]netip.Addr, error) {
		v, ok := table[server+"|"+host]
		if !ok {
			return nil, nil
		}
		if v == "fail" {
			return nil, errors.New("i/o timeout")
		}
		return []netip.Addr{netip.MustParseAddr(v)}, nil
	}
}

func TestDNSProviders(t *testing.T) {
	c := New()
	c.lookup = fakeDNS(map[string]string{
		"|bad.example.com.dbl.spamhaus.org":         "127.0.1.4",
		"|open.example.com.dbl.spamhaus.org":        "127.255.255.254",
		"|example.org.dqkey123.dbl.dq.spamhaus.net": "127.0.1.2",
		// Listed under the registered domain only.
		"|example.net.multi.surbl.org":  "127.0.0.16",
		"|example.com.multi.uribl.com":  "127.0.0.1",
		"|grey.example.multi.uribl.com": "127.0.0.4",
		"1.1.1.2|blocked.example":       "0.0.0.0",
		"1.1.1.2|fine.example":          "203.0.113.7",
		"9.9.9.10|blocked.example":      "203.0.113.7",
		"9.9.9.9|fine.example":          "203.0.113.7",
		"9.9.9.9|flaky.example":         "fail",
	})
	for _, tc := range []struct {
		provider, key, domain string
		status, detail        string
		down                  bool
	}{
		{"spamhaus", "", "bad.example.com", Listed, "Listed as phishing", false},
		{"spamhaus", "", "good.example.com", Clean, "", false},
		{"spamhaus", "", "open.example.com", Failed, errRefused.Error(), true},
		{"spamhaus", "dqkey123", "example.org", Listed, "Listed as spam", false},
		{"surbl", "", "go.example.net", Listed, "Listed as malware", false},
		{"surbl", "", "example.org", Clean, "", false},
		{"uribl", "", "example.com", Failed, errRefused.Error(), true},
		{"uribl", "", "grey.example", Listed, "Listed (grey list)", false},
		{"cloudflare", "", "blocked.example", Listed, blockedByResolver, false},
		{"cloudflare", "", "fine.example", Clean, "", false},
		{"cloudflare", "", "missing.example", Failed, errNoResolve.Error(), false},
		{"quad9", "", "blocked.example", Listed, blockedByResolver, false},
		{"quad9", "", "fine.example", Clean, "", false},
		{"quad9", "", "missing.example", Failed, errNoResolve.Error(), false},
		{"quad9", "", "flaky.example", Failed, "i/o timeout", false},
	} {
		res, down := c.Check(context.Background(), tc.provider, model.RepProvider{Enabled: true, Key: tc.key}, tc.domain)
		if res.Status != tc.status || res.Detail != tc.detail || down != tc.down || res.Provider != tc.provider || res.CheckedAt.IsZero() {
			t.Errorf("%s %s: got %+v down=%v, want %s %q down=%v", tc.provider, tc.domain, res, down, tc.status, tc.detail, tc.down)
		}
	}
}

func TestHTTPProviders(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/gsb":
			if r.Header.Get("X-Goog-Api-Key") != "good" {
				w.WriteHeader(http.StatusBadRequest)
				w.Write([]byte(`{"error":{"details":[{"reason":"API_KEY_INVALID"}]}}`))
				return
			}
			body := make([]byte, 2048)
			n, _ := r.Body.Read(body)
			if strings.Contains(string(body[:n]), "https://phish.example/") {
				w.Write([]byte(`{"matches":[{"threatType":"SOCIAL_ENGINEERING"}]}`))
				return
			}
			w.Write([]byte(`{}`))
		case r.Header.Get("x-apikey") == "spent":
			w.WriteHeader(http.StatusTooManyRequests)
		case r.URL.Path == "/vt/new.example":
			w.WriteHeader(http.StatusNotFound)
		case r.URL.Path == "/vt/dirty.example":
			w.Write([]byte(`{"data":{"attributes":{"last_analysis_stats":{"malicious":2,"suspicious":1,"harmless":60,"undetected":31}}}}`))
		default:
			w.Write([]byte(`{"data":{"attributes":{"last_analysis_stats":{"malicious":1,"harmless":62,"undetected":31}}}}`))
		}
	}))
	defer srv.Close()
	c := New()
	c.gsbURL, c.vtURL = srv.URL+"/gsb", srv.URL+"/vt/"

	for _, tc := range []struct {
		provider, key, domain string
		threshold             int
		status, detail        string
		down                  bool
	}{
		{"gsb", "good", "phish.example", 0, Listed, "Listed as phishing", false},
		{"gsb", "good", "fine.example", 0, Clean, "", false},
		{"gsb", "wrong", "fine.example", 0, Failed, errBadKey.Error(), true},
		{"virustotal", "k", "dirty.example", 2, Listed, "3 of 94 engines flag the domain", false},
		{"virustotal", "k", "dirty.example", 5, Clean, "3 of 94 engines flag the domain", false},
		{"virustotal", "k", "fine.example", 2, Clean, "1 of 94 engines flag the domain", false},
		{"virustotal", "k", "new.example", 2, Clean, "Not known to VirusTotal", false},
		{"virustotal", "spent", "fine.example", 2, Failed, errQuota.Error(), true},
	} {
		res, down := c.Check(context.Background(), tc.provider, model.RepProvider{Enabled: true, Key: tc.key, Threshold: tc.threshold}, tc.domain)
		if res.Status != tc.status || res.Detail != tc.detail || down != tc.down || res.URL == "" {
			t.Errorf("%s %s: got %+v down=%v, want %s %q down=%v", tc.provider, tc.domain, res, down, tc.status, tc.detail, tc.down)
		}
	}

	// A transport error must not carry the request URL into what the panel shows.
	c.vtURL = "http://127.0.0.1:1/secret-path/"
	if res, _ := c.Check(context.Background(), "virustotal", model.RepProvider{Key: "k"}, "fine.example"); res.Status != Failed || strings.Contains(res.Detail, "secret-path") {
		t.Errorf("transport error: %+v", res)
	}
}

func TestUsable(t *testing.T) {
	byID := map[string]Def{}
	for _, d := range Defs() {
		byID[d.ID] = d
	}
	if Usable(byID["gsb"], model.RepProvider{Enabled: true}) || !Usable(byID["gsb"], model.RepProvider{Enabled: true, Key: "k"}) {
		t.Error("a provider that needs a key is usable only with one")
	}
	if !Usable(byID["spamhaus"], model.RepProvider{Enabled: true}) || Usable(byID["surbl"], model.RepProvider{}) {
		t.Error("keyless providers follow the switch alone")
	}
}
