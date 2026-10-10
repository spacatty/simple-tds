package web

import "testing"

func TestPointsHere(t *testing.T) {
	s := &Server{}
	// Without a public address nothing can be said about a foreign one.
	if here, known := s.pointsHere([]string{"198.51.100.7"}); here || known {
		t.Fatalf("unknown server address: here=%v known=%v", here, known)
	}
	s.publicIP.Store("203.0.113.5")
	for _, tc := range []struct {
		addrs []string
		here  bool
	}{
		{[]string{"203.0.113.5"}, true},
		{[]string{"2001:db8::1", "203.0.113.5"}, true},
		{[]string{"::ffff:203.0.113.5"}, true},
		{[]string{"127.0.0.1"}, true},
		{[]string{"198.51.100.7", "198.51.100.8"}, false}, // a CDN's addresses
	} {
		if here, known := s.pointsHere(tc.addrs); here != tc.here || !known {
			t.Errorf("%v: here=%v known=%v, want here=%v", tc.addrs, here, known, tc.here)
		}
	}
}
