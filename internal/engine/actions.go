package engine

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Handler executes a stream action for one visit.
type Handler func(v *Visit) (*Result, error)

// Field describes one action setting so the panel can render its form.
type Field struct {
	Name     string   `json:"name"`
	Label    string   `json:"label"`
	Type     string   `json:"type"` // text | textarea | code | number | select | bool | whitepage | campaign
	Options  []string `json:"options,omitempty"`
	Default  any      `json:"default,omitempty"`
	Help     string   `json:"help,omitempty"`
	Required bool     `json:"required,omitempty"`
}

// ActionDef is a stream action type. To add one, write a Build function that
// turns the stored JSON config into a Handler and call RegisterAction from an
// init(); the panel picks the new type and its form up automatically.
type ActionDef struct {
	Type        string                                                `json:"type"`
	Label       string                                                `json:"label"`
	Description string                                                `json:"description"`
	Fields      []Field                                               `json:"fields"`
	Build       func(cfg json.RawMessage, e *Engine) (Handler, error) `json:"-"`
}

var actionDefs []ActionDef

func RegisterAction(d ActionDef) { actionDefs = append(actionDefs, d) }

// ActionDefs lists the registered actions in registration order.
func ActionDefs() []ActionDef { return actionDefs }

func buildAction(typ string, cfg json.RawMessage, e *Engine) (Handler, error) {
	var def *ActionDef
	for i := range actionDefs {
		if actionDefs[i].Type == typ {
			def = &actionDefs[i]
		}
	}
	if def == nil {
		return nil, fmt.Errorf("unknown action %q", typ)
	}
	if len(cfg) == 0 {
		cfg = json.RawMessage("{}")
	}
	return def.Build(cfg, e)
}

// decode parses an action config. Numbers may arrive as strings from forms.
func decode(cfg json.RawMessage, into any) error {
	if err := json.Unmarshal(cfg, into); err != nil {
		return fmt.Errorf("bad config: %w", err)
	}
	return nil
}

// expand substitutes {macros} in s. With esc set, values are query-escaped.
func (v *Visit) expand(s string, esc bool) string {
	if !strings.Contains(s, "{") {
		return s
	}
	var b strings.Builder
	for {
		i := strings.IndexByte(s, '{')
		if i < 0 {
			break
		}
		j := strings.IndexByte(s[i:], '}')
		if j < 0 {
			break
		}
		name := s[i+1 : i+j]
		val, ok := v.macro(name)
		b.WriteString(s[:i])
		switch {
		case !ok:
			b.WriteString(s[i : i+j+1]) // not ours: leave untouched
		case esc:
			b.WriteString(url.QueryEscape(val))
		default:
			b.WriteString(val)
		}
		s = s[i+j+1:]
	}
	b.WriteString(s)
	return b.String()
}

// Macros lists the placeholders available in action URLs and content.
var Macros = []string{"click_id", "campaign_id", "campaign", "stream_id", "domain", "ip", "country", "region", "city", "isp", "asn",
	"device_type", "os", "browser", "language", "user_agent", "referer", "keyword", "sub1", "sub2", "sub3", "sub4", "sub5", "param:NAME", "query"}

func (v *Visit) macro(name string) (string, bool) {
	switch name {
	case "click_id", "clickid", "subid":
		return v.ClickID, true
	case "campaign_id":
		return strconv.FormatInt(v.Campaign.ID, 10), true
	case "campaign":
		return v.Campaign.Alias, true
	case "stream_id":
		if v.Stream == nil {
			return "", true
		}
		return strconv.FormatInt(v.Stream.ID, 10), true
	case "domain":
		return v.Domain, true
	case "ip":
		return v.IP.String(), true
	case "country":
		return v.Geo.Country, true
	case "region":
		return v.Geo.Region, true
	case "city":
		return v.Geo.City, true
	case "isp":
		return v.Geo.ISP, true
	case "asn":
		return strconv.FormatUint(uint64(v.Geo.ASN), 10), true
	case "device_type":
		return v.UA.DeviceType, true
	case "os":
		return v.UA.OS, true
	case "browser":
		return v.UA.Browser, true
	case "language":
		return v.Lang, true
	case "user_agent":
		return v.UA.Raw, true
	case "referer":
		return v.Referer, true
	case "keyword":
		return v.Query.Get("keyword"), true
	case "sub1", "sub2", "sub3", "sub4", "sub5":
		return subParam(v.Query, int(name[3]-'0')), true
	case "query":
		return v.Query.Encode(), true
	}
	if p, ok := strings.CutPrefix(name, "param:"); ok {
		return v.Query.Get(p), true
	}
	return "", false
}

