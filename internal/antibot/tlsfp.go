package antibot

import (
	"crypto/md5"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// TLSInfo is the client's TLS fingerprint, available on domains where the app
// terminates TLS itself.
type TLSInfo struct {
	JA3    string
	JA4    string
	Grease bool // client sent GREASE values (Chromium, Safari)
	H2     bool // client offered HTTP/2
	TLS13  bool
}

// GREASE values are 0x?a?a with both bytes equal.
func isGrease(v uint16) bool { return v&0x0f0f == 0x0a0a && v>>8 == v&0xff }

func joinU16(vs []uint16, sep string) string {
	parts := make([]string, len(vs))
	for i, v := range vs {
		parts[i] = strconv.Itoa(int(v))
	}
	return strings.Join(parts, sep)
}

func hexList(vs []uint16) string {
	parts := make([]string, len(vs))
	for i, v := range vs {
		parts[i] = fmt.Sprintf("%04x", v)
	}
	return strings.Join(parts, ",")
}

func sha12(s string) string {
	if s == "" {
		return "000000000000"
	}
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])[:12]
}

// Fingerprint derives JA3 and JA4 from a ClientHello.
func Fingerprint(h *tls.ClientHelloInfo) *TLSInfo {
	info := &TLSInfo{}
	var ciphers, exts, curves []uint16
	for _, c := range h.CipherSuites {
		if isGrease(c) {
			info.Grease = true
			continue
		}
		ciphers = append(ciphers, c)
	}
	for _, e := range h.Extensions {
		if isGrease(e) {
			info.Grease = true
			continue
		}
		exts = append(exts, e)
	}
	for _, c := range h.SupportedCurves {
		if !isGrease(uint16(c)) {
			curves = append(curves, uint16(c))
		}
	}
	points := make([]uint16, len(h.SupportedPoints))
	for i, p := range h.SupportedPoints {
		points[i] = uint16(p)
	}
	var maxVer uint16
	for _, v := range h.SupportedVersions {
		if !isGrease(v) && v > maxVer {
			maxVer = v
		}
	}
	info.TLS13 = maxVer >= tls.VersionTLS13
	for _, p := range h.SupportedProtos {
		if p == "h2" {
			info.H2 = true
		}
	}

	// JA3 uses the legacy record version, which is 771 for every modern client.
	ja3 := strings.Join([]string{"771", joinU16(ciphers, "-"), joinU16(exts, "-"), joinU16(curves, "-"), joinU16(points, "-")}, ",")
	sum := md5.Sum([]byte(ja3))
	info.JA3 = hex.EncodeToString(sum[:])

	ver := "00"
	switch maxVer {
	case tls.VersionTLS13:
		ver = "13"
	case tls.VersionTLS12:
		ver = "12"
	case tls.VersionTLS11:
		ver = "11"
	case tls.VersionTLS10:
		ver = "10"
	}
	sni := "i"
	if h.ServerName != "" {
		sni = "d"
	}
	alpn := "00"
	if len(h.SupportedProtos) > 0 && h.SupportedProtos[0] != "" {
		p := h.SupportedProtos[0]
		alpn = string(p[0]) + string(p[len(p)-1])
	}
	sortedC := append([]uint16(nil), ciphers...)
	sort.Slice(sortedC, func(i, j int) bool { return sortedC[i] < sortedC[j] })
	var sortedE []uint16
	for _, e := range exts {
		if e != 0x0000 && e != 0x0010 { // SNI and ALPN are excluded from the hash
			sortedE = append(sortedE, e)
		}
	}
	sort.Slice(sortedE, func(i, j int) bool { return sortedE[i] < sortedE[j] })
	sigs := make([]uint16, 0, len(h.SignatureSchemes))
	for _, s := range h.SignatureSchemes {
		if !isGrease(uint16(s)) {
			sigs = append(sigs, uint16(s))
		}
	}
	extPart := hexList(sortedE)
	if len(sigs) > 0 {
		extPart += "_" + hexList(sigs)
	}
	info.JA4 = fmt.Sprintf("t%s%s%02d%02d%s_%s_%s", ver, sni, min(len(ciphers), 99), min(len(exts), 99), alpn, sha12(hexList(sortedC)), sha12(extPart))
	return info
}
