package antibot

import (
	"bytes"
	"net/netip"
	"regexp"
	"sort"
)

// Set is an immutable set of IP ranges with O(log n) membership tests.
type Set struct {
	v4 []rng4 // sorted, non-overlapping
	v6 []rng6
	n  int
}

type rng4 struct{ lo, hi uint32 }
type rng6 struct{ lo, hi [16]byte }

func u32(a netip.Addr) uint32 {
	b := a.As4()
	return uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
}

// NewSet builds a set from prefixes, merging overlaps.
func NewSet(prefixes []netip.Prefix) *Set {
	s := &Set{n: len(prefixes)}
	for _, p := range prefixes {
		p = p.Masked()
		a := p.Addr()
		if a.Is4() {
			lo := u32(a)
			hi := lo | (uint32(0xFFFFFFFF) >> uint(p.Bits()))
			if p.Bits() == 0 {
				hi = 0xFFFFFFFF
			}
			s.v4 = append(s.v4, rng4{lo, hi})
			continue
		}
		lo := a.As16()
		hi := lo
		for bit := p.Bits(); bit < 128; bit++ {
			hi[bit/8] |= 1 << (7 - uint(bit%8))
		}
		s.v6 = append(s.v6, rng6{lo, hi})
	}
	sort.Slice(s.v4, func(i, j int) bool { return s.v4[i].lo < s.v4[j].lo })
	out4 := s.v4[:0]
	for _, r := range s.v4 {
		if n := len(out4); n > 0 && r.lo <= out4[n-1].hi {
			if r.hi > out4[n-1].hi {
				out4[n-1].hi = r.hi
			}
			continue
		}
		out4 = append(out4, r)
	}
	s.v4 = out4
	sort.Slice(s.v6, func(i, j int) bool { return bytes.Compare(s.v6[i].lo[:], s.v6[j].lo[:]) < 0 })
	out6 := s.v6[:0]
	for _, r := range s.v6 {
		if n := len(out6); n > 0 && bytes.Compare(r.lo[:], out6[n-1].hi[:]) <= 0 {
			if bytes.Compare(r.hi[:], out6[n-1].hi[:]) > 0 {
				out6[n-1].hi = r.hi
			}
			continue
		}
		out6 = append(out6, r)
	}
	s.v6 = out6
	return s
}

func (s *Set) Len() int { return s.n }

func (s *Set) Contains(a netip.Addr) bool {
	if s == nil {
		return false
	}
	a = a.Unmap()
	if a.Is4() {
		v := u32(a)
		i := sort.Search(len(s.v4), func(i int) bool { return s.v4[i].hi >= v })
		return i < len(s.v4) && s.v4[i].lo <= v
	}
	b := a.As16()
	i := sort.Search(len(s.v6), func(i int) bool { return bytes.Compare(s.v6[i].hi[:], b[:]) >= 0 })
	return i < len(s.v6) && bytes.Compare(s.v6[i].lo[:], b[:]) <= 0
}

var (
	reV4 = regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}(?:/\d{1,2})?\b`)
	reV6 = regexp.MustCompile(`(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?:/\d{1,3})?`)
)

// ParsePrefixes extracts every IP or CIDR from free-form text, so plain lists
// and vendor JSON feeds are handled the same way.
func ParsePrefixes(text []byte) []netip.Prefix {
	var out []netip.Prefix
	add := func(m []byte) {
		s := string(m)
		if p, err := netip.ParsePrefix(s); err == nil {
			out = append(out, p)
		} else if a, err := netip.ParseAddr(s); err == nil {
			out = append(out, netip.PrefixFrom(a, a.BitLen()))
		}
	}
	for _, m := range reV4.FindAll(text, -1) {
		add(m)
	}
	for _, m := range reV6.FindAll(text, -1) {
		add(m)
	}
	return out
}
