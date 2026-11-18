package egress

import (
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

const (
	domainAssocFloor = 5 * time.Second
	domainAssocCap   = time.Hour
	domainAssocMaxIP = 4096
)

// domainTable remembers which qname this helper just answered to which IP.
// A later transparent TCP connection can be forwarded as that hostname only
// when the mapping is unique. Shared CDN addresses are not guessed.
type domainTable struct {
	mu   sync.Mutex
	byIP map[string]map[string]time.Time
}

func (t *domainTable) observe(reply []byte, now time.Time) {
	var msg dnsmessage.Message
	if err := msg.Unpack(reply); err != nil || !msg.Response || msg.RCode != dnsmessage.RCodeSuccess {
		return
	}
	cnames := map[string]string{}
	addrs := map[string][]domainAddr{}
	for _, ans := range msg.Answers {
		owner := normalizeDNSName(ans.Header.Name.String())
		if owner == "" {
			continue
		}
		switch body := ans.Body.(type) {
		case *dnsmessage.CNAMEResource:
			if target := normalizeDNSName(body.CNAME.String()); target != "" {
				cnames[owner] = target
			}
		case *dnsmessage.AResource:
			if ip := net.IP(body.A[:]).String(); usableAssocIP(ip) {
				addrs[owner] = append(addrs[owner], domainAddr{ip: ip, ttl: ans.Header.TTL})
			}
		case *dnsmessage.AAAAResource:
			if ip := net.IP(body.AAAA[:]).String(); usableAssocIP(ip) {
				addrs[owner] = append(addrs[owner], domainAddr{ip: ip, ttl: ans.Header.TTL})
			}
		}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pruneLocked(now)
	for _, question := range msg.Questions {
		if question.Type != dnsmessage.TypeA && question.Type != dnsmessage.TypeAAAA && question.Type != dnsmessage.TypeALL {
			continue
		}
		qname := normalizeDNSName(question.Name.String())
		if qname == "" || net.ParseIP(qname) != nil {
			continue
		}
		seen := map[string]bool{qname: true}
		name := qname
		var found []domainAddr
		for range 8 {
			found = append(found, addrs[name]...)
			next, ok := cnames[name]
			if !ok || seen[next] {
				break
			}
			seen[next] = true
			name = next
		}
		for _, addr := range found {
			t.addLocked(addr.ip, qname, now.Add(assocTTL(addr.ttl)))
		}
	}
}

// rewrite returns the SOCKS dial address. A unique fresh association becomes
// hostname:port. No association keeps the literal. More than one qname fails
// closed instead of picking a CDN name or falling back to the literal.
func (t *domainTable) rewrite(dest string, now time.Time) (string, error) {
	host, port, err := net.SplitHostPort(dest)
	if err != nil {
		return dest, nil
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return dest, nil
	}
	name, kind := t.lookup(ip.String(), now)
	switch kind {
	case "unique":
		return net.JoinHostPort(name, port), nil
	case "ambiguous":
		return "", fmt.Errorf("refusing to guess a hostname for %s", ip.String())
	default:
		return dest, nil
	}
}

func (t *domainTable) lookup(ip string, now time.Time) (string, string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pruneLocked(now)
	names := t.byIP[ip]
	switch len(names) {
	case 0:
		return "", "none"
	case 1:
		for name := range names {
			return name, "unique"
		}
	}
	return "", "ambiguous"
}

func (t *domainTable) addLocked(ip, name string, expires time.Time) {
	if t.byIP == nil {
		t.byIP = map[string]map[string]time.Time{}
	}
	if _, ok := t.byIP[ip]; !ok && len(t.byIP) >= domainAssocMaxIP {
		t.evictLocked()
	}
	slot := t.byIP[ip]
	if slot == nil {
		slot = map[string]time.Time{}
		t.byIP[ip] = slot
	}
	if current, ok := slot[name]; !ok || expires.After(current) {
		slot[name] = expires
	}
}

func (t *domainTable) pruneLocked(now time.Time) {
	for ip, names := range t.byIP {
		for name, expires := range names {
			if !expires.After(now) {
				delete(names, name)
			}
		}
		if len(names) == 0 {
			delete(t.byIP, ip)
		}
	}
}

func (t *domainTable) evictLocked() {
	var oldestIP string
	var oldest time.Time
	for ip, names := range t.byIP {
		for _, expires := range names {
			if oldestIP == "" || expires.Before(oldest) {
				oldestIP = ip
				oldest = expires
			}
		}
	}
	if oldestIP != "" {
		delete(t.byIP, oldestIP)
	}
}

type domainAddr struct {
	ip  string
	ttl uint32
}

func assocTTL(ttl uint32) time.Duration {
	d := time.Duration(ttl) * time.Second
	if d < domainAssocFloor {
		return domainAssocFloor
	}
	if d > domainAssocCap {
		return domainAssocCap
	}
	return d
}

func normalizeDNSName(name string) string {
	name = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(name)), ".")
	if name == "" || len(name) > 253 {
		return ""
	}
	return name
}

func usableAssocIP(ip string) bool {
	parsed := net.ParseIP(ip)
	if parsed == nil || parsed.IsUnspecified() {
		return false
	}
	return true
}

func (s *Server) dialDest(dest string) (string, error) {
	if s == nil {
		return dest, nil
	}
	return s.dialDestFor(s.rt(), dest)
}

func (s *Server) dialDestFor(rt *runtime, dest string) (string, error) {
	if !rt.cfg.DomainForward {
		return dest, nil
	}
	rewritten, err := s.domains.rewrite(dest, time.Now())
	if err != nil {
		log.Printf("kin-egress domain_forward ambiguous dest=%s: %v", dest, err)
		return "", &spliceError{class: classAmbiguousDomain, dest: dest, err: err}
	}
	if rewritten != dest {
		log.Printf("kin-egress domain_forward hostname literal=%s dial=%s", dest, rewritten)
		return rewritten, nil
	}
	if host, _, splitErr := net.SplitHostPort(dest); splitErr == nil && net.ParseIP(host) != nil {
		log.Printf("kin-egress domain_forward literal dest=%s reason=no_hostname", dest)
	}
	return dest, nil
}
