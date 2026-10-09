package engine

import (
	"fmt"
	"net/netip"
	"strings"
	"time"

	"simpletds/internal/events"
	"simpletds/internal/model"
)

// suppressRule is one model.SuppressRule as the click path needs it.
type suppressRule struct {
	id      int64
	ownerID int64
	kind    string
	value   string
	// count: the rule keeps a counter; log: and the requests themselves.
	count, log bool
}

// suppressList is a set of rules compiled for lookup.
type suppressList struct {
	addrs map[netip.Addr]*suppressRule
	nets  []suppressNet
	refs  map[string]*suppressRule
}

type suppressNet struct {
	prefix netip.Prefix
	rule   *suppressRule
}

// ParseSuppressIP reads an address or a network and returns it together with
// the form it is stored and shown in.
func ParseSuppressIP(s string) (netip.Prefix, string, error) {
	s = strings.TrimSpace(s)
	if a, err := netip.ParseAddr(s); err == nil {
		a = a.Unmap()
		return netip.PrefixFrom(a, a.BitLen()), a.String(), nil
	}
	p, err := netip.ParsePrefix(s)
	if err != nil {
		return netip.Prefix{}, "", fmt.Errorf("%q is not an IP address or CIDR network", s)
	}
	p = p.Masked()
	if p.IsSingleIP() {
		return p, p.Addr().String(), nil
	}
	return p, p.String(), nil
}

func (l *suppressList) add(r *suppressRule) {
	switch r.kind {
	case model.SuppressIP:
		p, _, err := ParseSuppressIP(r.value)
		switch {
		case err != nil:
		case p.IsSingleIP():
			if l.addrs[p.Addr()] == nil {
				l.addrs[p.Addr()] = r
			}
		default:
			l.nets = append(l.nets, suppressNet{p, r})
		}
	case model.SuppressReferer:
		if d := strings.ToLower(strings.TrimSpace(r.value)); d != "" && l.refs[d] == nil {
			l.refs[d] = r
		}
	}
}

// match returns the rule that refuses the request, or nil. The address is
// checked first: it is the stronger identity of the two.
func (l *suppressList) match(ip netip.Addr, refHost string) *suppressRule {
	if r := l.addrs[ip]; r != nil {
		return r
	}
	for _, n := range l.nets {
		if n.prefix.Contains(ip) {
			return n.rule
		}
	}
	if len(l.refs) == 0 {
		return nil
	}
	// A rule covers the subdomains too: try the host, then each parent.
	for host := refHost; host != ""; {
		if r := l.refs[host]; r != nil {
			return r
		}
		_, rest, ok := strings.Cut(host, ".")
		if !ok {
			break
		}
		host = rest
	}
	return nil
}

// attachSuppress hands every campaign the rules that apply to it. A rule
// without campaigns covers what its owner owns; a rule naming campaigns
// covers those its owner may run, as domains and postback keys do.
func attachSuppress(campaigns map[int64]*CampaignRT, rules []model.SuppressRule) {
	if len(rules) == 0 {
		return
	}
	newList := func() *suppressList {
		return &suppressList{addrs: map[netip.Addr]*suppressRule{}, refs: map[string]*suppressRule{}}
	}
	everywhere := map[int64]*suppressList{} // by owner; shared by all of the owner's campaigns
	named := map[int64]*suppressList{}      // by campaign
	for i := range rules {
		m := &rules[i]
		r := &suppressRule{id: m.ID, ownerID: m.OwnerID, kind: m.Kind, value: m.Value,
			count: m.Store != model.SuppressOff, log: m.Store == model.SuppressLog}
		if len(m.CampaignIDs) == 0 {
			if everywhere[m.OwnerID] == nil {
				everywhere[m.OwnerID] = newList()
			}
			everywhere[m.OwnerID].add(r)
			continue
		}
		for _, id := range m.CampaignIDs {
			if c := campaigns[id]; c != nil && c.UsableBy(m.OwnerID) {
				if named[id] == nil {
					named[id] = newList()
				}
				named[id].add(r)
			}
		}
	}
	for id, c := range campaigns {
		if l := everywhere[c.OwnerID]; l != nil {
			c.suppress = append(c.suppress, l)
		}
		if l := named[id]; l != nil {
			c.suppress = append(c.suppress, l)
		}
	}
}

// suppressed returns the rule that keeps this request out of the campaign.
func (c *CampaignRT) suppressed(ip netip.Addr, referer string) *suppressRule {
	if len(c.suppress) == 0 {
		return nil
	}
	host := hostOf(referer)
	for _, l := range c.suppress {
		if r := l.match(ip, host); r != nil {
			return r
		}
	}
	return nil
}

// suppressed keeps what the rule asks for about a refused request.
func (e *Engine) suppressed(in *Input, r *suppressRule) {
	if !r.count {
		return
	}
	s := &events.Suppressed{TS: time.Now(), OwnerID: uint32(r.ownerID), Kind: r.kind, RuleID: uint64(r.id), Log: r.log}
	if s.Log {
		s.Rule, s.IP, s.Referer, s.Domain = r.value, in.IP.Unmap().String(), clip(in.Referer, 1000), in.Domain
		s.CampaignID = uint32(in.Campaign.ID)
		if in.Header != nil {
			s.UA = clip(in.Header.Get("User-Agent"), 500)
		}
	}
	e.Events.AddSuppressed(s)
}
