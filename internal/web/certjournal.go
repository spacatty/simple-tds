package web

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap/zapcore"
)

// certLogEntry is one line of a domain's certificate history.
type certLogEntry struct {
	At    time.Time `json:"at"`
	Level string    `json:"level"`
	Msg   string    `json:"msg"`
}

const certLogMax = 150

// certJournal is what happened to one domain's certificate since the server
// started: certmagic's and the ACME client's log lines plus the outcome of
// each attempt.
type certJournal struct {
	mu          sync.Mutex
	entries     []certLogEntry
	attempts    int
	lastAttempt time.Time
	lastError   string
	errorAt     time.Time
}

func (j *certJournal) add(level, msg string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.entries = append(j.entries, certLogEntry{At: time.Now(), Level: level, Msg: msg})
	if n := len(j.entries) - certLogMax; n > 0 {
		j.entries = append(j.entries[:0:0], j.entries[n:]...)
	}
}

func (j *certJournal) attempt() {
	j.mu.Lock()
	j.attempts++
	j.lastAttempt = time.Now()
	n := j.attempts
	j.mu.Unlock()
	j.add("info", fmt.Sprintf("attempt %d: requesting a certificate", n))
}

func (j *certJournal) setError(msg string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.lastError, j.errorAt = msg, time.Now()
}

func (j *certJournal) failure() (string, time.Time) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.lastError, j.errorAt
}

// journalLocked returns the journal of name, creating it; m.mu is held.
func (m *certManager) journalLocked(name string) *certJournal {
	j := m.journals[name]
	if j == nil {
		j = &certJournal{}
		m.journals[name] = j
	}
	return j
}

// journal returns the journal of a managed domain, or nil.
func (m *certManager) journal(name string) *certJournal {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.journals[strings.ToLower(name)]
}

// certInfo is a domain's certificate as the panel shows it.
type certInfo struct {
	Managed     bool           `json:"managed"`
	State       string         `json:"state"` // issued, failed, obtaining, none
	Account     string         `json:"account"`
	CA          string         `json:"ca"`
	NotAfter    *time.Time     `json:"not_after,omitempty"`
	Issuer      string         `json:"issuer,omitempty"`
	Attempts    int            `json:"attempts"`
	LastAttempt *time.Time     `json:"last_attempt,omitempty"`
	LastError   string         `json:"last_error,omitempty"`
	ErrorAt     *time.Time     `json:"error_at,omitempty"`
	Log         []certLogEntry `json:"log"`
}

func (m *certManager) info(name string) certInfo {
	name = strings.ToLower(name)
	out := certInfo{State: "none", Log: []certLogEntry{}}
	// The cache lock may be held while certmagic calls back into m: read
	// the certificate before taking m.mu.
	leaf := m.leaf(name)
	m.mu.Lock()
	if mc := m.managed[name]; mc != nil {
		out.Managed, out.Account, out.CA = true, mc.email, mc.ca
	}
	j := m.journals[name]
	m.mu.Unlock()
	if j != nil {
		j.mu.Lock()
		out.Attempts, out.LastError = j.attempts, j.lastError
		if !j.lastAttempt.IsZero() {
			t := j.lastAttempt
			out.LastAttempt = &t
		}
		if !j.errorAt.IsZero() {
			t := j.errorAt
			out.ErrorAt = &t
		}
		out.Log = append(out.Log, j.entries...)
		j.mu.Unlock()
	}
	switch {
	case leaf != nil:
		out.State = "issued"
		t := leaf.Leaf.NotAfter
		out.NotAfter = &t
		out.Issuer = leaf.Leaf.Issuer.CommonName
		if o := leaf.Leaf.Issuer.Organization; len(o) > 0 {
			out.Issuer = o[0] + " " + out.Issuer
		}
	case out.LastError != "":
		out.State = "failed"
	case out.Managed:
		out.State = "obtaining"
	}
	return out
}

// journalCore is the zap logger behind certmagic and the ACME client: it
// files every line in the journal of the domain it is about and passes it on
// to the server log, where certmagic's default logger used to write it.
type journalCore struct {
	m      *certManager
	domain string // fixed for a domain's own config; else taken from the line
	fields []zapcore.Field
}

func (c *journalCore) Enabled(l zapcore.Level) bool { return l >= zapcore.InfoLevel }

func (c *journalCore) With(fields []zapcore.Field) zapcore.Core {
	return &journalCore{m: c.m, domain: c.domain, fields: append(append([]zapcore.Field{}, c.fields...), fields...)}
}

func (c *journalCore) Check(e zapcore.Entry, ce *zapcore.CheckedEntry) *zapcore.CheckedEntry {
	if c.Enabled(e.Level) {
		return ce.AddCore(e, c)
	}
	return ce
}

func (c *journalCore) Sync() error { return nil }

func (c *journalCore) Write(e zapcore.Entry, fields []zapcore.Field) error {
	enc := zapcore.NewMapObjectEncoder()
	for _, f := range c.fields {
		f.AddTo(enc)
	}
	for _, f := range fields {
		f.AddTo(enc)
	}
	domain := c.domain
	if domain == "" {
		id, _ := enc.Fields["identifier"].(string)
		domain = strings.ToLower(id)
	}
	keys := make([]string, 0, len(enc.Fields))
	for k := range enc.Fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(e.Message)
	attrs := []any{"logger", e.LoggerName}
	for _, k := range keys {
		v := fmt.Sprint(enc.Fields[k])
		attrs = append(attrs, k, v)
		if k == "identifier" && strings.EqualFold(v, domain) {
			continue
		}
		if len(v) > 400 {
			v = v[:400] + "…"
		}
		fmt.Fprintf(&b, "; %s: %s", k, v)
	}
	level := slog.LevelInfo
	name := "info"
	switch {
	case e.Level >= zapcore.ErrorLevel:
		level, name = slog.LevelError, "error"
	case e.Level == zapcore.WarnLevel:
		level, name = slog.LevelWarn, "warn"
	}
	slog.Log(context.Background(), level, "acme: "+e.Message, attrs...)
	if domain != "" {
		if j := c.m.journal(domain); j != nil {
			j.add(name, b.String())
		}
	}
	return nil
}
