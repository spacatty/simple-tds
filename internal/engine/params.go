package engine

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// ParamDef is a request parameter the tracker gives a meaning to. Senders do
// not always let you choose the name, so every one of them can be reached
// under extra names: the built-in ones below plus whatever is added in
// Settings → Parameter names. To make another parameter renameable, add it
// here and read it through Snapshot.Params.
type ParamDef struct {
	Name  string `json:"name"`
	Group string `json:"group"`
	Label string `json:"label"`
	// Builtin names always work; they predate the setting.
	Builtin []string `json:"builtin"`
	// Aliases are the names added in the settings. Filled in for the panel.
	Aliases []string `json:"aliases"`
	// Macro: the names added in the settings also work as {macros} in stream
	// URLs and content.
	Macro bool `json:"macro"`
	// stored parameters have a column of their own in the conversion log and
	// are left out of the free-form ones.
	stored bool
}

const (
	groupPostback = "Postback"
	groupClick    = "Campaign URL"
)

var systemParams = []ParamDef{
	{Name: "click_id", Group: groupPostback, Label: "Click ID, also on browser event URLs",
		Builtin: []string{"clickid", "subid", "cid"}, Macro: true, stored: true},
	{Name: "key", Group: groupPostback, Label: "Postback key", stored: true},
	{Name: "type", Group: groupPostback, Label: "Conversion type or funnel stage key", stored: true},
	{Name: "revenue", Group: groupPostback, Label: "Revenue", Builtin: []string{"payout"}, stored: true},
	{Name: "currency", Group: groupPostback, Label: "Currency", stored: true},
	{Name: "ip", Group: groupPostback, Label: "Visitor IP, for keys attributed by IP"},
	{Name: "sig", Group: groupPostback, Label: "Signature", stored: true},
	{Name: "ts", Group: groupPostback, Label: "Signature timestamp", stored: true},
	{Name: "keyword", Group: groupClick, Label: "Keyword", Macro: true},
	subDef("1"), subDef("2"), subDef("3"), subDef("4"), subDef("5"),
}

func subDef(n string) ParamDef {
	return ParamDef{Name: "sub" + n, Group: groupClick, Label: "Sub ID " + n,
		Builtin: []string{"sub_id_" + n, "subid" + n, "sub_id" + n}, Macro: true}
}

// ParamNames resolves system parameters under every name they go by.
type ParamNames struct {
	names  map[string][]string // system name → accepted names, the system one first
	stored map[string]bool     // accepted names of parameters with their own column
	macros map[string]string   // name added in the settings → system macro
	custom map[string][]string
}

// NewParamNames builds the lookup from the aliases saved in the settings.
// Entries that no longer pass validation are skipped rather than trusted.
func NewParamNames(aliases map[string][]string) *ParamNames {
	clean, err := CleanParamAliases(aliases)
	if err != nil {
		clean = nil
	}
	p := &ParamNames{names: map[string][]string{}, stored: map[string]bool{}, macros: map[string]string{}, custom: clean}
	for _, d := range systemParams {
		all := append(append([]string{d.Name}, d.Builtin...), clean[d.Name]...)
		p.names[d.Name] = all
		if d.stored {
			for _, n := range all {
				p.stored[n] = true
			}
		}
		if d.Macro {
			for _, n := range clean[d.Name] {
				p.macros[n] = d.Name
			}
		}
	}
	return p
}

var defaultParams = NewParamNames(nil)

// A snapshot built by hand (tests) has no names: fall back to the built-in ones.
func (p *ParamNames) orDefault() *ParamNames {
	if p == nil {
		return defaultParams
	}
	return p
}

// Names lists every name the system parameter is accepted under.
func (p *ParamNames) Names(name string) []string { return p.orDefault().names[name] }

// Get reads a system parameter from a query under any of its names.
func (p *ParamNames) Get(q url.Values, name string) string {
	for _, n := range p.Names(name) {
		if v := q.Get(n); v != "" {
			return v
		}
	}
	return ""
}

// Stored reports whether a postback parameter is kept in a column of its own.
func (p *ParamNames) Stored(name string) bool { return p.orDefault().stored[name] }

// Macro maps a macro name added in the settings to the system macro.
func (p *ParamNames) Macro(name string) (string, bool) {
	canon, ok := p.orDefault().macros[name]
	return canon, ok
}

// Defs describes the system parameters with their current extra names.
func (p *ParamNames) Defs() []ParamDef {
	p = p.orDefault()
	out := make([]ParamDef, len(systemParams))
	for i, d := range systemParams {
		if d.Builtin == nil {
			d.Builtin = []string{}
		}
		d.Aliases = append([]string{}, p.custom[d.Name]...)
		out[i] = d
	}
	return out
}

const maxParamAliases = 20

var reParamName = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,40}$`)

// CleanParamAliases validates the extra parameter names from the settings and
// returns them without blanks, repeats and empty entries.
func CleanParamAliases(in map[string][]string) (map[string][]string, error) {
	taken := map[string]string{}
	for _, d := range systemParams {
		taken[d.Name] = d.Name
		for _, b := range d.Builtin {
			taken[b] = d.Name
		}
	}
	for _, n := range internalParams {
		taken[n] = "the tracker itself"
	}
	for name := range in {
		if taken[name] != name {
			return nil, fmt.Errorf("unknown system parameter %q", name)
		}
	}
	out := map[string][]string{}
	// In declaration order, so the same conflict is always reported the same way.
	for _, d := range systemParams {
		for _, a := range in[d.Name] {
			a = strings.TrimSpace(a)
			if a == "" || taken[a] == d.Name {
				continue
			}
			if !reParamName.MatchString(a) {
				return nil, fmt.Errorf("parameter name %q: 1-40 letters, digits, _ - or .", a)
			}
			if owner := taken[a]; owner != "" {
				return nil, fmt.Errorf("parameter name %q is already taken by %s", a, owner)
			}
			if len(out[d.Name]) == maxParamAliases {
				return nil, fmt.Errorf("%s: at most %d extra names", d.Name, maxParamAliases)
			}
			taken[a] = d.Name
			out[d.Name] = append(out[d.Name], a)
		}
	}
	return out, nil
}
