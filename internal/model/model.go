// Package model holds the configuration entities shared by every layer.
package model

import (
	"encoding/json"
	"time"
)

type User struct {
	ID           int64  `db:"id" json:"id"`
	Username     string `db:"username" json:"username"`
	PasswordHash string `db:"password_hash" json:"-"`
	TOTPSecret   string `db:"totp_secret" json:"-"`
	TOTPEnabled  bool   `db:"totp_enabled" json:"totp_enabled"`
	Role         string `db:"role" json:"role"` // admin | user
	Enabled      bool   `db:"enabled" json:"enabled"`
	// Prefs are the user's own panel preferences (which view a list opens in,
	// and the like). They follow the account, not the browser.
	Prefs map[string]string `db:"prefs" json:"prefs"`
}

const (
	RoleAdmin = "admin"
	RoleUser  = "user"
)

func (u *User) IsAdmin() bool { return u.Role == RoleAdmin }

// Campaign access levels, lowest to highest. A share grants one of the first
// three; the owner and admins always have AccessOwner.
const (
	AccessNone  = 0
	AccessStats = 1 // reports, clicks and conversions only
	AccessRead  = 2 // plus the campaign's configuration, read-only
	AccessEdit  = 3 // plus changing streams and settings
	AccessOwner = 4 // plus sharing and deleting
)

var accessNames = map[string]int{"stats": AccessStats, "read": AccessRead, "edit": AccessEdit}

// ParseAccess maps a share level name to its rank; ok is false for unknown names.
func ParseAccess(name string) (int, bool) {
	a, ok := accessNames[name]
	return a, ok
}

// AccessName is the inverse of ParseAccess, with "owner" for AccessOwner.
func AccessName(a int) string {
	switch a {
	case AccessStats:
		return "stats"
	case AccessRead:
		return "read"
	case AccessEdit:
		return "edit"
	case AccessOwner:
		return "owner"
	}
	return ""
}

// Share grants a user access to someone else's campaign: directly, or through
// the campaign group it is in.
type Share struct {
	CampaignID int64  `db:"campaign_id" json:"campaign_id"`
	UserID     int64  `db:"user_id" json:"user_id"`
	Access     string `db:"access" json:"access"`
	Username   string `db:"username" json:"username"`
}

// CampaignGroup is a folder of its owner's campaigns. Sharing a group shares
// every campaign in it, including the ones added later.
type CampaignGroup struct {
	ID      int64  `db:"id" json:"id"`
	OwnerID int64  `db:"owner_id" json:"owner_id"`
	Name    string `db:"name" json:"name"`
	// Access and OwnerName describe the group from the viewer's side; they are
	// filled in by the API, not stored.
	Access    string `db:"-" json:"access,omitempty"`
	OwnerName string `db:"-" json:"owner_name,omitempty"`
}

func (g *CampaignGroup) Owner() int64      { return g.OwnerID }
func (g *CampaignGroup) SetOwner(id int64) { g.OwnerID = id }

// GroupShare grants a user access to every campaign of someone else's group.
type GroupShare struct {
	GroupID  int64  `db:"group_id" json:"group_id"`
	UserID   int64  `db:"user_id" json:"user_id"`
	Access   string `db:"access" json:"access"`
	Username string `db:"username" json:"username"`
}

// Dashboard is a user's own board of pinned widgets. It holds no data, only
// what to show: the numbers come from the reports, with their access rules.
type Dashboard struct {
	ID        int64        `db:"id" json:"id"`
	OwnerID   int64        `db:"owner_id" json:"owner_id"`
	Name      string       `db:"name" json:"name"`
	Position  int          `db:"position" json:"position"`
	Widgets   []DashWidget `db:"widgets" json:"widgets"`
	CreatedAt time.Time    `db:"created_at" json:"created_at"`
}

// DashWidget is one tile of a dashboard.
type DashWidget struct {
	ID    string `json:"id"`
	Type  string `json:"type"` // stat | chart | funnel | top
	Title string `json:"title,omitempty"`
	// CampaignID and StreamID narrow the widget; zero means everything the viewer can see.
	CampaignID int64  `json:"campaign_id,omitempty"`
	StreamID   int64  `json:"stream_id,omitempty"`
	Metric     string `json:"metric,omitempty"` // stat, chart
	Dim        string `json:"dim,omitempty"`    // top
	W          int    `json:"w"`                // width in twelfths of the board
	H          int    `json:"h,omitempty"`      // height in pixels; zero fits the content
}

