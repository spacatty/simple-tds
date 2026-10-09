// Package engine is the click path: it holds an immutable in-memory snapshot
// of the configuration and turns a visit into a stream action without
// touching the database.
package engine

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	lru "github.com/hashicorp/golang-lru/v2"

	"simpletds/internal/antibot"
	"simpletds/internal/events"
	"simpletds/internal/extapi"
	"simpletds/internal/geo"
	"simpletds/internal/model"
	"simpletds/internal/store"
)

type StreamRT struct {
	model.Stream
	filters []compiledFilter
	action  Handler
	Err     string // why the stream is unusable, if it is
}

type CampaignRT struct {
	model.Campaign
	Forced, Regular, Default []*StreamRT
	// users are the owner and everyone holding an edit share: the people
	// allowed to run this campaign on their domains and postback keys.
	users map[int64]bool
	// suppress are the lists of sources this campaign refuses: one per user
	// with rules for all of their campaigns, one for the rules naming it.
	suppress []*suppressList
}

// UsableBy reports whether a user may attach the campaign to their own
// domains and conversion keys.
func (c *CampaignRT) UsableBy(userID int64) bool { return c.users[userID] }

type DomainRT struct {
	model.Domain
	Campaign *CampaignRT
}

type KeyRT struct {
	model.ConvKey
	allow *antibot.Set
}

// Snapshot is the whole runtime configuration. It is replaced atomically.
type Snapshot struct {
	Settings      model.Settings
	Domains       map[string]*DomainRT
	ByAlias       map[string]*CampaignRT
	ByID          map[int64]*CampaignRT
	Whitepages    map[int64]*model.Whitepage
	WhitepageKeys map[string]*model.Whitepage
	Keys          map[string]*KeyRT
	KeyNames      map[uint32]string
	Trusted       *antibot.Set
	// Params knows every name the system request parameters go by.
	Params       *ParamNames
	geoProviders []*extapi.Provider
	// AdminDomainOK: at least one verified domain serves the panel.
	AdminDomainOK bool
}

// WhitepageRenderer serves an uploaded whitepage (static or PHP).
type WhitepageRenderer interface {
	Render(ctx context.Context, wp *model.Whitepage, v *Visit) (*Result, error)
}

type Engine struct {
	Store    *store.Store
	Events   *events.DB
	Geo      *geo.DB
	Detector *antibot.Detector
	Signer   *antibot.Signer
	Pages    WhitepageRenderer

	secret []byte
	snap   atomic.Pointer[Snapshot]
	// reloadMu keeps concurrent reloads from publishing an older read of the
	// database over a newer one.
	reloadMu sync.Mutex

	uniq   *uniqStore
	recent *lru.Cache[string, *events.Click]
	convs  *lru.Cache[string, struct{}]
	remote *remoteCache
	limits *rateLimiter
}

func New(st *store.Store, ev *events.DB, g *geo.DB, det *antibot.Detector, secret []byte) *Engine {
	recent, _ := lru.New[string, *events.Click](200_000)
	convs, _ := lru.New[string, struct{}](200_000)
	e := &Engine{Store: st, Events: ev, Geo: g, Detector: det, Signer: antibot.NewSigner(secret),
		secret: secret, uniq: newUniqStore(), recent: recent, convs: convs,
		remote: newRemoteCache(), limits: newRateLimiter()}
	e.snap.Store(&Snapshot{Settings: model.DefaultSettings()})
	return e
}

func (e *Engine) Snap() *Snapshot { return e.snap.Load() }