// subParam reads sub-id N, accepting the common spellings.
func subParam(q url.Values, n int) string {
	s := strconv.Itoa(n)
	for _, k := range []string{"sub" + s, "sub_id_" + s, "subid" + s, "sub_id" + s} {
		if v := q.Get(k); v != "" {
			return v
		}
	}
	return ""
}

func htmlResult(body string) *Result {
	return &Result{Status: http.StatusOK, ContentType: "text/html; charset=utf-8", Body: []byte(body)}
}

func validURL(s string) error {
	if s == "" {
		return errors.New("URL is required")
	}
	// Macros may stand in for parts of the URL, so only check the scheme.
	if !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") && !strings.HasPrefix(s, "{") && !strings.HasPrefix(s, "/") {
		return errors.New("URL must start with http://, https:// or /")
	}
	return nil
}

func init() {
	RegisterAction(ActionDef{
		Type: "status", Label: "HTTP status (404)", Description: "Answer with an HTTP error, by default a plain 404 page.",
		Fields: []Field{
			{Name: "code", Label: "Status code", Type: "number", Default: 404},
			{Name: "body", Label: "Body (optional)", Type: "code", Help: "Leave empty for a standard server error page."},
		},
		Build: func(cfg json.RawMessage, _ *Engine) (Handler, error) {
			c := struct {
				Code int    `json:"code"`
				Body string `json:"body"`
			}{Code: 404}
			if err := decode(cfg, &c); err != nil {
				return nil, err
			}
			if c.Code < 200 || c.Code > 599 {
				return nil, errors.New("status code must be 200-599")
			}
			body := []byte(c.Body)
			if c.Body == "" {
				text := http.StatusText(c.Code)
				body = []byte(strings.NewReplacer("404 Not Found", strconv.Itoa(c.Code)+" "+text).Replace(notFoundBody))
			}
			return func(*Visit) (*Result, error) {
				return &Result{Status: c.Code, ContentType: "text/html; charset=utf-8", Body: body}, nil
			}, nil
		},
	})

	RegisterAction(ActionDef{
		Type: "text", Label: "Show text / HTML", Description: "Return the given content. Macros like {country} are substituted.",
		Fields: []Field{
			{Name: "content", Label: "Content", Type: "code", Required: true},
			{Name: "content_type", Label: "Content type", Type: "select", Default: "text/html",
				Options: []string{"text/html", "text/plain", "application/javascript", "application/json"}},
		},
		Build: func(cfg json.RawMessage, _ *Engine) (Handler, error) {
			c := struct {
				Content     string `json:"content"`
				ContentType string `json:"content_type"`
			}{ContentType: "text/html"}
			if err := decode(cfg, &c); err != nil {
				return nil, err
			}
			ct := c.ContentType + "; charset=utf-8"
			return func(v *Visit) (*Result, error) {
				r := &Result{Status: http.StatusOK, ContentType: ct, Body: []byte(v.expand(c.Content, false))}
				if c.ContentType == "application/javascript" {
					r.Script = r.Body
				}
				return r, nil
			}, nil
		},
	})

	RegisterAction(ActionDef{
		Type: "redirect", Label: "Redirect", Description: "Send the visitor to a URL. Macros like {click_id} are URL-encoded and substituted.",
		Fields: []Field{
			{Name: "url", Label: "URL", Type: "text", Required: true, Help: "https://offer.example/?clickid={click_id}&geo={country}"},
			{Name: "method", Label: "Method", Type: "select", Default: "302",
				Options: []string{"302", "301", "303", "307", "meta", "js"},
				Help:    "meta and js redirects hide nothing but work where HTTP redirects are not followed."},
			{Name: "pass_query", Label: "Append the incoming query string", Type: "bool", Default: false},
		},
		Build: func(cfg json.RawMessage, _ *Engine) (Handler, error) {
			c := struct {
				URL       string `json:"url"`
				Method    string `json:"method"`
				PassQuery bool   `json:"pass_query"`
			}{Method: "302"}
			if err := decode(cfg, &c); err != nil {
				return nil, err
			}
			if err := validURL(c.URL); err != nil {
				return nil, err
			}
			return func(v *Visit) (*Result, error) {
				target := v.expand(c.URL, true)
				if c.PassQuery && len(v.Query) > 0 {
					sep := "?"
					if strings.Contains(target, "?") {
						sep = "&"
					}
					target += sep + v.Query.Encode()
				}
				switch c.Method {
				case "meta":
					r := htmlResult(`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=` + html.EscapeString(target) + `"></head><body></body></html>`)
					r.Location = target
					r.Status = 0 // rendered as content on direct hits, as a redirect elsewhere
					return r, nil
				case "js":
					r := htmlResult(`<!doctype html><html><head><meta charset="utf-8"></head><body><script>location.replace(` + jsString(target) + `)</script></body></html>`)
					r.Location = target
					r.Status = 0
					return r, nil
				}
				code, _ := strconv.Atoi(c.Method)
				if code < 300 || code > 308 {
					code = http.StatusFound
				}
				return &Result{Status: code, Location: target}, nil
			}, nil
		},
	})

	RegisterAction(ActionDef{
		Type: "whitepage", Label: "Whitepage", Description: "Serve an uploaded whitepage (HTML or PHP) on the campaign URL.",
		Fields: []Field{{Name: "whitepage_id", Label: "Whitepage", Type: "whitepage", Required: true}},
		Build: func(cfg json.RawMessage, e *Engine) (Handler, error) {
			var c struct {
				ID int64 `json:"whitepage_id"`
			}
			if err := decode(cfg, &c); err != nil {
				return nil, err
			}
			if c.ID == 0 {
				return nil, errors.New("choose a whitepage")
			}
			return func(v *Visit) (*Result, error) {
				// Resolved per click so replacing a whitepage needs no stream edit.
				wp := e.Snap().Whitepages[c.ID]
				if wp == nil {
					return nil, fmt.Errorf("whitepage %d no longer exists", c.ID)
				}
				return e.Pages.Render(v.Ctx, wp, v)
			}, nil
		},
	})

	RegisterAction(ActionDef{
		Type: "remote_js", Label: "JavaScript from URL",
		Description: "Fetch JavaScript from a partner endpoint and ship it to the visitor, optionally caching it.",
		Fields: []Field{
			{Name: "url", Label: "Source URL", Type: "text", Required: true, Help: "Macros are allowed; each distinct URL is cached separately."},
			{Name: "cache_minutes", Label: "Cache, minutes", Type: "number", Default: 5,
				Help: "0 fetches on every click. Otherwise the code is served from cache and refreshed in the background once it is older than this."},
			{Name: "mode", Label: "Deliver as", Type: "select", Default: "html", Options: []string{"html", "script"},
				Help: "html wraps the code in a page; script returns raw JavaScript for use in a <script src>."},
			{Name: "timeout_ms", Label: "Fetch timeout, ms", Type: "number", Default: 3000},
			{Name: "headers", Label: "Request headers", Type: "textarea", Help: "One \"Name: value\" per line. Macros are allowed."},
			{Name: "forward_visitor", Label: "Forward visitor IP and User-Agent to the source", Type: "bool", Default: false,
				Help: "Sends X-Forwarded-For and the visitor's User-Agent. Use with cache 0 if the partner personalises the code."},
			{Name: "on_error", Label: "If the source fails", Type: "select", Default: "stale", Options: []string{"stale", "404"},
				Help: "stale serves the last good copy, or an empty response if there is none."},
		},
		Build: buildRemoteJS,
	})

	RegisterAction(ActionDef{
		Type: "campaign", Label: "Send to campaign", Description: "Hand the visit over to another campaign's streams.",
		Fields: []Field{{Name: "campaign_id", Label: "Campaign", Type: "campaign", Required: true}},
		Build: func(cfg json.RawMessage, e *Engine) (Handler, error) {
			var c struct {
				ID int64 `json:"campaign_id"`
			}
			if err := decode(cfg, &c); err != nil {
				return nil, err
			}
			if c.ID == 0 {
				return nil, errors.New("choose a campaign")
			}
			return func(v *Visit) (*Result, error) {
				target := e.Snap().ByID[c.ID]
				if target == nil || !target.Enabled {
					return nil, fmt.Errorf("campaign %d is not available", c.ID)
				}
				if v.depth >= 3 {
					return nil, errors.New("campaign redirect loop")
				}
				v.depth++
				stream := target.pick(v, nil)
				if stream == nil {
					return notFound(), nil
				}
				return stream.action(v)
			}, nil
		},
	})

	RegisterAction(ActionDef{
		Type: "nothing", Label: "Do nothing", Description: "Empty 200 response.",
		Build: func(json.RawMessage, *Engine) (Handler, error) {
			return func(*Visit) (*Result, error) {
				return &Result{Status: http.StatusOK, ContentType: "text/html; charset=utf-8", Script: []byte{}}, nil
			}, nil
		},
	})
}

// jsString encodes s as a JavaScript string literal safe inside <script>.
func jsString(s string) string {
	b, _ := json.Marshal(s) // escapes <, > and & as \u00XX
	return string(b)
}

// AsScript converts a result into JavaScript for the JS integration.
func (r *Result) AsScript() []byte {
	switch {
	case r.Script != nil:
		return r.Script
	case r.Location != "":
		return []byte("window.location.replace(" + jsString(r.Location) + ");")
	case r.Status >= 400 || len(r.Body) == 0:
		return []byte{}
	}
	var b bytes.Buffer
	b.WriteString("document.open();document.write(")
	b.WriteString(jsString(string(r.Body)))
	b.WriteString(");document.close();")
	return b.Bytes()
}
