// Package reputation asks third-party services whether a domain is on their
// blocklists: the lists that browsers, mail filters, DNS resolvers and ad
// platforms act on. Every check tells the service the domain name, so nothing
// here runs unless an administrator has switched the provider on.
package reputation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/publicsuffix"

	"simpletds/internal/model"
)

// Outcomes of one provider for one domain.
const (
	Clean  = "clean"
	Listed = "listed"
	Failed = "error" // the provider could not be asked, or did not answer
)

// How a provider uses its key.
const (
	KeyNone     = ""
	KeyRequired = "required"
	KeyOptional = "optional"
)

// Def describes a provider to the panel.
type Def struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Short is the name where space is tight: a chip in a list of domains.
	Short       string `json:"short"`
	Description string `json:"description"`
	Key         string `json:"key"`
	KeyHelp     string `json:"key_help,omitempty"`
	KeyURL      string `json:"key_url,omitempty"`
	// Threshold: the provider counts votes, and the admin sets how many flag a domain.
	Threshold bool `json:"threshold,omitempty"`
	// Rate: the provider has a tight request quota, set per minute.
	Rate bool `json:"rate,omitempty"`
}

var defs = []Def{
	{ID: "gsb", Name: "Google Safe Browsing", Short: "Safe Browsing", Key: KeyRequired,
		Description: "The list behind the red warning page in Chrome, Firefox and Safari, and one of the signals Google Ads uses. The domain's URLs are sent to Google.",
		KeyHelp:     "API key of a Google Cloud project with the Safe Browsing API enabled.",
		KeyURL:      "https://console.cloud.google.com/apis/library/safebrowsing.googleapis.com"},
	{ID: "virustotal", Name: "VirusTotal", Short: "VirusTotal", Key: KeyRequired, Threshold: true, Rate: true,
		Description: "Verdicts of about 90 security vendors at once. Ad platforms and affiliate networks often look here first.",
		KeyHelp:     "The free key allows 4 requests a minute and 500 a day: keep the check interval long enough for your number of domains.",
		KeyURL:      "https://www.virustotal.com/gui/my-apikey"},
	{ID: "spamhaus", Name: "Spamhaus DBL", Short: "Spamhaus", Key: KeyOptional,
		Description: "The domain blocklist most mail providers use: spam, phishing, malware and botnet domains.",
		KeyHelp:     "Without a key the query goes through this server's DNS resolver, which Spamhaus refuses for public resolvers (8.8.8.8, 1.1.1.1). A free Data Query Service key works from anywhere.",
		KeyURL:      "https://www.spamhaus.com/free-trial/sign-up-for-a-free-data-query-service-account/"},
	{ID: "surbl", Name: "SURBL", Short: "SURBL",
		Description: "Domains seen in spam, phishing and malware messages. Asked over DNS; public resolvers are refused."},
	{ID: "uribl", Name: "URIBL", Short: "URIBL",
		Description: "Domains found in unsolicited mail. Asked over DNS; public resolvers are refused."},
	{ID: "cloudflare", Name: "Cloudflare security DNS", Short: "Cloudflare DNS",
		Description: "Whether the malware-blocking resolver 1.1.1.2 refuses to resolve the domain, as it does for its users."},
	{ID: "quad9", Name: "Quad9", Short: "Quad9",
		Description: "Whether the threat-blocking resolver 9.9.9.9 refuses to resolve the domain, as it does for its users."},
}

// Defs lists the providers in display order.
func Defs() []Def { return defs }

// Usable reports whether a provider is switched on and has what it needs.
func Usable(d Def, cfg model.RepProvider) bool {
	return cfg.Enabled && (d.Key != KeyRequired || strings.TrimSpace(cfg.Key) != "")
}

// Checker runs the checks. The zero value is not usable; call New.
type Checker struct {
	http *http.Client
	// lookup resolves host through the given DNS server ("" is the system
	// resolver). A name that does not exist is an empty answer, not an error.
	lookup func(ctx context.Context, server, host string) ([]netip.Addr, error)

	gsbURL, vtURL string
}

func New() *Checker {
	return &Checker{
		http:   &http.Client{Timeout: 20 * time.Second},
		lookup: dnsLookup,
		gsbURL: "https://safebrowsing.googleapis.com/v4/threatMatches:find",
		vtURL:  "https://www.virustotal.com/api/v3/domains/",
	}
}

func dnsLookup(ctx context.Context, server, host string) ([]netip.Addr, error) {
	r := net.DefaultResolver
	if server != "" {
		r = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, net.JoinHostPort(server, "53"))
		}}
	}
	// Generous: Windows takes about 11 seconds to say that a name does not
	// exist, and on a blocklist that is the usual answer.
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	addrs, err := r.LookupNetIP(ctx, "ip", host)
	var de *net.DNSError
	if errors.As(err, &de) && de.IsNotFound {
		return nil, nil
	}
	return addrs, err
}