// Reload rebuilds the snapshot from the database. Call it after any change.
func (e *Engine) Reload(ctx context.Context) error {
	e.reloadMu.Lock()
	defer e.reloadMu.Unlock()
	st, err := e.Store.Settings(ctx)
	if err != nil {
		return err
	}
	campaigns, err := store.List[model.Campaign](ctx, e.Store, "campaigns", "id")
	if err != nil {
		return err
	}
	streams, err := store.List[model.Stream](ctx, e.Store, "streams", "position, id")
	if err != nil {
		return err
	}
	domains, err := store.List[model.Domain](ctx, e.Store, "domains", "id")
	if err != nil {
		return err
	}
	pages, err := store.List[model.Whitepage](ctx, e.Store, "whitepages", "id")
	if err != nil {
		return err
	}
	keys, err := store.List[model.ConvKey](ctx, e.Store, "conv_keys", "id")
	if err != nil {
		return err
	}
	integrations, err := store.List[model.Integration](ctx, e.Store, "integrations", "id")
	if err != nil {
		return err
	}
	shares, err := e.Store.Shares(ctx)
	if err != nil {
		return err
	}
	rules, err := store.List[model.SuppressRule](ctx, e.Store, "suppress_rules", "id")
	if err != nil {
		return err
	}

	s := &Snapshot{Settings: st, Domains: map[string]*DomainRT{}, ByAlias: map[string]*CampaignRT{},
		ByID: map[int64]*CampaignRT{}, Whitepages: map[int64]*model.Whitepage{},
		WhitepageKeys: map[string]*model.Whitepage{}, Keys: map[string]*KeyRT{}, KeyNames: map[uint32]string{}}

	var trusted []netip.Prefix
	for _, t := range st.TrustedProxies {
		trusted = append(trusted, antibot.ParsePrefixes([]byte(t))...)
	}
	s.Trusted = antibot.NewSet(trusted)
	s.Params = NewParamNames(st.ParamAliases)

	for i := range pages {
		s.Whitepages[pages[i].ID] = &pages[i]
		s.WhitepageKeys[pages[i].Key] = &pages[i]
	}
	for i := range campaigns {
		c := &CampaignRT{Campaign: campaigns[i], users: map[int64]bool{campaigns[i].OwnerID: true}}
		s.ByID[c.ID] = c
		if c.Enabled {
			s.ByAlias[strings.ToLower(c.Alias)] = c
		}
	}
	for _, sh := range shares {
		if c := s.ByID[sh.CampaignID]; c != nil && sh.Access == "edit" {
			c.users[sh.UserID] = true
		}
	}
	attachSuppress(s.ByID, rules)
	for i := range streams {
		c := s.ByID[streams[i].CampaignID]
		if c == nil || !streams[i].Enabled {
			continue
		}
		rt := &StreamRT{Stream: streams[i]}
		if rt.filters, err = compileFilters(rt.Filters); err != nil {
			rt.Err = err.Error()
		} else if rt.action, err = buildAction(rt.ActionType, rt.ActionConfig, e); err != nil {
			rt.Err = err.Error()
		}
		if rt.Err != "" {
			// A broken stream must not swallow traffic: leave it out of rotation.
			slog.Warn("stream disabled", "campaign", c.Name, "stream", rt.Name, "err", rt.Err)
			continue
		}
		switch rt.Kind {
		case model.StreamForced:
			c.Forced = append(c.Forced, rt)
		case model.StreamDefault:
			c.Default = append(c.Default, rt)
		default:
			c.Regular = append(c.Regular, rt)
		}
	}
	for i := range domains {
		d := &DomainRT{Domain: domains[i]}
		if d.CampaignID != nil {
			if c := s.ByID[*d.CampaignID]; c != nil && c.Enabled && c.UsableBy(d.OwnerID) {
				d.Campaign = c
			}
		}
		if d.Enabled {
			s.Domains[strings.ToLower(d.Name)] = d
			if d.AdminEnabled && d.Status == "ok" {
				s.AdminDomainOK = true
			}
		}
	}
	for i := range keys {
		k := &KeyRT{ConvKey: keys[i]}
		var allow []netip.Prefix
		for _, a := range k.IPAllow {
			allow = append(allow, antibot.ParsePrefixes([]byte(a))...)
		}
		if len(allow) > 0 {
			k.allow = antibot.NewSet(allow)
		}
		s.KeyNames[uint32(k.ID)] = k.Name
		if k.Enabled {
			s.Keys[k.Key] = k
		}
	}
	for _, in := range integrations {
		if in.Enabled && in.Kind == "geo" {
			s.geoProviders = append(s.geoProviders, extapi.Shared(in))
		}
	}
	e.Detector.Configure(st, integrations)
	e.snap.Store(s)
	return nil
}

// Visit is one request as the engine sees it.
type Visit struct {
	Ctx         context.Context
	Now         time.Time
	Integration string // direct | js | php
	Domain      string
	Path        string
	Method      string
	IP          netip.Addr
	UA          *antibot.UA
	Header      http.Header
	Query       url.Values
	Referer     string
	RefDomain   string
	Lang        string
	Proto       string
	Secure      bool
	TLS         *antibot.TLSInfo
	Geo         geo.Info
	Verdict     antibot.Verdict
	Unique      bool
	ClickID     string
	Campaign    *CampaignRT
	Stream      *StreamRT
	// Cookie returns a request cookie value; nil for server-side integrations.
	Cookie func(name string) string
	// Body is the request body for whitepages that handle form posts.
	Body []byte

	params *ParamNames
	depth  int
}

// Result is an integration-neutral response.
type Result struct {
	Status      int
	Location    string // set for redirects
	ContentType string
	Body        []byte
	Script      []byte // JavaScript to run as-is when delivered through the JS integration
	Header      http.Header
	Cookies     []*http.Cookie
	// NoLog marks interstitials that are not clicks yet.
	NoLog bool
}

func notFound() *Result {
	return &Result{Status: http.StatusNotFound, ContentType: "text/html; charset=utf-8", Body: []byte(notFoundBody)}
}

