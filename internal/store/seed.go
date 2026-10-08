package store

import (
	"context"

	"simpletds/internal/model"
)

var defaultPresets = []model.GeoPreset{
	{Name: "CIS", Countries: []string{"RU", "BY", "KZ", "KG", "TJ", "UZ", "AM", "AZ", "MD", "TM"}},
	{Name: "CIS + UA, GE", Countries: []string{"RU", "BY", "KZ", "KG", "TJ", "UZ", "AM", "AZ", "MD", "TM", "UA", "GE"}},
	{Name: "Baltics", Countries: []string{"EE", "LV", "LT"}},
	{Name: "Tier 1", Countries: []string{"US", "CA", "GB", "AU", "NZ", "DE", "FR", "NL", "CH", "AT", "SE", "NO", "DK", "FI", "IE", "BE", "LU", "SG"}},
	{Name: "English speaking", Countries: []string{"US", "CA", "GB", "AU", "NZ", "IE"}},
	{Name: "European Union", Countries: []string{"AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"}},
	{Name: "DACH", Countries: []string{"DE", "AT", "CH"}},
	{Name: "Nordics", Countries: []string{"SE", "NO", "DK", "FI", "IS"}},
	{Name: "Eastern Europe", Countries: []string{"PL", "CZ", "SK", "HU", "RO", "BG", "RS", "HR", "SI", "BA", "MK", "AL", "ME", "MD", "UA", "BY"}},
	{Name: "LATAM", Countries: []string{"BR", "MX", "AR", "CO", "CL", "PE", "EC", "VE", "UY", "PY", "BO", "CR", "PA", "DO", "GT", "HN", "SV", "NI"}},
	{Name: "MENA", Countries: []string{"AE", "SA", "QA", "KW", "BH", "OM", "EG", "MA", "DZ", "TN", "JO", "LB", "IQ", "IL", "TR"}},
	{Name: "South-East Asia", Countries: []string{"TH", "VN", "ID", "MY", "PH", "SG", "KH", "LA", "MM"}},
	{Name: "South Asia", Countries: []string{"IN", "PK", "BD", "LK", "NP"}},
	{Name: "East Asia", Countries: []string{"JP", "KR", "TW", "HK", "CN", "MO"}},
	{Name: "Africa (top)", Countries: []string{"NG", "ZA", "KE", "GH", "EG", "TZ", "UG", "CI", "SN", "CM", "ET"}},
}

// Open, key-less sources. Anything that looks like a CIDR or IP is extracted,
// so plain text and JSON feeds both work.
var defaultLists = []model.IPList{
	{Name: "Googlebot", Kind: model.ListBot, URL: "https://developers.google.com/static/search/apis/ipranges/googlebot.json"},
	{Name: "Google special crawlers (AdsBot)", Kind: model.ListBot, URL: "https://developers.google.com/static/search/apis/ipranges/special-crawlers.json"},
	{Name: "Google user-triggered fetchers", Kind: model.ListBot, URL: "https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers.json"},
	{Name: "Bingbot", Kind: model.ListBot, URL: "https://www.bing.com/toolbox/bingbot.json"},
	{Name: "Datacenters (X4BNet)", Kind: model.ListDatacenter, URL: "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt"},
	{Name: "VPN providers (X4BNet)", Kind: model.ListDatacenter, URL: "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt"},
	{Name: "AWS", Kind: model.ListDatacenter, URL: "https://ip-ranges.amazonaws.com/ip-ranges.json"},
	{Name: "Google Cloud", Kind: model.ListDatacenter, URL: "https://www.gstatic.com/ipranges/cloud.json"},
	{Name: "Oracle Cloud", Kind: model.ListDatacenter, URL: "https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json"},
	{Name: "Tor exit nodes", Kind: model.ListDatacenter, URL: "https://check.torproject.org/torbulkexitlist"},
	{Name: "My blocklist", Kind: model.ListBlock},
	{Name: "My allowlist", Kind: model.ListAllow},
}

func (s *Store) seed(ctx context.Context) error {
	var n int
	if err := s.Pool.QueryRow(ctx, "SELECT count(*) FROM geo_presets").Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		for _, p := range defaultPresets {
			p.Builtin = true
			if err := Insert(ctx, s, "geo_presets", &p); err != nil {
				return err
			}
		}
	}
	if err := s.Pool.QueryRow(ctx, "SELECT count(*) FROM ip_lists").Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		for _, l := range defaultLists {
			l.Builtin, l.Enabled, l.RefreshHours = true, true, 24
			if err := Insert(ctx, s, "ip_lists", &l); err != nil {
				return err
			}
		}
	}
	return nil
}
