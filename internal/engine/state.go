package engine

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"hash/maphash"
	"sync"
	"time"
)

// ---- click ids --------------------------------------------------------------

// A click id is 22 bytes, base64url encoded:
//
//	4 unix seconds | 3 campaign id | 3 stream id | 6 random | 6 HMAC
//
// Carrying the campaign and time lets a postback be attributed and validated
// without a database lookup, and the HMAC makes ids unforgeable.
const clickIDRaw = 22

func (e *Engine) newClickID(now time.Time, campaignID, streamID int64) string {
	var b [clickIDRaw]byte
	binary.BigEndian.PutUint32(b[0:4], uint32(now.Unix()))
	b[4], b[5], b[6] = byte(campaignID>>16), byte(campaignID>>8), byte(campaignID)
	b[7], b[8], b[9] = byte(streamID>>16), byte(streamID>>8), byte(streamID)
	rand.Read(b[10:16])
	m := hmac.New(sha256.New, e.secret)
	m.Write(b[:16])
	copy(b[16:], m.Sum(nil)[:6])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

type clickRef struct {
	At         time.Time
	CampaignID uint32
	StreamID   uint32
}

var errBadClickID = errors.New("invalid click id")

func (e *Engine) parseClickID(id string) (clickRef, error) {
	b, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil || len(b) != clickIDRaw {
		return clickRef{}, errBadClickID
	}
	m := hmac.New(sha256.New, e.secret)
	m.Write(b[:16])
	if !hmac.Equal(b[16:], m.Sum(nil)[:6]) {
		return clickRef{}, errBadClickID
	}
	return clickRef{
		At:         time.Unix(int64(binary.BigEndian.Uint32(b[0:4])), 0),
		CampaignID: uint32(b[4])<<16 | uint32(b[5])<<8 | uint32(b[6]),
		StreamID:   uint32(b[7])<<16 | uint32(b[8])<<8 | uint32(b[9]),
	}, nil
}

// ---- visitor uniqueness -----------------------------------------------------

const (
	uniqShards   = 64
	uniqShardCap = 250_000
)

type uniqShard struct {
	mu sync.Mutex
	m  map[uint64]int64 // visitor hash → expiry (unix seconds)
}

// uniqStore remembers recent visitors in memory. It is approximate by design:
// it is lost on restart and sheds entries under memory pressure.
type uniqStore struct {
	seed   maphash.Seed
	shards [uniqShards]uniqShard
}

func newUniqStore() *uniqStore {
	u := &uniqStore{seed: maphash.MakeSeed()}
	for i := range u.shards {
		u.shards[i].m = map[uint64]int64{}
	}
	go u.janitor()
	return u
}

func (u *uniqStore) key(campaignID int64, ip, ua string) uint64 {
	var h maphash.Hash
	h.SetSeed(u.seed)
	var id [8]byte
	binary.LittleEndian.PutUint64(id[:], uint64(campaignID))
	h.Write(id[:])
	h.WriteString(ip)
	h.WriteByte(0)
	h.WriteString(ua)
	return h.Sum64()
}

// forget undoes first, for a hit that turned out not to be a click.
func (u *uniqStore) forget(campaignID int64, ip, ua string) {
	key := u.key(campaignID, ip, ua)
	sh := &u.shards[key%uniqShards]
	sh.mu.Lock()
	delete(sh.m, key)
	sh.mu.Unlock()
}

// first reports whether this is the visitor's first hit within ttl, and records it.
func (u *uniqStore) first(campaignID int64, ip, ua string, ttl time.Duration, now time.Time) bool {
	key := u.key(campaignID, ip, ua)
	sh := &u.shards[key%uniqShards]
	ts := now.Unix()
	sh.mu.Lock()
	defer sh.mu.Unlock()
	if exp, ok := sh.m[key]; ok && exp > ts {
		return false
	}
	if len(sh.m) >= uniqShardCap {
		// Shed an arbitrary tenth rather than stall the click path.
		n := uniqShardCap / 10
		for k := range sh.m {
			delete(sh.m, k)
			if n--; n == 0 {
				break
			}
		}
	}
	sh.m[key] = ts + int64(ttl/time.Second)
	return true
}

func (u *uniqStore) size() int {
	n := 0
	for i := range u.shards {
		u.shards[i].mu.Lock()
		n += len(u.shards[i].m)
		u.shards[i].mu.Unlock()
	}
	return n
}

func (u *uniqStore) janitor() {
	for range time.Tick(5 * time.Minute) {
		now := time.Now().Unix()
		for i := range u.shards {
			sh := &u.shards[i]
			sh.mu.Lock()
			for k, exp := range sh.m {
				if exp <= now {
					delete(sh.m, k)
				}
			}
			sh.mu.Unlock()
		}
	}
}

// ---- postback rate limiting -------------------------------------------------

type bucket struct {
	count int
	reset int64
}

// rateLimiter is a fixed one-minute window counter per key.
type rateLimiter struct {
	mu sync.Mutex
	m  map[string]*bucket
}

func newRateLimiter() *rateLimiter {
	r := &rateLimiter{m: map[string]*bucket{}}
	go func() {
		for range time.Tick(time.Minute) {
			now := time.Now().Unix()
			r.mu.Lock()
			for k, b := range r.m {
				if b.reset <= now {
					delete(r.m, k)
				}
			}
			r.mu.Unlock()
		}
	}()
	return r
}

// Allow reports whether key may act again, given limit per minute.
func (r *rateLimiter) Allow(key string, limit int) bool {
	if limit <= 0 {
		return true
	}
	now := time.Now().Unix()
	r.mu.Lock()
	defer r.mu.Unlock()
	b := r.m[key]
	if b == nil || b.reset <= now {
		if len(r.m) > 500_000 {
			r.m = map[string]*bucket{}
		}
		b = &bucket{reset: now + 60}
		r.m[key] = b
	}
	b.count++
	return b.count <= limit
}

// Count returns how many times key was seen in the current window.
func (r *rateLimiter) Count(key string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if b := r.m[key]; b != nil && b.reset > time.Now().Unix() {
		return b.count
	}
	return 0
}

// Allow exposes the limiter for other entry points (panel login).
func (e *Engine) Allow(key string, limit int) bool { return e.limits.Allow(key, limit) }

// ---- rejected postbacks -----------------------------------------------------

type Rejected struct {
	At      time.Time `json:"at"`
	IP      string    `json:"ip"`
	Key     string    `json:"key"`      // first characters of the key that was sent
	KeyName string    `json:"key_name"` // empty when the key is unknown
	// OwnerID is the key's owner, 0 for unknown keys: only admins see those.
	OwnerID int64  `json:"-"`
	Reason  string `json:"reason"`
	Query   string `json:"query"`
}

// rejectLog keeps the most recent refused postbacks for the panel.
type rejectLog struct {
	mu    sync.Mutex
	items []Rejected
	Total int64
}

const rejectKeep = 500

func (l *rejectLog) add(r Rejected) {
	if len(r.Query) > 500 {
		r.Query = r.Query[:500]
	}
	l.mu.Lock()
	l.Total++
	l.items = append(l.items, r)
	if len(l.items) > rejectKeep {
		l.items = l.items[len(l.items)-rejectKeep:]
	}
	l.mu.Unlock()
}

// List returns rejected postbacks, newest first. ownerID 0 returns all of
// them with the lifetime total; otherwise only that owner's keys.
func (l *rejectLog) List(ownerID int64) ([]Rejected, int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Rejected, 0, len(l.items))
	for i := len(l.items) - 1; i >= 0; i-- {
		if ownerID == 0 || l.items[i].OwnerID == ownerID {
			out = append(out, l.items[i])
		}
	}
	if ownerID == 0 {
		return out, l.Total
	}
	return out, int64(len(out))
}