// Deliberately indistinguishable from a stock web server page.
const notFoundBody = "<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n"

func (s *StreamRT) matches(v *Visit, trace *StreamTrace) bool {
	if s.JSCheck && v.Verdict.Bot {
		if trace != nil {
			trace.Note = "skipped: JS check stream never takes bots"
		}
		return false
	}
	if len(s.filters) == 0 {
		return true
	}
	or := s.FilterOp == "or"
	result := !or
	active := false
	for _, f := range s.filters {
		if f.bypass {
			if trace != nil {
				trace.Filters = append(trace.Filters, FilterTrace{Type: f.typ, Negated: f.neg, Bypassed: true})
			}
			continue
		}
		active = true
		ok := f.match(v) != f.neg
		if trace != nil {
			trace.Filters = append(trace.Filters, FilterTrace{Type: f.typ, Negated: f.neg, Passed: ok})
		} else if ok == or {
			return or // short-circuit: OR needs one pass, AND one failure
		}
		if or {
			result = result || ok
		} else {
			result = result && ok
		}
	}
	// With every filter bypassed the stream has none left, and takes everyone.
	return result || !active
}

type FilterTrace struct {
	Type     string `json:"type"`
	Negated  bool   `json:"negated"`
	Passed   bool   `json:"passed"`
	Bypassed bool   `json:"bypassed,omitempty"`
}

type StreamTrace struct {
	ID      int64         `json:"id"`
	Name    string        `json:"name"`
	Kind    string        `json:"kind"`
	Matched bool          `json:"matched"`
	Chosen  bool          `json:"chosen"`
	Note    string        `json:"note,omitempty"`
	Filters []FilterTrace `json:"filters"`
}

// pick selects the stream for a visit: forced streams in order, then regular
// streams by position or weight, then the default stream.
func (c *CampaignRT) pick(v *Visit, trace *[]StreamTrace) *StreamRT {
	try := func(s *StreamRT) bool {
		if trace == nil {
			return s.matches(v, nil)
		}
		t := StreamTrace{ID: s.ID, Name: s.Name, Kind: s.Kind, Filters: []FilterTrace{}}
		t.Matched = s.matches(v, &t)
		*trace = append(*trace, t)
		return t.Matched
	}
	chosen := func(s *StreamRT) *StreamRT {
		if trace != nil {
			for i := range *trace {
				if (*trace)[i].ID == s.ID {
					(*trace)[i].Chosen = true
				}
			}
		}
		return s
	}
	for _, s := range c.Forced {
		if try(s) {
			return chosen(s)
		}
	}
	if c.Rotation == "weight" {
		var matched []*StreamRT
		total := 0
		for _, s := range c.Regular {
			if try(s) && s.Weight > 0 {
				matched = append(matched, s)
				total += s.Weight
			}
		}
		if total > 0 {
			n := rand.IntN(total)
			for _, s := range matched {
				if n -= s.Weight; n < 0 {
					return chosen(s)
				}
			}
		}
	} else {
		for _, s := range c.Regular {
			if try(s) {
				return chosen(s)
			}
		}
	}
	for _, s := range c.Default {
		if try(s) {
			return chosen(s)
		}
	}
	return nil
}

// Stats is a cheap health summary for the panel.
type Stats struct {
	QueueLen      int   `json:"queue_len"`
	ClicksWritten int64 `json:"clicks_written"`
	ClicksDropped int64 `json:"clicks_dropped"`
	UniqEntries   int   `json:"uniq_entries"`
	Domains       int   `json:"domains"`
	Campaigns     int   `json:"campaigns"`
}

func (e *Engine) Stats() Stats {
	s := e.Snap()
	return Stats{QueueLen: e.Events.QueueLen(), ClicksWritten: e.Events.Written.Load(), ClicksDropped: e.Events.Dropped.Load(),
		UniqEntries: e.uniq.size(), Domains: len(s.Domains), Campaigns: len(s.ByID)}
}

// StreamErrors reports streams left out of rotation because of bad config.
func (e *Engine) StreamErrors(ctx context.Context) map[int64]string {
	out := map[int64]string{}
	streams, err := store.List[model.Stream](ctx, e.Store, "streams", "id")
	if err != nil {
		return out
	}
	for _, s := range streams {
		if _, err := compileFilters(s.Filters); err != nil {
			out[s.ID] = err.Error()
		} else if _, err := buildAction(s.ActionType, s.ActionConfig, e); err != nil {
			out[s.ID] = err.Error()
		}
	}
	return out
}

// ValidateStream checks filters and action config before saving.
func (e *Engine) ValidateStream(s *model.Stream) error {
	if err := ValidateFilters(s.Filters); err != nil {
		return err
	}
	if _, err := buildAction(s.ActionType, s.ActionConfig, e); err != nil {
		return fmt.Errorf("action: %w", err)
	}
	return nil
}