// Check asks one provider about one domain. It never fails: a provider that
// cannot be asked yields a result with status "error" and the reason. down
// reports a failure that has nothing to do with this domain (a rejected key,
// a spent quota), so asking about the next one is pointless for now.
func (c *Checker) Check(ctx context.Context, id string, cfg model.RepProvider, domain string) (res model.RepResult, down bool) {
	res = model.RepResult{Provider: id, CheckedAt: time.Now().UTC()}
	var (
		listed bool
		err    error
	)
	switch id {
	case "gsb":
		res.URL = "https://transparencyreport.google.com/safe-browsing/search?url=" + url.QueryEscape(domain)
		listed, res.Detail, err = c.safeBrowsing(ctx, cfg.Key, domain)
	case "virustotal":
		res.URL = "https://www.virustotal.com/gui/domain/" + url.PathEscape(domain)
		listed, res.Detail, err = c.virusTotal(ctx, cfg, domain)
	case "spamhaus":
		zone := "dbl.spamhaus.org"
		if key := strings.TrimSpace(cfg.Key); key != "" {
			zone = key + ".dbl.dq.spamhaus.net"
		}
		res.URL = "https://check.spamhaus.org/results/?query=" + url.QueryEscape(domain)
		listed, res.Detail, err = c.dnsbl(ctx, zone, domain, spamhausCode)
	case "surbl":
		res.URL = "https://surbl.org/surbl-analysis"
		listed, res.Detail, err = c.dnsbl(ctx, "multi.surbl.org", domain, surblCode)
	case "uribl":
		res.URL = "https://admin.uribl.com/?section=lookup"
		listed, res.Detail, err = c.dnsbl(ctx, "multi.uribl.com", domain, uriblCode)
	case "cloudflare":
		listed, res.Detail, err = c.cloudflare(ctx, domain)
	case "quad9":
		listed, res.Detail, err = c.quad9(ctx, domain)
	default:
		err = errors.New("unknown provider")
	}
	switch {
	case err != nil:
		res.Status, res.Detail = Failed, short(err)
		down = errors.Is(err, errBadKey) || errors.Is(err, errQuota) || errors.Is(err, errRefused)
	case listed:
		res.Status = Listed
	default:
		res.Status = Clean
	}
	return res, down
}

// short keeps an error presentable: no request URL (it may carry a key) and
// no endless wrapping.
func short(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	msg := err.Error()
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}

// Texts the panel translates; keep them in step with ru.server.json.
var (
	errNoResolve = errors.New("the domain does not resolve")
	errBadKey    = errors.New("the API key was rejected")
	errQuota     = errors.New("the request quota is used up")
	errRefused   = errors.New("query refused: the list does not serve public or high-volume DNS resolvers")
)

const blockedByResolver = "Blocked by the resolver"

// ---- DNS blocklists ---------------------------------------------------------

// names is the domain plus its registrable part when that differs: the lists
// are kept per registered domain, and some only answer for that form.
func names(domain string) []string {
	if base, err := publicsuffix.EffectiveTLDPlusOne(domain); err == nil && base != domain {
		return []string{domain, base}
	}
	return []string{domain}
}

// dnsbl queries name.zone; code turns an answer into a listing or a refusal.
func (c *Checker) dnsbl(ctx context.Context, zone, domain string, code func([4]byte) (string, error)) (bool, string, error) {
	for _, name := range names(domain) {
		addrs, err := c.lookup(ctx, "", name+"."+zone)
		if err != nil {
			return false, "", err
		}
		for _, a := range addrs {
			if !a.Is4() || a.As4()[0] != 127 {
				continue
			}
			detail, err := code(a.As4())
			if err != nil {
				return false, "", err
			}
			if detail != "" {
				return true, detail, nil
			}
		}
	}
	return false, "", nil
}

func spamhausCode(a [4]byte) (string, error) {
	if a[1] == 255 {
		return "", errRefused
	}
	if a[2] != 1 {
		return "", nil
	}
	switch a[3] {
	case 2:
		return "Listed as spam", nil
	case 4:
		return "Listed as phishing", nil
	case 5:
		return "Listed as malware", nil
	case 6:
		return "Listed as botnet C&C", nil
	}
	if a[3] >= 102 && a[3] <= 106 {
		return "Listed as an abused legitimate site", nil
	}
	return "Listed", nil
}

func surblCode(a [4]byte) (string, error) {
	switch x := a[3]; {
	case x == 1:
		return "", errRefused
	case x&16 != 0:
		return "Listed as malware", nil
	case x&8 != 0:
		return "Listed as phishing", nil
	case x&64 != 0:
		return "Listed as spam", nil
	case x&128 != 0:
		return "Listed as an abused legitimate site", nil
	case x != 0:
		return "Listed", nil
	}
	return "", nil
}

