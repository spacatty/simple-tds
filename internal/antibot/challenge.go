package antibot

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func parseFloat(s string) (float64, error) { return strconv.ParseFloat(s, 64) }

// Cookie and query names used by the JS check.
const (
	CookieChallenge = "_tc" // set by the challenge script: token + collected signals
	CookiePass      = "_tv" // set by the server once a browser has passed
	ParamNoJS       = "_nc" // visitor could not run the script or keep a cookie
)

// Signer issues and verifies the short-lived tokens of the JS check.
type Signer struct{ secret []byte }

func NewSigner(secret []byte) *Signer { return &Signer{secret: secret} }

func (s *Signer) mac(parts ...string) string {
	m := hmac.New(sha256.New, s.secret)
	for _, p := range parts {
		m.Write([]byte(p))
		m.Write([]byte{0})
	}
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil)[:15])
}

// Token binds a challenge to the visitor's IP for two minutes.
func (s *Signer) Token(ip string, now time.Time) string {
	exp := strconv.FormatInt(now.Add(2*time.Minute).Unix(), 36)
	return exp + "." + s.mac("tc", exp, ip)
}

func (s *Signer) fresh(exp, mac string, now time.Time, parts ...string) bool {
	t, err := strconv.ParseInt(exp, 36, 64)
	if err != nil || now.Unix() > t {
		return false
	}
	return hmac.Equal([]byte(mac), []byte(s.mac(parts...)))
}

// Pass is the cookie value proving this browser passed the check.
func (s *Signer) Pass(ua string, ttl time.Duration, now time.Time) string {
	exp := strconv.FormatInt(now.Add(ttl).Unix(), 36)
	return exp + "." + s.mac("tv", exp, ua)
}

func (s *Signer) ValidPass(v, ua string, now time.Time) bool {
	exp, mac, ok := strings.Cut(v, ".")
	return ok && s.fresh(exp, mac, now, "tv", exp, ua)
}

// Signals is what the challenge script reports about the browser.
type Signals struct {
	WebDriver  bool     `json:"wd"`
	UA         string   `json:"ua"`
	Platform   string   `json:"pf"`
	Languages  int      `json:"lg"`
	Plugins    int      `json:"pl"`
	Chrome     bool     `json:"ch"`
	OuterW     int      `json:"ow"`
	OuterH     int      `json:"oh"`
	ScreenW    int      `json:"sw"`
	ScreenH    int      `json:"sh"`
	Cores      int      `json:"hc"`
	Touch      int      `json:"tp"`
	Automation []string `json:"au"`
	GL         string   `json:"gl"`
	Referrer   string   `json:"r"`
	Error      int      `json:"er"`
}

// ReadChallenge verifies the challenge cookie and decodes its signals.
func (s *Signer) ReadChallenge(cookie, ip string, now time.Time) (*Signals, bool) {
	parts := strings.SplitN(cookie, ".", 3)
	if len(parts) != 3 || !s.fresh(parts[0], parts[1], now, "tc", parts[0], ip) {
		return nil, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, false
	}
	var sig Signals
	if json.Unmarshal(raw, &sig) != nil {
		return nil, false
	}
	return &sig, true
}

var reSoftGL = regexp.MustCompile(`(?i)swiftshader|llvmpipe|softpipe|software rasterizer|virtualbox|vmware|mesa offscreen`)

