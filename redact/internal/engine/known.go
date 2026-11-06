package redact

import (
	"crypto/sha256"
	"fmt"
	"slices"
	"strings"
)

// A value masked once is masked again wherever it is in a request, as it
// is, whatever is around it. The rules find a value by what is around it
// (DB_PASSWORD=, a bound an email may not touch), and the vendor answers
// about a placeholder in words of its own: "the password is {{SECRET_…}}",
// "write to {{EMAIL_…}}.". The agent reads the value there (Restore), and
// on the next turn that text comes back in the history, where no rule
// matches it. Matched as cur().known, it goes as the same placeholder again.
//
// What is cur().known is what cur().values holds (in memory only, bounded by
// maxValues): the cur().values of the placeholders made since magpie started,
// for every request alike, since a placeholder is the same for the same
// value whichever conversation it is in.

// minKnown is the shortest value matched as cur().known. Shorter ones (a
// password of three letters in a URL, which the rule takes from its
// user:password@) would turn up all over ordinary text; 8 is what the rule
// for a password in an assignment asks of its value.
const minKnown = 8

type knownValue struct{ v, p, kind string }

// Known-value indexes live on the active Scope.

func gram(s string, i int) uint32 {
	g := uint32(s[i]) | uint32(s[i+1])<<8 | uint32(s[i+2])<<16 | uint32(s[i+3])<<24
	return (g * 2654435761) >> 12 // 20 bits
}

// addKnown adds the value of placeholder p; called with mu held. The
// user's own words are left to Options.Words, which match them anywhere
// already, and are only as long as two letters.
func addKnown(p, v string) {
	kind := kindOf(p)
	if kind == "TERM" || len(v) < minKnown {
		return
	}
	head := v[:minKnown]
	for i, k := range cur().known[head] {
		if k.v == v {
			// one value under two cur().kinds: the same one wins whichever came
			// first, so it is the same after reindexKnown
			if p < k.p {
				cur().known[head][i] = knownValue{v, p, kind}
				cur().knownGen.Add(1)
			}
			return
		}
	}
	cur().known[head] = append(cur().known[head], knownValue{v, p, kind})
	g := gram(v, 0)
	cur().knownBits[g/64] |= 1 << (g % 64)
	cur().knownGen.Add(1)
}

// reindexKnown makes cur().known again from cur().values, after some were let go;
// called with mu held.
func reindexKnown() {
	cur().known = map[string][]knownValue{}
	cur().knownBits = [1 << 14]uint64{}
	cur().knownGen.Add(1)
	for p, v := range cur().values {
		addKnown(p, v)
	}
}

// kindOf is the kind in a placeholder: SECRET of {{SECRET_abcdefgh}}, or
// a made-up key's (shape.go); called with mu held.
func kindOf(p string) string {
	if k, ok := cur().shapes[p]; ok {
		return k
	}
	if strings.HasPrefix(p, "{{R_") && strings.HasSuffix(p, "}}") {
		body := p[len("{{R_") : len(p)-2]
		if i := strings.LastIndexByte(body, '_'); i > 0 && len(body)-i-1 == 26 {
			return body[:i]
		}
	}
	if i := strings.LastIndexByte(p, '_'); i > 2 {
		return p[2:i]
	}
	return ""
}

// kindCats are the categories each kind of personal data is found under
// (Options.covers): a user name is under both home folders and user@host.
// A kind not in it is a secret's, the user's rules' among them.
var kindCats = func() map[string][]string {
	m := map[string][]string{}
	for _, r := range rules {
		kinds := r.groups
		if len(kinds) == 0 {
			kinds = []string{r.kind}
		}
		for _, k := range kinds {
			if r.cat != "" && !slices.Contains(m[k], r.cat) {
				m[k] = append(m[k], r.cat)
			}
		}
	}
	// and the model's: a name it found is personal data, not a secret
	for _, k := range modelKinds {
		if c := modelCat(k); c != "" && !slices.Contains(m[k], c) {
			m[k] = append(m[k], c)
		}
	}
	return m
}()

// coversKind says o masks a cur().known value of kind: a personal one when one
// of the categories it is found under is on, any other when o masks
// secrets.
func (o Options) coversKind(kind string) bool {
	cats, ok := kindCats[kind]
	if !ok {
		return o.Secrets
	}
	for _, c := range cats {
		if o.covers(c) {
			return true
		}
	}
	return false
}

// knownSpans are where s has a cur().known value o masks (coversKind). Where two
// start at the same place, the longer.
func knownSpans(s string, o Options) []span {
	if !o.Secrets && !o.Personal || len(s) < minKnown {
		return nil
	}
	cur().mu.RLock()
	defer cur().mu.RUnlock()
	if len(cur().known) == 0 {
		return nil
	}
	var out []span
	for i := 0; i+minKnown <= len(s); i++ {
		if g := gram(s, i); cur().knownBits[g/64]&(1<<(g%64)) == 0 {
			continue
		}
		var best *knownValue
		for j, k := range cur().known[s[i:i+minKnown]] {
			if !o.coversKind(k.kind) {
				continue
			}
			if best != nil && len(k.v) <= len(best.v) || !strings.HasPrefix(s[i:], k.v) || !standsAlone(k.kind, s, i, i+len(k.v)) {
				continue
			}
			best = &cur().known[s[i:i+minKnown]][j]
		}
		if best != nil {
			out = append(out, span{i, i + len(best.v), best.kind, ByKnown})
			i += len(best.v) - 1
		}
	}
	return out
}

