package engine

import (
	"fmt"
	"net/netip"
	"regexp"
	"strconv"
	"strings"

	"simpletds/internal/antibot"
	"simpletds/internal/model"
)

// FilterDef describes a stream filter to the panel and builds its matcher.
type FilterDef struct {
	Type    string   `json:"type"`
	Label   string   `json:"label"`
	Group   string   `json:"group"`
	Input   string   `json:"input"` // countries | select | tags | lines | none
	Options []string `json:"options,omitempty"`
	Help    string   `json:"help,omitempty"`
	build   func(values []string) (func(*Visit) bool, error)
}

// lowerSet matches a visitor attribute against a case-insensitive value list.
func lowerSet(get func(*Visit) string) func([]string) (func(*Visit) bool, error) {
	return func(values []string) (func(*Visit) bool, error) {
		set := make(map[string]bool, len(values))
		for _, v := range values {
			if v = strings.ToLower(strings.TrimSpace(v)); v != "" {
				set[v] = true
			}
		}
		return func(v *Visit) bool { return set[strings.ToLower(get(v))] }, nil
	}
}

// contains matches when the attribute contains any value; a value written as
// /pattern/ is a regular expression.
func contains(get func(*Visit) string) func([]string) (func(*Visit) bool, error) {
	return func(values []string) (func(*Visit) bool, error) {
		var subs []string
		var res []*regexp.Regexp
		for _, v := range values {
			v = strings.TrimSpace(v)
			if v == "" {
				continue
			}
			if len(v) > 2 && strings.HasPrefix(v, "/") && strings.HasSuffix(v, "/") {
				re, err := regexp.Compile("(?i)" + v[1:len(v)-1])
				if err != nil {
					return nil, fmt.Errorf("bad pattern %s: %w", v, err)
				}
				res = append(res, re)
				continue
			}
			subs = append(subs, strings.ToLower(v))
		}
		return func(v *Visit) bool {
			s := get(v)
			low := strings.ToLower(s)
			for _, sub := range subs {
				if strings.Contains(low, sub) {
					return true
				}
			}
			for _, re := range res {
				if re.MatchString(s) {
					return true
				}
			}
			return false
		}, nil
	}
}

func flag(get func(*Visit) bool) func([]string) (func(*Visit) bool, error) {
	return func([]string) (func(*Visit) bool, error) { return get, nil }
}