// Evaluate scores the reported signals against what the browser claims to be.
func (sig *Signals) Evaluate(ua *UA) (score int, reasons []string) {
	add := func(n int, r string) { score += n; reasons = append(reasons, "js:"+r) }
	desktop := ua.DeviceType == "desktop"
	mobile := ua.DeviceType == "mobile" || ua.DeviceType == "tablet"
	if sig.WebDriver {
		add(hard, "webdriver")
	}
	if len(sig.Automation) > 0 {
		add(hard, "automation")
	}
	if strings.Contains(sig.UA, "Headless") {
		add(hard, "headless")
	}
	if sig.Error != 0 {
		add(60, "script_error")
	}
	if sig.UA != "" && sig.UA != ua.Raw {
		add(70, "ua_mismatch")
	}
	if sig.Languages == 0 {
		add(60, "no_languages")
	}
	if sig.ScreenW == 0 || sig.ScreenH == 0 {
		add(60, "no_screen")
	}
	if desktop && (sig.OuterW == 0 || sig.OuterH == 0) {
		add(50, "no_window")
	}
	if desktop && ua.Chromium && !sig.Chrome {
		add(50, "no_window_chrome")
	}
	if desktop && ua.Chromium && sig.Plugins == 0 {
		add(30, "no_plugins")
	}
	if mobile && sig.Touch == 0 {
		add(50, "no_touch")
	}
	if reSoftGL.MatchString(sig.GL) {
		add(50, "software_gl")
	}
	pf, os := strings.ToLower(sig.Platform), strings.ToLower(ua.OS)
	switch {
	case strings.Contains(os, "windows") && !strings.HasPrefix(pf, "win"),
		strings.Contains(os, "mac") && !strings.HasPrefix(pf, "mac"),
		strings.Contains(os, "android") && (strings.HasPrefix(pf, "win") || strings.HasPrefix(pf, "mac")),
		os == "ios" && (strings.HasPrefix(pf, "win") || strings.HasPrefix(pf, "linux")):
		add(60, "platform_mismatch")
	}
	return
}

const challengeTmpl = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title></title><noscript><meta http-equiv="refresh" content="0;url=%[2]s"></noscript></head><body><script>(function(){var n=navigator,w=window,d=document,s={};try{s.wd=!!n.webdriver;s.ua=n.userAgent;s.pf=n.platform||"";s.lg=(n.languages||[]).length;s.pl=(n.plugins||[]).length;s.ch=!!w.chrome;s.ow=w.outerWidth|0;s.oh=w.outerHeight|0;s.sw=screen.width|0;s.sh=screen.height|0;s.hc=n.hardwareConcurrency|0;s.tp=n.maxTouchPoints|0;var a=["callPhantom","_phantom","phantom","__nightmare","domAutomation","domAutomationController","_selenium","__webdriver_evaluate","__selenium_evaluate","__driver_evaluate","__webdriver_script_fn","__selenium_unwrapped","__fxdriver_unwrapped","_Selenium_IDE_Recorder","awesomium","__playwright","__pw_manual","__puppeteer_evaluation_script__"];s.au=[];for(var i=0;i<a.length;i++)if(a[i] in w||a[i] in d)s.au.push(a[i]);for(var k in d)if(/^\$?cdc_|^\$chrome_asyncScriptInfo/.test(k))s.au.push("cdc");var e=d.documentElement;if(e.getAttribute("webdriver")||e.getAttribute("selenium")||e.getAttribute("driver"))s.au.push("attr");try{var c=d.createElement("canvas"),g=c.getContext("webgl")||c.getContext("experimental-webgl");if(g){var x=g.getExtension("WEBGL_debug_renderer_info");s.gl=x?String(g.getParameter(x.UNMASKED_RENDERER_WEBGL)).slice(0,120):""}else s.gl="none"}catch(_){s.gl="err"}s.r=(d.referrer||"").slice(0,300)}catch(_){s.er=1}var v="%[1]s."+btoa(unescape(encodeURIComponent(JSON.stringify(s)))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");d.cookie="%[3]s="+v+";path=/;max-age=120;SameSite=Lax";if(d.cookie.indexOf("%[3]s=")<0)location.replace("%[2]s");else location.reload()})();</script></body></html>`

// ChallengePage renders the interstitial. fallbackURL is where a visitor
// without JS or cookies is sent; it must already be safe to embed.
func ChallengePage(token, fallbackURL string) []byte {
	return []byte(fmt.Sprintf(challengeTmpl, token, fallbackURL, CookieChallenge))
}