// Owned is implemented by every per-user entity.
type Owned interface {
	Owner() int64
	SetOwner(int64)
}

func (d *Domain) Owner() int64           { return d.OwnerID }
func (d *Domain) SetOwner(id int64)      { d.OwnerID = id }
func (g *DomainGroup) Owner() int64      { return g.OwnerID }
func (g *DomainGroup) SetOwner(id int64) { g.OwnerID = id }
func (c *Campaign) Owner() int64         { return c.OwnerID }
func (c *Campaign) SetOwner(id int64)    { c.OwnerID = id }
func (w *Whitepage) Owner() int64        { return w.OwnerID }
func (w *Whitepage) SetOwner(id int64)   { w.OwnerID = id }
func (k *ConvKey) Owner() int64          { return k.OwnerID }
func (k *ConvKey) SetOwner(id int64)     { k.OwnerID = id }

type DomainGroup struct {
	ID      int64  `db:"id" json:"id"`
	OwnerID int64  `db:"owner_id" json:"owner_id"`
	Name    string `db:"name" json:"name"`
}

// Domain TLS modes.
const (
	TLSAuto  = "auto"  // app terminates TLS, certificate issued automatically
	TLSProxy = "proxy" // TLS is terminated by an external proxy / CDN
)

// Domain real-IP sources.
const (
	IPDirect = "direct" // socket address (PROXY protocol aware)
	IPCF     = "cf"     // CF-Connecting-IP
	IPXFF    = "xff"    // X-Forwarded-For (leftmost)
	IPXReal  = "x_real_ip"
)

type Domain struct {
	ID           int64      `db:"id" json:"id"`
	OwnerID      int64      `db:"owner_id" json:"owner_id"`
	Name         string     `db:"name" json:"name"`
	GroupID      *int64     `db:"group_id" json:"group_id"`
	CampaignID   *int64     `db:"campaign_id" json:"campaign_id"` // campaign served on "/"
	TLSMode      string     `db:"tls_mode" json:"tls_mode"`
	IPSource     string     `db:"ip_source" json:"ip_source"`
	AdminEnabled bool       `db:"admin_enabled" json:"admin_enabled"`
	Enabled      bool       `db:"enabled" json:"enabled"`
	Status       string     `db:"status" json:"status"` // pending | ok | error
	StatusMsg    string     `db:"status_msg" json:"status_msg"`
	CheckedAt    *time.Time `db:"checked_at" json:"checked_at"`
	Note         string     `db:"note" json:"note"`
	CreatedAt    time.Time  `db:"created_at" json:"created_at"`
	// Reputation is what the blocklist providers said last; RepStatus sums it
	// up. Both are owned by the reputation checker.
	RepStatus    string      `db:"rep_status" json:"rep_status"` // "" (not checked) | clean | listed | unknown
	Reputation   []RepResult `db:"reputation" json:"reputation"`
	RepCheckedAt *time.Time  `db:"rep_checked_at" json:"rep_checked_at"`
}

// RepResult is one blocklist provider's answer about a domain.
type RepResult struct {
	Provider  string    `json:"provider"`
	Status    string    `json:"status"` // clean | listed | error
	Detail    string    `json:"detail,omitempty"`
	URL       string    `json:"url,omitempty"` // the provider's own page about the domain
	CheckedAt time.Time `json:"checked_at"`
}

type Campaign struct {
	ID      int64 `db:"id" json:"id"`
	OwnerID int64 `db:"owner_id" json:"owner_id"`
	// Access and OwnerName describe the campaign from the viewer's side; they
	// are filled in by the API, not stored.
	Access    string `db:"-" json:"access,omitempty"`
	OwnerName string `db:"-" json:"owner_name,omitempty"`
	// GroupID is the owner's group the campaign is filed under, if any.
	GroupID     *int64    `db:"group_id" json:"group_id"`
	Name        string    `db:"name" json:"name"`
	Alias       string    `db:"alias" json:"alias"`
	Token       string    `db:"token" json:"token"` // secret for the PHP integration
	Enabled     bool      `db:"enabled" json:"enabled"`
	Rotation    string    `db:"rotation" json:"rotation"`     // position | weight
	CostModel   string    `db:"cost_model" json:"cost_model"` // none | cpc | cpuc | cpm | cpa | revshare
	CostValue   float64   `db:"cost_value" json:"cost_value"`
	Currency    string    `db:"currency" json:"currency"`
	UniqueHours int       `db:"unique_hours" json:"unique_hours"`
	Stages      []Stage   `db:"stages" json:"stages"` // conversion funnel, first step first; empty = single-stage
	Note        string    `db:"note" json:"note"`
	CreatedAt   time.Time `db:"created_at" json:"created_at"`
}

