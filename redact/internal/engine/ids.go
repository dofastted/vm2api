package redact

import (
	"slices"
	"strings"
)

// An id a backend made (a UUID, 32 hex digits or more: a row's, a
// request's, a session's, a commit's) goes as written. The vendor's model
// reads it, matches it and writes it back into a tool call, and a backend
// looks it up by every one of its characters: one masked, or a piece of one,
// is a lookup that finds nothing or the wrong row. A piece of one is never
// a value of its own: the phone rule found 13800138000 at the end of
// …-a13800138000, the bank card rule 4111-1111-1111-9007 across a UUID's
// groups, and the id went half a placeholder. A whole one is masked only
// as a credential, in a field named for one (password=, api_key:,
// "refresh_token":), never in one named for an id (secret_id, token_id),
// a cursor (next_page_token), a request (Idempotency-Key, csrf_token), a
// digest (secret_hash) or a bare "key"; never as a serial number (sn:),
// and never as what the model takes it for (a name, an account), but for
// hex digits without hyphens it calls a secret (an API key in prose). What
// the user chose (their words, their rules) stays theirs.

// noIDs is found without what is in an id of s, but for what the user
// chose and the credentials named for one.
func noIDs(s string, found []span) []span {
	return slices.DeleteFunc(found, func(f span) bool {
		if f.by == ByWord || f.by == ByYours {
			return false
		}
		l, r, ok := idAround(s, f.start, f.end)
		if !ok {
			return false
		}
		if f.start > l || f.end < r {
			return true // a piece of an id
		}
		switch f.by {
		case ByKnown:
			// masked before as what it is in full: a credential
			return false
		case ByModel:
			// a key the model found in prose: 32 hex digits it calls a
			// secret ("the api key is 9f8e…"); never a UUID
			return f.kind != "SECRET" || uuidRe.MatchString(s[l:r])
		case ByRule:
			switch f.kind {
			case "PASSWORD", "API_KEY", "TOKEN", "PRIVATE_KEY":
				return false
			case "SECRET":
				return !credentialField(s, l)
			}
		}
		return true
	})
}

// idAround is the id that s[a:b] is in, or is: the run of hex digits and
// hyphens around it, when that run is a UUID or 32 hex digits or more.
// ok is false where s[a:b] reaches past such a run.
func idAround(s string, a, b int) (l, r int, ok bool) {
	l, r = a, b
	for l > 0 && hexOrHyphen(s[l-1]) {
		l--
	}
	for r < len(s) && hexOrHyphen(s[r]) {
		r++
	}
	for l < r && s[l] == '-' {
		l++
	}
	for r > l && s[r-1] == '-' {
		r--
	}
	if a < l || b > r || strings.IndexFunc(s[l:r], func(c rune) bool { return c > 0x7f || !hexOrHyphen(byte(c)) }) >= 0 ||
		!idShaped(s[l:r]) {
		return 0, 0, false
	}
	return l, r, true
}

func hexOrHyphen(c byte) bool {
	return c == '-' || c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

// idShaped says v, hex digits and hyphens, is a UUID or 32 hex digits or
// more without a hyphen.
func idShaped(v string) bool {
	return uuidRe.MatchString(v) || len(v) >= 32 && !strings.Contains(v, "-")
}

// credentialField says the field whose value starts at s[at] is named for
// a credential: refresh_token, DB_PASSWORD, x-api-key; not one named for
// an id, a cursor or a request, and not a bare "key".
func credentialField(s string, at int) bool {
	i := at
	for i > 0 && strings.IndexByte(" \t\"'\\", s[i-1]) >= 0 {
		i--
	}
	if i == 0 || s[i-1] != ':' && s[i-1] != '=' {
		return false
	}
	i--
	for i > 0 && strings.IndexByte(" \t\"'\\", s[i-1]) >= 0 {
		i--
	}
	j := i
	for j > 0 && strings.IndexByte(alnum+"_.-", s[j-1]) >= 0 {
		j--
	}
	words := nameWords(s[j:i])
	if len(words) < 2 && (len(words) == 0 || words[0] == "key") {
		return false
	}
	switch words[len(words)-1] {
	case "id", "ids", "uuid", "guid":
		return false
	}
	for _, w := range words {
		switch w {
		case "page", "next", "cursor", "continuation", "csrf", "xsrf", "trace", "request", "idempotency", "sync", "nonce",
			"hash", "digest", "checksum", "sha", "fingerprint", "etag":
			return false
		}
	}
	return true
}

// nameWords are a field's name's words in lower case: next_page_token,
// nextPageToken and X-Next-Page-Token are next, page, token.
func nameWords(name string) []string {
	var out []string
	w := []byte{}
	flush := func() {
		if len(w) > 0 {
			out = append(out, string(w))
			w = w[:0]
		}
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		switch {
		case c == '_' || c == '-' || c == '.':
			flush()
		case c >= 'A' && c <= 'Z':
			if i > 0 && name[i-1] >= 'a' && name[i-1] <= 'z' {
				flush()
			}
			w = append(w, c+'a'-'A')
		default:
			w = append(w, c)
		}
	}
	flush()
	return out
}