var filterDefs = []FilterDef{
	{Type: "country", Label: "Country", Group: "Geo", Input: "countries",
		build: lowerSet(func(v *Visit) string { return v.Geo.Country })},
	{Type: "region", Label: "Region", Group: "Geo", Input: "tags",
		build: lowerSet(func(v *Visit) string { return v.Geo.Region })},
	{Type: "city", Label: "City", Group: "Geo", Input: "tags",
		build: lowerSet(func(v *Visit) string { return v.Geo.City })},
	{Type: "language", Label: "Browser language", Group: "Geo", Input: "tags", Help: "Two-letter codes: ru, en, de",
		build: lowerSet(func(v *Visit) string { return v.Lang })},

	{Type: "device_type", Label: "Device type", Group: "Device", Input: "select",
		Options: []string{"desktop", "mobile", "tablet", "tv", "bot", "unknown"},
		build:   lowerSet(func(v *Visit) string { return v.UA.DeviceType })},
	{Type: "os", Label: "OS", Group: "Device", Input: "select",
		Options: []string{"Windows", "Android", "iOS", "macOS", "Linux", "ChromeOS", "Windows Phone"},
		build:   lowerSet(func(v *Visit) string { return v.UA.OS })},
	{Type: "browser", Label: "Browser", Group: "Device", Input: "select",
		Options: []string{"Chrome", "Safari", "Firefox", "Edge", "Opera", "Opera Mini", "Samsung Browser", "YaBrowser", "UCBrowser", "Internet Explorer", "Android browser"},
		build:   lowerSet(func(v *Visit) string { return v.UA.Browser })},
	{Type: "user_agent", Label: "User-Agent", Group: "Device", Input: "lines", Help: "Substring per line, or /regex/",
		build: contains(func(v *Visit) string { return v.UA.Raw })},

	{Type: "bot", Label: "Bot", Group: "Traffic quality", Input: "none", Help: "Flagged by any anti-bot signal",
		build: flag(func(v *Visit) bool { return v.Verdict.Bot })},
	{Type: "datacenter", Label: "Datacenter / VPN / proxy", Group: "Traffic quality", Input: "none",
		build: flag(func(v *Visit) bool { return v.Verdict.Datacenter })},
	{Type: "unique", Label: "Unique visitor", Group: "Traffic quality", Input: "none", Help: "First visit to this campaign within its uniqueness window",
		build: flag(func(v *Visit) bool { return v.Unique })},
	{Type: "empty_referer", Label: "Empty referrer", Group: "Traffic quality", Input: "none",
		build: flag(func(v *Visit) bool { return v.Referer == "" })},
	{Type: "ipv6", Label: "IPv6", Group: "Network", Input: "none",
		build: flag(func(v *Visit) bool { return v.IP.Is6() && !v.IP.Is4In6() })},

	{Type: "ip", Label: "IP / CIDR", Group: "Network", Input: "lines", Help: "One address or CIDR per line",
		build: func(values []string) (func(*Visit) bool, error) {
			var prefixes []netip.Prefix
			for _, val := range values {
				p := antibot.ParsePrefixes([]byte(val))
				if len(p) == 0 && strings.TrimSpace(val) != "" {
					return nil, fmt.Errorf("bad IP or CIDR %q", val)
				}
				prefixes = append(prefixes, p...)
			}
			set := antibot.NewSet(prefixes)
			return func(v *Visit) bool { return set.Contains(v.IP) }, nil
		}},
	{Type: "asn", Label: "ASN", Group: "Network", Input: "tags", Help: "Numbers, e.g. 15169",
		build: func(values []string) (func(*Visit) bool, error) {
			set := map[uint32]bool{}
			for _, val := range values {
				n, err := strconv.ParseUint(strings.TrimPrefix(strings.ToUpper(strings.TrimSpace(val)), "AS"), 10, 32)
				if err != nil {
					return nil, fmt.Errorf("bad ASN %q", val)
				}
				set[uint32(n)] = true
			}
			return func(v *Visit) bool { return set[v.Geo.ASN] }, nil
		}},
	{Type: "isp", Label: "ISP / organisation", Group: "Network", Input: "lines", Help: "Substring per line, or /regex/",
		build: contains(func(v *Visit) string { return v.Geo.ISP })},

	{Type: "referer", Label: "Referrer", Group: "Request", Input: "lines", Help: "Substring per line, or /regex/",
		build: contains(func(v *Visit) string { return v.Referer })},
	{Type: "domain", Label: "Domain", Group: "Request", Input: "tags",
		build: lowerSet(func(v *Visit) string { return v.Domain })},
	{Type: "param", Label: "URL parameter", Group: "Request", Input: "lines", Help: "name=value, or just name to require its presence",
		build: func(values []string) (func(*Visit) bool, error) {
			type kv struct {
				k, v string
				any  bool
			}
			var conds []kv
			for _, val := range values {
				if val = strings.TrimSpace(val); val == "" {
					continue
				}
				k, want, has := strings.Cut(val, "=")
				conds = append(conds, kv{k, want, !has})
			}
			return func(v *Visit) bool {
				for _, c := range conds {
					got, ok := v.Query[c.k]
					if !ok {
						continue
					}
					if c.any {
						return true
					}
					for _, g := range got {
						if g == c.v {
							return true
						}
					}
				}
				return false
			}, nil
		}},
}

var filterIndex = func() map[string]*FilterDef {
	m := map[string]*FilterDef{}
	for i := range filterDefs {
		m[filterDefs[i].Type] = &filterDefs[i]
	}
	return m
}()

// FilterDefs lists the available stream filters.
func FilterDefs() []FilterDef { return filterDefs }

type compiledFilter struct {
	typ   string
	neg   bool
	match func(*Visit) bool
}

func compileFilters(fs []model.Filter) ([]compiledFilter, error) {
	out := make([]compiledFilter, 0, len(fs))
	for _, f := range fs {
		def := filterIndex[f.Type]
		if def == nil {
			return nil, fmt.Errorf("unknown filter %q", f.Type)
		}
		if def.Input != "none" && len(f.Values) == 0 {
			return nil, fmt.Errorf("filter %q has no values", def.Label)
		}
		m, err := def.build(f.Values)
		if err != nil {
			return nil, fmt.Errorf("filter %q: %w", def.Label, err)
		}
		out = append(out, compiledFilter{typ: f.Type, neg: f.Mode == "is_not", match: m})
	}
	return out, nil
}

// ValidateFilters checks a stream's filters without keeping the result.
func ValidateFilters(fs []model.Filter) error {
	_, err := compileFilters(fs)
	return err
}
