package antibot

import (
	"regexp"
	"strings"

	lru "github.com/hashicorp/golang-lru/v2"
	"github.com/mileusna/useragent"
)

// UA is a parsed User-Agent.
type UA struct {
	Raw            string
	Browser        string
	BrowserVersion string
	Major          int
	OS             string
	OSVersion      string
	DeviceType     string // desktop | mobile | tablet | tv | bot | unknown
	Bot            bool   // matched a crawler / tool signature
	BotSig         string
	Chromium       bool // Chrome-family engine (sends client hints)
	GreaseTLS      bool // engine known to send TLS GREASE
}

// Signatures of crawlers, link previewers, HTTP libraries, automation and scanners.
const builtinBotUA = `bot\b|bot/|crawl|spider|slurp|facebookexternalhit|facebookcatalog|meta-external|adsbot|mediapartners|google-|googleother|` +
	`lighthouse|pagespeed|headless|phantomjs|selenium|puppeteer|playwright|electron|python|curl/|wget|httpclient|okhttp|go-http|java/|libwww|` +
	`scrapy|axios|node-fetch|undici|guzzle|postman|insomnia|restsharp|aiohttp|httpx|winhttp|bingpreview|whatsapp/|skypeuripreview|vkshare|` +
	`yandex|ahrefs|semrush|mj12|dotbot|petal|bytespider|gptbot|claude-|ccbot|chatgpt|perplexity|duckduck|baidu|sogou|exabot|ia_archiver|` +
	`archive\.org|uptime|pingdom|statuscake|datadog|newrelic|zabbix|nagios|site24x7|nmap|masscan|zgrab|censys|shodan|nikto|sqlmap|wpscan|` +
	`nuclei|httprobe|dataprovider|qwant|seznam|mail\.ru_bot|snapchat ads|tiktokspider|adscanner|adbeat|moatbot|proximic|grapeshot|` +
	`integral ad|doubleverify|comscore|virustotal|urlscan|netcraft|phish|safebrowsing|wappalyzer|builtwith`

// Cubot is a phone brand whose model names would trip the "bot" signature.
var reCubot = regexp.MustCompile(`(?i)cubot`)

var reTV = regexp.MustCompile(`(?i)smart-?tv|appletv|googletv|hbbtv|tizen|web0s|webos|roku|crkey|bravia|netcast|viera`)

type uaParser struct {
	cache *lru.Cache[string, *UA]
	re    *regexp.Regexp
}

func newUAParser(extra []string) *uaParser {
	pat := builtinBotUA
	for _, p := range extra {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		// User patterns are plain substrings unless they compile on their own.
		if _, err := regexp.Compile(p); err != nil {
			p = regexp.QuoteMeta(p)
		}
		pat += "|" + p
	}
	re, err := regexp.Compile("(?i)" + pat)
	if err != nil {
		re = regexp.MustCompile("(?i)" + builtinBotUA)
	}
	c, _ := lru.New[string, *UA](50_000)
	return &uaParser{cache: c, re: re}
}

func (p *uaParser) parse(raw string) *UA {
	if len(raw) > 1024 {
		raw = raw[:1024]
	}
	if u, ok := p.cache.Get(raw); ok {
		return u
	}
	pu := useragent.Parse(raw)
	u := &UA{Raw: raw, Browser: pu.Name, BrowserVersion: pu.Version, Major: pu.VersionNo.Major, OS: pu.OS, OSVersion: pu.OSVersion}
	switch {
	case raw == "":
		u.Bot, u.BotSig, u.DeviceType = true, "empty", "bot"
	case p.re.MatchString(reCubot.ReplaceAllString(raw, "")):
		u.Bot, u.BotSig, u.DeviceType = true, strings.ToLower(p.re.FindString(reCubot.ReplaceAllString(raw, ""))), "bot"
	case pu.Bot:
		u.Bot, u.BotSig, u.DeviceType = true, "crawler", "bot"
	case reTV.MatchString(raw):
		u.DeviceType = "tv"
	case pu.Tablet:
		u.DeviceType = "tablet"
	case pu.Mobile:
		u.DeviceType = "mobile"
	case pu.Desktop:
		u.DeviceType = "desktop"
	default:
		u.DeviceType = "unknown"
	}
	// Chrome on iOS is WebKit and sends no client hints.
	ios := pu.OS == "iOS"
	u.Chromium = !ios && strings.Contains(raw, "Chrome/") && !strings.Contains(raw, "Edge/")
	u.GreaseTLS = u.Chromium || ios || (pu.Name == "Safari" && pu.VersionNo.Major >= 14)
	p.cache.Add(raw, u)
	return u
}