// Stage is one step of a campaign's conversion funnel. Events reach it as a
// conversion whose type is the stage key.
type Stage struct {
	Key  string `json:"key"`
	Name string `json:"name"`
	// Goal marks the stage that counts as the conversion: it drives CR and
	// carries the CPA cost. Exactly one stage of a funnel is the goal.
	Goal bool `json:"goal"`
	// Public stages can be reported from the visitor's browser with nothing
	// but the click id. They never carry revenue or cost.
	Public bool `json:"public"`
}

// Stage returns the campaign's stage with this key, or nil.
func (c *Campaign) Stage(key string) *Stage {
	for i := range c.Stages {
		if c.Stages[i].Key == key {
			return &c.Stages[i]
		}
	}
	return nil
}

// Filter is one stream condition. Mode is "is" or "is_not".
type Filter struct {
	Type   string   `json:"type"`
	Mode   string   `json:"mode"`
	Values []string `json:"values"`
	// Bypass keeps the filter in the stream but leaves it out of matching.
	Bypass bool `json:"bypass,omitempty"`
}

// Stream kinds, evaluated in this order.
const (
	StreamForced  = "forced"
	StreamRegular = "regular"
	StreamDefault = "default"
)

type Stream struct {
	ID           int64           `db:"id" json:"id"`
	CampaignID   int64           `db:"campaign_id" json:"campaign_id"`
	Name         string          `db:"name" json:"name"`
	Kind         string          `db:"kind" json:"kind"`
	Position     int             `db:"position" json:"position"`
	Weight       int             `db:"weight" json:"weight"`
	Enabled      bool            `db:"enabled" json:"enabled"`
	FilterOp     string          `db:"filter_op" json:"filter_op"` // and | or
	Filters      []Filter        `db:"filters" json:"filters"`
	ActionType   string          `db:"action_type" json:"action_type"`
	ActionConfig json.RawMessage `db:"action_config" json:"action_config"`
	JSCheck      bool            `db:"js_check" json:"js_check"`
	Note         string          `db:"note" json:"note"`
}

// StreamPreset is a saved set of stream filters, or a saved action, that a
// user can apply to a stream in one click.
//
// Data is {"filter_op","filters"} for kind "filters" and
// {"action_type","action_config"} for kind "action".
type StreamPreset struct {
	ID      int64           `db:"id" json:"id"`
	OwnerID int64           `db:"owner_id" json:"owner_id"`
	Name    string          `db:"name" json:"name"`
	Kind    string          `db:"kind" json:"kind"`
	Data    json.RawMessage `db:"data" json:"data"`
	// Builtin presets ship with the app and cannot be changed.
	Builtin bool `db:"-" json:"builtin,omitempty"`
}

func (p *StreamPreset) Owner() int64      { return p.OwnerID }
func (p *StreamPreset) SetOwner(id int64) { p.OwnerID = id }

type Whitepage struct {
	ID         int64     `db:"id" json:"id"`
	OwnerID    int64     `db:"owner_id" json:"owner_id"`
	Name       string    `db:"name" json:"name"`
	Key        string    `db:"key" json:"key"`   // public asset path segment
	Kind       string    `db:"kind" json:"kind"` // html | php
	Entry      string    `db:"entry" json:"entry"`
	InjectBase bool      `db:"inject_base" json:"inject_base"`
	Note       string    `db:"note" json:"note"`
	FileCount  int       `db:"file_count" json:"file_count"`
	Size       int64     `db:"size" json:"size"`
	CreatedAt  time.Time `db:"created_at" json:"created_at"`
}

// Conversion attribution modes for a postback key.
const (
	AttrClickID = "click_id" // postback carries a signed click id
	AttrIP      = "ip"       // match the latest click from the reported IP
	AttrNone    = "none"     // standalone event
)