func uriblCode(a [4]byte) (string, error) {
	switch x := a[3]; {
	case x&1 != 0:
		return "", errRefused
	case x&2 != 0:
		return "Listed (black list)", nil
	case x&4 != 0:
		return "Listed (grey list)", nil
	case x&8 != 0:
		return "Listed (red list)", nil
	}
	return "", nil
}

// ---- filtering resolvers ----------------------------------------------------

// cloudflare: 1.1.1.2 answers 0.0.0.0 for a domain it blocks.
func (c *Checker) cloudflare(ctx context.Context, domain string) (bool, string, error) {
	addrs, err := c.lookup(ctx, "1.1.1.2", domain)
	if err != nil {
		return false, "", err
	}
	if len(addrs) == 0 {
		return false, "", errNoResolve
	}
	for _, a := range addrs {
		if !a.IsUnspecified() {
			return false, "", nil
		}
	}
	return true, blockedByResolver, nil
}

// quad9: 9.9.9.9 answers "no such domain" for a domain it blocks, so the
// unfiltered 9.9.9.10 tells a block apart from a domain that is simply missing.
func (c *Checker) quad9(ctx context.Context, domain string) (bool, string, error) {
	addrs, err := c.lookup(ctx, "9.9.9.9", domain)
	if err != nil || len(addrs) > 0 {
		return false, "", err
	}
	plain, err := c.lookup(ctx, "9.9.9.10", domain)
	if err != nil {
		return false, "", err
	}
	if len(plain) == 0 {
		return false, "", errNoResolve
	}
	return true, blockedByResolver, nil
}

// ---- HTTP APIs --------------------------------------------------------------

func (c *Checker) call(req *http.Request, out any) error {
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return errNotKnown
	case resp.StatusCode == http.StatusTooManyRequests:
		return errQuota
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden,
		// Google answers a bad key with 400 and says so in the body.
		resp.StatusCode == http.StatusBadRequest && bytes.Contains(body, []byte("API_KEY_INVALID")):
		return errBadKey
	case resp.StatusCode/100 != 2:
		return fmt.Errorf("the service answered HTTP %d", resp.StatusCode)
	}
	return json.Unmarshal(body, out)
}

var errNotKnown = errors.New("not found")

var gsbThreats = map[string]string{
	"MALWARE":                         "Listed as malware",
	"SOCIAL_ENGINEERING":              "Listed as phishing",
	"UNWANTED_SOFTWARE":               "Listed as unwanted software",
	"POTENTIALLY_HARMFUL_APPLICATION": "Listed as a harmful application",
}

func (c *Checker) safeBrowsing(ctx context.Context, key, domain string) (bool, string, error) {
	type entry struct {
		URL string `json:"url"`
	}
	body, _ := json.Marshal(map[string]any{
		"client": map[string]string{"clientId": "crella", "clientVersion": "1"},
		"threatInfo": map[string]any{
			"threatTypes":      []string{"MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"},
			"platformTypes":    []string{"ANY_PLATFORM"},
			"threatEntryTypes": []string{"URL"},
			"threatEntries":    []entry{{"http://" + domain + "/"}, {"https://" + domain + "/"}},
		},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.gsbURL, bytes.NewReader(body))
	if err != nil {
		return false, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	// In a header, so the key never ends up in an error text or a proxy log.
	req.Header.Set("X-Goog-Api-Key", strings.TrimSpace(key))
	var out struct {
		Matches []struct {
			ThreatType string `json:"threatType"`
		} `json:"matches"`
	}
	if err := c.call(req, &out); err != nil {
		return false, "", err
	}
	if len(out.Matches) == 0 {
		return false, "", nil
	}
	detail := gsbThreats[out.Matches[0].ThreatType]
	if detail == "" {
		detail = "Listed"
	}
	return true, detail, nil
}

func (c *Checker) virusTotal(ctx context.Context, cfg model.RepProvider, domain string) (bool, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.vtURL+url.PathEscape(domain), nil)
	if err != nil {
		return false, "", err
	}
	req.Header.Set("x-apikey", strings.TrimSpace(cfg.Key))
	var out struct {
		Data struct {
			Attributes struct {
				Stats map[string]int `json:"last_analysis_stats"`
			} `json:"attributes"`
		} `json:"data"`
	}
	if err := c.call(req, &out); err != nil {
		if errors.Is(err, errNotKnown) {
			return false, "Not known to VirusTotal", nil
		}
		return false, "", err
	}
	stats := out.Data.Attributes.Stats
	bad, total := stats["malicious"]+stats["suspicious"], 0
	for _, n := range stats {
		total += n
	}
	return bad >= max(cfg.Threshold, 1), fmt.Sprintf("%d of %d engines flag the domain", bad, total), nil
}