// standsAlone says s[a:b] is the cur().known value itself, not a piece of a
// longer one: a number with no digit beside it, an email that is not part
// of a longer address (though a full stop may end the sentence after it),
// a secret with no letter or digit against it (twelve hex digits a rule of
// the user's took are also in the middle of a hash).
func standsAlone(kind, s string, a, b int) bool {
	before, after := byte(0), byte(0)
	if a > 0 {
		before = s[a-1]
	}
	if b < len(s) {
		after = s[b]
	}
	is := func(c byte, set string) bool { return c != 0 && strings.IndexByte(set, c) >= 0 }
	switch kind {
	case "PHONE", "BANK_CARD":
		return !is(before, digits) && !is(after, digits)
	case "ID_CARD", "IBAN", "SSN", "PASSPORT", "SERIAL":
		return !is(before, alnum) && !is(after, alnum)
	case "IP", "MAC":
		// not a piece of a longer address or a version: 1.2.3.45, 1.2.3.4.5
		if is(before, alnum+".:") || is(after, alnum+":") {
			return false
		}
		return after != '.' || b+1 >= len(s) || !is(s[b+1], digits)
	case "EMAIL":
		if is(before, alnum+"._%+-") || is(after, alnum+"_%+") {
			return false
		}
		// a.b@c.com.cn is another address; a.b@c.com. ends a sentence
		return !is(after, ".-") || b+1 >= len(s) || !is(s[b+1], alnum)
	}
	return !(is(before, alnum) && is(s[a], alnum)) && !(is(after, alnum) && is(s[b-1], alnum))
}

// A text sent before goes again as it went: the cur().known cur().values found in it
// the first time it was masked are the ones masked in it from then on,
// and a value that became cur().known since is masked in new text only.
//
// An agent sends its whole conversation on every turn, and a vendor
// caches it by its bytes up to a mark (Anthropic's cache_control, the
// prefix OpenAI and DeepSeek cache on their own). A value found by a rule
// in a turn's tool output became cur().known, and the next turn masked it again
// in the system prompt and every earlier message that had it as written:
// the prefix changed at its first block, and a 400K-token conversation was
// written to the cache whole instead of read (audie on Discord: cache_read
// 0 and cache_write 412,081 to 426,782 on four turns, ten seconds apart).
// Masking it there keeps nothing from the vendor, which was sent that text
// as written already.
//
// What is remembered is a hash of the text and of what o covers, and the
// places of the cur().known cur().values in it; nothing of a value. A text no longer
// remembered (sentEntries, or magpie started again) is masked with what is
// cur().known then.
const sentEntries = 1 << 16

// sentKnown lives on the active Scope.

// sentKnownSpans is knownSpans for text going to a vendor: the same as the
// first time s was masked under what o covers.
func sentKnownSpans(s string, o Options) []span {
	if !o.Secrets && !o.Personal || len(s) < minKnown {
		return nil
	}
	h := sha256.New()
	fmt.Fprintf(h, "%t\x00%t\x00", o.Secrets, o.Personal)
	kinds := make([]string, 0, len(o.Kinds))
	for k, on := range o.Kinds {
		kinds = append(kinds, fmt.Sprintf("%s=%t", k, on))
	}
	slices.Sort(kinds)
	fmt.Fprintf(h, "%s\x00", strings.Join(kinds, ","))
	h.Write([]byte(s))
	var k [32]byte
	h.Sum(k[:0])
	cur().sentKnown.Lock()
	sp, ok := cur().sentKnown.cur[k]
	if !ok {
		if sp, ok = cur().sentKnown.old[k]; ok {
			sentKnownAdd(k, sp) // still in use: kept past the next turnover
		}
	}
	cur().sentKnown.Unlock()
	if ok {
		return slices.Clone(sp)
	}
	sp = knownSpans(s, o)
	cur().sentKnown.Lock()
	sentKnownAdd(k, slices.Clone(sp))
	cur().sentKnown.Unlock()
	return sp
}

// sentKnownAdd is called with cur().sentKnown held. Two generations, as
// scrubMemo keeps: when the newer is full it becomes the older.
func sentKnownAdd(k [32]byte, sp []span) {
	if cur().sentKnown.cur == nil || len(cur().sentKnown.cur) >= sentEntries {
		cur().sentKnown.old, cur().sentKnown.cur = cur().sentKnown.cur, make(map[[32]byte][]span)
	}
	cur().sentKnown.cur[k] = sp
}

// resetSent forgets the texts sent (a test starts from nothing).
func resetSent() {
	cur().sentKnown.Lock()
	defer cur().sentKnown.Unlock()
	cur().sentKnown.cur, cur().sentKnown.old = nil, nil
}