type ConvKey struct {
	ID             int64     `db:"id" json:"id"`
	OwnerID        int64     `db:"owner_id" json:"owner_id"`
	Name           string    `db:"name" json:"name"`
	Key            string    `db:"key" json:"key"`
	Enabled        bool      `db:"enabled" json:"enabled"`
	Secret         string    `db:"secret" json:"secret"` // HMAC secret, used when RequireSig
	RequireSig     bool      `db:"require_sig" json:"require_sig"`
	IPAllow        []string  `db:"ip_allow" json:"ip_allow"`
	RateLimit      int       `db:"rate_limit" json:"rate_limit"` // per source IP per minute, 0 = off
	Attribution    string    `db:"attribution" json:"attribution"`
	RequireClick   bool      `db:"require_click" json:"require_click"`
	WindowHours    int       `db:"window_hours" json:"window_hours"`
	Dedupe         bool      `db:"dedupe" json:"dedupe"`
	DefaultType    string    `db:"default_type" json:"default_type"`
	DefaultRevenue float64   `db:"default_revenue" json:"default_revenue"`
	Note           string    `db:"note" json:"note"`
	CreatedAt      time.Time `db:"created_at" json:"created_at"`
}

type GeoPreset struct {
	ID        int64    `db:"id" json:"id"`
	Name      string   `db:"name" json:"name"`
	Countries []string `db:"countries" json:"countries"`
	Builtin   bool     `db:"builtin" json:"builtin"`
}

// IP list kinds.
const (
	ListBot        = "bot"        // crawlers, ad reviewers: always a bot
	ListDatacenter = "datacenter" // hosting / VPN ranges
	ListBlock      = "block"      // user blocklist: always a bot
	ListAllow      = "allow"      // never a bot (overrides everything)
)

type IPList struct {
	ID           int64      `db:"id" json:"id"`
	Name         string     `db:"name" json:"name"`
	Kind         string     `db:"kind" json:"kind"`
	URL          string     `db:"url" json:"url"`
	Content      string     `db:"content" json:"content"` // manual entries, one CIDR per line
	RefreshHours int        `db:"refresh_hours" json:"refresh_hours"`
	Enabled      bool       `db:"enabled" json:"enabled"`
	Builtin      bool       `db:"builtin" json:"builtin"`
	Entries      int        `db:"entries" json:"entries"`
	UpdatedAt    *time.Time `db:"updated_at" json:"updated_at"`
	LastError    string     `db:"last_error" json:"last_error"`
}

// Integration is an external HTTP JSON lookup used for geo or bot detection.
// URL may contain {ip} and {ua}. Paths are dot-separated JSON paths.
type Integration struct {
	ID           int64             `db:"id" json:"id"`
	Name         string            `db:"name" json:"name"`
	Kind         string            `db:"kind" json:"kind"` // geo | antibot
	Enabled      bool              `db:"enabled" json:"enabled"`
	URL          string            `db:"url" json:"url"`
	Headers      map[string]string `db:"headers" json:"headers"`
	TimeoutMs    int               `db:"timeout_ms" json:"timeout_ms"`
	CacheMinutes int               `db:"cache_minutes" json:"cache_minutes"`
	// Mapping keys: geo → country, region, city, asn, isp; antibot → bot, threshold.
	Mapping map[string]string `db:"mapping" json:"mapping"`
}

// Settings is the single global settings document.
type Settings struct {
	PanelIPAccess bool   `json:"panel_ip_access"`
	AdminPath     string `json:"admin_path"`
	SessionHours  int    `json:"session_hours"`

	ProxyProtocol  bool     `json:"proxy_protocol"`
	TrustedProxies []string `json:"trusted_proxies"`

	// ACMEEmail overrides the per-domain account acme@<domain> when set.
	ACMEEmail   string `json:"acme_email"`
	ACMEStaging bool   `json:"acme_staging"`

	DatacenterIsBot bool     `json:"datacenter_is_bot"`
	HeaderChecks    bool     `json:"header_checks"`
	TLSChecks       bool     `json:"tls_checks"`
	BotThreshold    int      `json:"bot_threshold"`
	BotASNs         []uint32 `json:"bot_asns"`
	DatacenterASNs  []uint32 `json:"datacenter_asns"`
	BotUAPatterns   []string `json:"bot_ua_patterns"`
	JA3Block        []string `json:"ja3_block"`
	JA4Block        []string `json:"ja4_block"`
	JSPassHours     int      `json:"js_pass_hours"`

	GeoCityURL     string `json:"geo_city_url"`
	GeoASNURL      string `json:"geo_asn_url"`
	MaxMindKey     string `json:"maxmind_key"`
	GeoRefreshDays int    `json:"geo_refresh_days"`

	RetentionDays int `json:"retention_days"`

	// ParamAliases gives system request parameters (click_id, key, type, …)
	// extra names: system name → names accepted next to it.
	ParamAliases map[string][]string `json:"param_aliases"`

	Reputation ReputationSettings `json:"reputation"`
}

