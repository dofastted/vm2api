package egress

import (
	"strings"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// Every slot lookup used to go out as DoH through the residential proxy:
// CONNECT + TLS + query, ~0.6s on the request's critical path, because the
// CLI resolves api.anthropic.com before each new connection and its TTL is
// ~60s. The cache answers repeats locally and, past TTL, serves the last
// answer while one background lookup refreshes it.
const (
	// dnsCacheMaxFresh caps how long an upstream TTL is trusted.
	dnsCacheMaxFresh = 10 * time.Minute
	// dnsCacheStaleFor is how long past expiry a positive answer may still be
	// served (with dnsCacheStaleTTL) while a refresh runs.
	dnsCacheStaleFor = time.Hour
	dnsCacheStaleTTL = 30
	// dnsCacheMaxNegative caps NXDOMAIN / NODATA lifetime; negatives are never
	// served stale.
	dnsCacheMaxNegative = time.Minute
	dnsCacheMaxEntries  = 4096
	dnsRefreshTimeout   = 15 * time.Second
)

type dnsCacheKey struct {
	name  string
	qtype dnsmessage.Type
	class dnsmessage.Class
	edns  bool
}

type dnsCacheEntry struct {
	msg        dnsmessage.Message
	expires    time.Time
	staleUntil time.Time
	refreshing bool
}

type dnsCache struct {
	mu      sync.Mutex
	entries map[dnsCacheKey]*dnsCacheEntry
}

// dnsQueryKey returns the cache key for a plain single-question query.
func dnsQueryKey(query []byte) (dnsmessage.Message, dnsCacheKey, bool) {
	var msg dnsmessage.Message
	if err := msg.Unpack(query); err != nil {
		return msg, dnsCacheKey{}, false
	}
	if msg.Response || msg.OpCode != 0 || len(msg.Questions) != 1 {
		return msg, dnsCacheKey{}, false
	}
	q := msg.Questions[0]
	key := dnsCacheKey{
		name:  strings.ToLower(q.Name.String()),
		qtype: q.Type,
		class: q.Class,
	}
	for _, add := range msg.Additionals {
		if add.Header.Type == dnsmessage.TypeOPT {
			key.edns = true
		}
	}
	return msg, key, true
}

// lookup returns a reply for query from cache. stale reports that the entry
// is past its TTL and the caller should refresh it.
func (c *dnsCache) lookup(key dnsCacheKey, query dnsmessage.Message, now time.Time) (reply []byte, stale bool, ok bool) {
	c.mu.Lock()
	entry := c.entries[key]
	if entry == nil || !now.Before(entry.staleUntil) {
		c.mu.Unlock()
		return nil, false, false
	}
	msg := entry.msg
	ttl := uint32(dnsCacheStaleTTL)
	if now.Before(entry.expires) {
		ttl = uint32(entry.expires.Sub(now) / time.Second)
		if ttl == 0 {
			ttl = 1
		}
	} else {
		stale = true
	}
	c.mu.Unlock()

	msg.Header.ID = query.Header.ID
	msg.Header.RecursionDesired = query.Header.RecursionDesired
	msg.Questions = query.Questions
	msg.Answers = stampTTL(msg.Answers, ttl)
	msg.Authorities = stampTTL(msg.Authorities, ttl)
	msg.Additionals = stampTTL(msg.Additionals, ttl)
	packed, err := msg.Pack()
	if err != nil {
		return nil, false, false
	}
	return packed, stale, true
}

// beginRefresh marks key as refreshing; false if a refresh is already running.
func (c *dnsCache) beginRefresh(key dnsCacheKey) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry := c.entries[key]
	if entry == nil || entry.refreshing {
		return false
	}
	entry.refreshing = true
	return true
}

func (c *dnsCache) endRefresh(key dnsCacheKey) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if entry := c.entries[key]; entry != nil {
		entry.refreshing = false
	}
}

// store caches an upstream reply when it is a complete, cacheable answer.
func (c *dnsCache) store(key dnsCacheKey, reply []byte, now time.Time) {
	var msg dnsmessage.Message
	if err := msg.Unpack(reply); err != nil || !msg.Response || msg.Truncated {
		return
	}
	var fresh, staleFor time.Duration
	switch {
	case msg.RCode == dnsmessage.RCodeSuccess && len(msg.Answers) > 0:
		ttl, ok := minTTL(msg.Answers)
		if !ok || ttl == 0 {
			return
		}
		fresh = min(time.Duration(ttl)*time.Second, dnsCacheMaxFresh)
		staleFor = dnsCacheStaleFor
	case msg.RCode == dnsmessage.RCodeSuccess || msg.RCode == dnsmessage.RCodeNameError:
		ttl, ok := negativeTTL(msg.Authorities)
		if !ok || ttl == 0 {
			return
		}
		fresh = min(time.Duration(ttl)*time.Second, dnsCacheMaxNegative)
	default:
		return
	}
	entry := &dnsCacheEntry{msg: msg, expires: now.Add(fresh), staleUntil: now.Add(fresh + staleFor)}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[dnsCacheKey]*dnsCacheEntry{}
	}
	if len(c.entries) >= dnsCacheMaxEntries {
		for k, e := range c.entries {
			if !now.Before(e.staleUntil) {
				delete(c.entries, k)
			}
		}
		if len(c.entries) >= dnsCacheMaxEntries {
			clear(c.entries)
		}
	}
	c.entries[key] = entry
}

func stampTTL(in []dnsmessage.Resource, ttl uint32) []dnsmessage.Resource {
	if len(in) == 0 {
		return in
	}
	out := make([]dnsmessage.Resource, len(in))
	copy(out, in)
	for i := range out {
		// OPT carries extended RCODE/flags in the TTL field.
		if out[i].Header.Type == dnsmessage.TypeOPT {
			continue
		}
		out[i].Header.TTL = min(out[i].Header.TTL, ttl)
		if out[i].Header.TTL == 0 {
			out[i].Header.TTL = 1
		}
	}
	return out
}

func minTTL(rrs []dnsmessage.Resource) (uint32, bool) {
	var ttl uint32
	found := false
	for _, rr := range rrs {
		if rr.Header.Type == dnsmessage.TypeOPT {
			continue
		}
		if !found || rr.Header.TTL < ttl {
			ttl = rr.Header.TTL
			found = true
		}
	}
	return ttl, found
}

// negativeTTL follows RFC 2308: min(SOA TTL, SOA MINIMUM).
func negativeTTL(authorities []dnsmessage.Resource) (uint32, bool) {
	for _, rr := range authorities {
		if soa, ok := rr.Body.(*dnsmessage.SOAResource); ok {
			return min(rr.Header.TTL, soa.MinTTL), true
		}
	}
	return 0, false
}
