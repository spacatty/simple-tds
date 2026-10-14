package web

import (
	"bytes"
	"log/slog"
	"net"
	"time"

	"github.com/pires/go-proxyproto"
)

// strayProxy is a PROXY protocol header the HTTPS listener could not use. An
// SSL passthrough in front of the server (nginx stream with proxy_protocol
// on, HAProxy send-proxy) sends one on every connection, and without the
// matching settings every handshake fails: the domain check names the cause
// instead of reporting a missing certificate.
type strayProxy struct {
	at      time.Time
	refused bool // PROXY protocol is on, but the sender is not a trusted proxy
}

var proxyV2Sig = []byte("\r\n\r\n\x00\r\nQUIT\n")

func isProxyHeader(b []byte) bool {
	return bytes.HasPrefix(b, []byte("PROXY ")) || len(b) >= len(proxyV2Sig) && bytes.HasPrefix(b, proxyV2Sig)
}

func (s *Server) noteStrayProxy(c net.Conn, refused bool) {
	// The address of the proxy itself, not the client it names.
	if pc, ok := c.(*proxyproto.Conn); ok {
		c = pc.Raw()
	}
	host, _, err := net.SplitHostPort(c.RemoteAddr().String())
	if err != nil {
		return
	}
	s.strayMu.Lock()
	defer s.strayMu.Unlock()
	if s.strays == nil {
		s.strays = map[string]strayProxy{}
	}
	if prev, ok := s.strays[host]; !ok || time.Since(prev.at) > 10*time.Minute {
		slog.Warn("HTTPS connection starts with a PROXY protocol header that is not accepted", "from", host, "proxy_protocol_on", refused)
	}
	s.strays[host] = strayProxy{at: time.Now(), refused: refused}
	for k, v := range s.strays {
		if time.Since(v.at) > time.Hour {
			delete(s.strays, k)
		}
	}
}

// strayProxySince returns a sender of an unusable PROXY header seen after t.
func (s *Server) strayProxySince(t time.Time) (string, strayProxy, bool) {
	s.strayMu.Lock()
	defer s.strayMu.Unlock()
	for host, v := range s.strays {
		if !v.at.Before(t) {
			return host, v, true
		}
	}
	return "", strayProxy{}, false
}