// Suppress rule kinds.
const (
	SuppressIP      = "ip"      // an address or a CIDR network
	SuppressReferer = "referer" // a referrer domain, subdomains included
)

// What a suppress rule keeps about the requests it refuses.
const (
	SuppressOff   = "off"   // nothing
	SuppressCount = "count" // a daily counter (the default)
	SuppressLog   = "log"   // the counter plus a short line per request
)

// SuppressRule names a source whose requests never reach its owner's
// campaigns: they get a 404 and stay out of clicks, uniqueness and reports.
type SuppressRule struct {
	ID      int64  `db:"id" json:"id"`
	OwnerID int64  `db:"owner_id" json:"owner_id"`
	Kind    string `db:"kind" json:"kind"`
	Value   string `db:"value" json:"value"`
	// CampaignIDs narrows the rule to these campaigns; empty means every
	// campaign the owner has.
	CampaignIDs []int64 `db:"campaign_ids" json:"campaign_ids"`
	// Store is what the rule keeps about the requests it refuses.
	Store     string    `db:"store" json:"store"`
	CreatedAt time.Time `db:"created_at" json:"created_at"`
}

func (r *SuppressRule) Owner() int64      { return r.OwnerID }
func (r *SuppressRule) SetOwner(id int64) { r.OwnerID = id }

// ReputationSettings configures the blocklist checks of domains. Every
// provider is off until an administrator switches it on: a check tells the
// provider the domain name.
type ReputationSettings struct {
	IntervalHours int                    `json:"interval_hours"`
	Providers     map[string]RepProvider `json:"providers"`
}

type RepProvider struct {
	Enabled bool   `json:"enabled"`
	Key     string `json:"key,omitempty"`
	// Threshold is how many votes flag a domain, for providers that count them.
	Threshold int `json:"threshold,omitempty"`
	// PerMinute caps the request rate, for providers with a tight quota.
	PerMinute int `json:"per_minute,omitempty"`
}

func DefaultSettings() Settings {
	return Settings{
		PanelIPAccess:   true,
		AdminPath:       "admin",
		SessionHours:    72,
		DatacenterIsBot: true,
		HeaderChecks:    true,
		TLSChecks:       true,
		BotThreshold:    100,
		// Ad platforms and search engines whose own address space is only ever crawlers.
		BotASNs: []uint32{32934, 63293, 54115, 15169, 396982, 8075, 13238, 208722, 47764, 138699, 396986, 714},
		DatacenterASNs: []uint32{16509, 14618, 14061, 16276, 24940, 63949, 20473, 9009, 60068, 212238,
			51167, 8100, 36352, 46606, 53667, 62240, 136787, 200651, 49981, 60781, 28753, 30633, 32244,
			45102, 37963, 132203, 31898, 19551, 55286, 29802, 40676, 395954, 202425, 211252},
		JSPassHours:    24,
		GeoCityURL:     "https://download.db-ip.com/free/dbip-city-lite-{YYYY}-{MM}.mmdb.gz",
		GeoASNURL:      "https://download.db-ip.com/free/dbip-asn-lite-{YYYY}-{MM}.mmdb.gz",
		GeoRefreshDays: 7,
		RetentionDays:  180,
		Reputation:     ReputationSettings{IntervalHours: 12},
	}
}

// TypeRejected marks a conversion the advertiser declined.
const TypeRejected = "rejected"

// MaxStages caps a campaign's conversion funnel.
const MaxStages = 12

// ConversionTypes are the built-in conversion kinds, accepted by every
// postback. Campaigns add their own on top by defining stages.
var ConversionTypes = []string{"lead", "sale", "install", "registration", "deposit", "action", "rejected"}

// CostModels are the supported campaign cost models.
var CostModels = []string{"none", "cpc", "cpuc", "cpm", "cpa", "revshare"}
