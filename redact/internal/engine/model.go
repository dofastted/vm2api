package redact

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// A local model (internal/pii, Settings → Privacy's "Find with a local
// model") finds what no rule can: a name or an address in free text, a
// password with no password= before it. Its spans are masked beside the
// rules', under the same switches: a name, an address, a phone number, an
// email or an account number is personal data, a secret is a secret.

// Found is a span the model found in a text: byte offsets, and its label.
type Found struct {
	Start, End int
	Label      string
}

// Model finds spans in each of texts, in order. It never fails: one that
// can't find (the model didn't start) panics, so that the request is held
// back rather than sent unmasked (gwmw.Safely).
type Model func(texts []string) [][]Found

// modelKinds are the placeholders' cur().kinds for the model's labels. Its
// private_date and private_url are left out: a date in a request is
// nearly always a log's or a version's, and a URL the agent's own.
var modelKinds = map[string]string{
	"private_person":  "PERSON",
	"private_address": "ADDRESS",
	"private_phone":   "PHONE",
	"private_email":   "EMAIL",
	"account_number":  "ACCOUNT",
	"secret":          "SECRET",
}

// modelCat is the category (Options.covers) of each kind the model finds.
func modelCat(kind string) string {
	if kind == "SECRET" {
		return ""
	}
	return catPersonal
}

// modelSpans are o.found's spans for s that o covers, trimmed of the
// spaces the model takes in with a word (and a Chinese name of what it
// ran on into, zhTrim), and with what it gets wrong often left out
// (modelTakes); and the Chinese names it missed (zhNameSpans).
func modelSpans(s string, o Options) []span {
	if o.Model == nil || !o.covers(catPersonal) && len(o.found[s]) == 0 {
		return nil
	}
	var out []span
	for _, f := range o.found[s] {
		kind := modelKinds[f.Label]
		if kind == "" || !o.covers(modelCat(kind)) || f.Start < 0 || f.End > len(s) || f.Start >= f.End {
			continue
		}
		a, b := f.Start, f.End
		if kind == "SECRET" {
			// a JSON key the model took in with its value
			// (ledgerId":"gl_Wq7r…) is the key's, not the secret's
			if k := strings.LastIndex(s[a:b], `":"`); k >= 0 {
				a += k + 3
			}
		}
		edge := isSpace
		if kind != "SECRET" {
			edge = delimiter
		}
		for a < b && edge(s[a]) {
			a++
		}
		for b > a && edge(s[b-1]) {
			b--
		}
		if kind == "PERSON" {
			a, b = zhTrim(s, a, b)
		}
		if a < b && utf8.ValidString(s[a:b]) && modelTakes(kind, s[a:b]) && modelFits(s, a, b, kind) {
			out = append(out, span{a, b, kind, ByModel})
		}
	}
	if o.covers(catPersonal) {
		var person []span
		for _, f := range out {
			if f.kind == "PERSON" {
				person = append(person, f)
			}
		}
		out = append(out, zhNameSpans(s, person)...)
	}
	return out
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

// delimiter says c may end a span of the model's and is no part of a
// name, a phone number, an address or an account: a space, or what is
// between cur().values in JSON or a CSV row. The model's span may start at the
// token before the value, and a phone number in {"phone":"+86 139 …"}
// came as `":"+86 139 …`, or in a CSV row as `,+81 90-…`, and was no
// number to the PHONE check: it went as written (#3591). A secret's
// edges are its own (a password may start with a quote).
func delimiter(c byte) bool { return isSpace(c) || strings.IndexByte(`"',;:`, c) >= 0 }

// modelTakes says v is masked as the model's kind: a secret as long as the
// rules ask of one, never an id a vendor or a tool made (req_…, toolu_…,
// call_…), which the agent and the vendor match against another; a name
// of two letters at least, and never a snake_case word. The model took
// Codex's sequential_cutoff for a name, and a value the vendor checks
// against its own list went as a placeholder: 400 on every request until
// the local model was turned off (#3144). Such a word is a protocol's or a
// program's, wherever it is: a setting, a tool's argument, code.
func modelTakes(kind, v string) bool {
	switch kind {
	case "SECRET":
		return len(v) >= 8 && !madeID(v) && !namesThing(v)
	case "PERSON":
		return utf8.RuneCountInString(v) >= 2 && strings.IndexFunc(v, unicode.IsLetter) >= 0 && !snakeWord(v)
	case "ACCOUNT":
		return !madeID(v)
	case "EMAIL":
		// as the rule's: a file's name (icon@2x.png) or an example's is no
		// address, nor a host's name with no @ (eu.stg.acme.io)
		return strings.Contains(v, "@") && realEmail(v)
	}
	return true
}

// snakeWord says v is ASCII letters and digits joined by underscores
// (sequential_cutoff, list_threads, mcp__codex_app).
func snakeWord(v string) bool {
	if !strings.Contains(v, "_") || strings.Trim(v, "_") == "" {
		return false
	}
	for _, c := range v {
		if !(c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

// namesThing says v, which the model took for a secret, names a thing
// rather than unlocking one: a UUID (a session's, a turn's, a request's;
// window_id's has a :0 after it), a digest with its algorithm's name
// (sha256 9b74…), a file's path. The model takes all three for secrets;
// Codex's turn metadata went as {{SECRET_…}} in each id (#1977). A key or
// a password in a field named for one is still the rules' (secretNames).
func namesThing(v string) bool {
	if u, n, ok := strings.Cut(v, ":"); ok && n != "" && strings.Trim(n, digits) == "" {
		v = u
	}
	if uuidRe.MatchString(v) || digestRe.MatchString(v) || slugRe.MatchString(v) || fileNameRe.MatchString(v) || modelName(v) {
		return true
	}
	return !strings.ContainsAny(v, " \t\n") && (strings.HasPrefix(v, "/") || strings.HasPrefix(v, "~/") ||
		strings.HasPrefix(v, "./") || strings.HasPrefix(v, "../") || len(v) > 3 && v[1] == ':' && v[2] == '\\')
}

// modelName says v is a model's or a toolchain's name: words in lower
// case joined by dashes, one of them a size (70b, 8x7b, 32k) or a date
// (20241022, 2026-09-01). The model took groqAPIModel = "llama3-70b-8192"
// and claudeAPIModel's claude-3-5-sonnet-20241022 for secrets (10-26).
// A key is written in neither case nor shape.
func modelName(v string) bool {
	if !dashedRe.MatchString(v) {
		return false
	}
	if dateIn.MatchString(v) {
		return true
	}
	for _, p := range strings.Split(v, "-") {
		if sizePartRe.MatchString(p) {
			return true
		}
	}
	return false
}

var (
	dashedRe   = regexp.MustCompile(`^[a-z][a-z0-9.]*(?:-[a-z0-9.]+)+$`)
	sizePartRe = regexp.MustCompile(`^(?:\d+x)?\d+(?:\.\d+)?[bkm]$|^20\d{6}$`)
	dateIn     = regexp.MustCompile(`(?:^|-)20\d\d-[01]\d-[0-3]\d(?:-|$)`)
)

var (
	uuidRe = regexp.MustCompile(`^(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	// a model's, a repo's or a package's name (qwen/qwen3-14b, acme/web)
	slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._@-]*(?:/[a-z0-9._@-]+)+$`)
	// a file's name in lower case (make-icons.sh, run_all.py)
	fileNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.[a-z][a-z0-9]{0,4}$`)
	digestRe   = regexp.MustCompile(`^(?i)(?:md5|sha-?(?:1|224|256|384|512)|blake2b?|blake3)[ :=-]+[0-9a-f]{32,128}$`)
)

// madeID says v is an id of the shape vendors and tools give theirs: a
// short lower-case prefix, an underscore, then letters and digits
// (req_011CS…, toolu_01A…, call_x9…, msg_…), or more words and a nanoid's
// - and _ (req_gateway_7c41…, tb_Ra4Kp9-ZqT2_…). Stripe's keys have that
// shape too (sk_live_…, rk_test_…): one is no id.
func madeID(v string) bool {
	p, rest, ok := strings.Cut(v, "_")
	if !ok || len(p) < 2 || len(p) > 8 || len(rest) < 8 {
		return false
	}
	for _, c := range p {
		if c < 'a' || c > 'z' {
			return false
		}
	}
	plain := true
	for _, c := range rest {
		if c == '_' || c == '-' {
			plain = false
		} else if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return plain || !keyHeads[p]
}

// keyHeads are the prefixes of keys written as an id is (sk_live_…,
// whsec_…, shpat_…).
var keyHeads = map[string]bool{"sk": true, "rk": true, "pk": true, "whsec": true, "shpat": true, "shpss": true, "xoxb": true, "xoxp": true}

// withModel is o with what o.Model finds in texts, the texts that may be
// masked: each once, the short ones left out.
func withModel(o Options, texts []string) Options {
	if o.Model == nil || !o.Secrets && !o.Personal {
		return o
	}
	var ask []string
	seen := map[string]bool{}
	for _, t := range texts {
		if len(t) >= 3 && !seen[t] {
			seen[t] = true
			ask = append(ask, t)
		}
	}
	if len(ask) == 0 {
		return o
	}
	got := o.Model(ask)
	o.found = make(map[string][]Found, len(ask))
	for i, t := range ask {
		if i < len(got) && len(got[i]) > 0 {
			o.found[t] = got[i]
		}
	}
	return o
}

// modelFits says the model's value at s[a:b] is what its kind says by
// where it is, as modelTakes does by what it is. Run on what agents send
// (3 MB of Claude Code's requests, 10-25), the model masked ~1,800
// cur().values where the rules masked 17, most of them wrongly: the count in
// each turn's <total_tokens>14983666 tokens left</total_tokens> as an
// account, a run's id as a phone, "Claude" and "Opus 5.5" in the system
// prompt as people, /Users/yetone's folder as a person, the tail of
// toolu_01… and req_011C… as a name or a secret, a grep pattern as a
// secret. Each goes as written now:
//   - a piece cut out of a longer word, whatever its kind;
//   - a name with a digit, a slash, an @ or a file's dot in it, all in
//     lower case (magpie, claude-in-chrome), a path's part, or an
//     assistant's or a model's own (Claude, Codex, Haiku 4.5);
//   - an account that is a commit's hash, a version, or a number with
//     nothing before it to say it is an account's; a phone number that is
//     digits only with nothing to say it is one, and no 0 or + to start,
//     or a Unix time whatever is before it;
//   - a secret that is a pattern's words, a|b|c, holds a UUID (a session's
//     file) or is a piece of JSON;
//   - an account or a phone number that is a size (1624x1487), drawing
//     data (an SVG path's M16 0H44…) or a diff's index line; a phone with
//     fewer than 7 digits, an address with no letter.
//
// Run on 22 more Claude Code sessions after a reporter on X found "95%"
// of the model's finds wrong (10-26), it still took 69 cur().values the rules
// didn't, ~55 of them wrongly, and these go as written now too:
//   - a decimal (a metric's 104.21875033916251) or "run 48213097715" as a
//     phone;
//   - as a secret: a value right after an id's name (with ID: kq3m8zx2t,
//     <task-id>…, "backgroundTaskId":"…"), a model's or a repo's name
//     (qwen/qwen3-14b), a file's (make-icons.sh), a grep's regexp
//     (a\b\|b), a time in words (release about 17:05Z), and a hex run
//     whose key cue is further back than "key:" or "token is" (env -u
//     GH_TOKEN gh run view 48213097715);
//   - a path as an address, a host's name with no @ as an email;
//   - as a name, an acronym (CI), a product in camel case (CodeRabbit) and
//     a word the text also has as a host's name (Greptile, app.greptile.com).
//
// A name's words each start with a capital, but for the particles names
// have (van, de, bin): "local LLM", "User yetone" and claudeKeychain are
// a program's or a log's words.
func modelFits(s string, a, b int, kind string) bool {
	if a > 0 && wordByte(s[a-1]) && wordByte(s[a]) || b < len(s) && wordByte(s[b-1]) && wordByte(s[b]) {
		return false
	}
	v := s[a:b]
	switch kind {
	case "PERSON":
		return personFits(s, a, b, v)
	case "ACCOUNT":
		if hexRe.MatchString(v) && strings.ContainsAny(v, "abcdef") || versionRe.MatchString(v) || !numberLike(v) {
			return false
		}
		return strings.Trim(v, digits) != "" || cued(s, a, accountCues)
	case "PHONE":
		if !numberLike(v) || countDigits(v) < 7 || epochNumber(v) || decimalRe.MatchString(v) || unicode.IsLetter(rune(v[0])) {
			return false
		}
		return strings.Trim(v, digits) != "" || v[0] == '0' || cued(s, a, phoneCues)
	case "ADDRESS":
		// a path is no address (-Users-x-projects-a/2b1a….jsonl); a Chinese
		// one has no spaces, a Latin one has them
		if isASCII(v) && !strings.ContainsAny(v, " \t\n") && strings.ContainsAny(v, `/\`) {
			return false
		}
		return strings.IndexFunc(v, unicode.IsLetter) >= 0
	case "SECRET":
		if !wordByte(v[0]) || patternWords(v) || regexpLike(v) || idAfter(s, a) || strings.ContainsRune(v, ' ') && clockIn.MatchString(v) || uuidIn.MatchString(v) || strings.Contains(v, `": `) || strings.Contains(v, `", "`) || linkRe.MatchString(v) {
			return false
		}
		// a piece of a longer base64 run (an image, a signature) is cut
		// from it at a '+' or '/'
		if a > 1 && (s[a-1] == '+' || s[a-1] == '/') && wordByte(s[a-2]) || b+1 < len(s) && (s[b] == '+' || s[b] == '/') && wordByte(s[b+1]) {
			return false
		}
		// a bare hex run is a hash or an id unless something calls it a key;
		// one with words after it is a hash in a tool's output
		if f := strings.Fields(v); len(f) > 1 && hexRe.MatchString(f[0]) || modCacheRe.MatchString(v) {
			return false
		}
		return !hexRe.MatchString(v) || secretCued(s, a)
	case "EMAIL":
		// a URL's user:password@host is no address, as for the rule's (#3538)
		return wordByte(v[0]) && !modCacheRe.MatchString(v) && !inUserinfo(s, a)
	}
	return true
}

func wordByte(c byte) bool {
	return c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
}

func personFits(s string, a, b int, v string) bool {
	if strings.ContainsAny(v, "0123456789/\\@<>|=_") || strings.IndexFunc(v, unicode.IsUpper) < 0 && isASCII(v) {
		return false
	}
	// a file's name: LESSONS.md, a dot with a letter right after it
	for i := 0; i+1 < len(v); i++ {
		if v[i] == '.' && (v[i+1] >= 'a' && v[i+1] <= 'z' || v[i+1] >= 'A' && v[i+1] <= 'Z') {
			return false
		}
	}
	// a path's part: /Users/yetone, ~/.orca/
	if a > 0 && (s[a-1] == '/' || s[a-1] == '\\' || s[a-1] == '.' && a > 1 && (s[a-2] == '/' || s[a-2] == '\\')) || b < len(s) && (s[b] == '/' || s[b] == '\\') {
		return false
	}
	if strings.ContainsRune(v, ':') {
		return false
	}
	// an acronym (CI, API), a product's name in camel case (CodeRabbit,
	// OpenAI) and a site's (Greptile beside app.greptile.com) are no one's
	if w := strings.Fields(v); len(w) == 1 && (strings.Trim(v, "ABCDEFGHIJKLMNOPQRSTUVWXYZ") == "" || camelProduct(v) || hostIn(s, v)) {
		return false
	}
	for i, w := range strings.Fields(v) {
		if c := w[0]; c >= 'a' && c <= 'z' && (i == 0 || !nameParticles[w]) {
			return false
		}
		if assistantNames[strings.ToLower(w)] {
			return false
		}
	}
	return true
}

// camelProduct says v has a capital after three lower-case letters at
// least, as products are written (CodeRabbit, OpenAI) and names are not
// (McDonald, DeAndre, MacKenzie).
func camelProduct(v string) bool {
	lower := 0
	for i := 0; i < len(v); i++ {
		switch c := v[i]; {
		case c >= 'a' && c <= 'z':
			lower++
		case c >= 'A' && c <= 'Z':
			if lower >= 3 {
				return true
			}
			lower = 0
		default:
			lower = 0
		}
	}
	return false
}

// hostIn says s has the word w, in any case, as a host's name: a domain's
// first part or one after a dot (greptile.com, app.greptile.com), never
// an address's (matt.lee@…).
func hostIn(s, w string) bool {
	ls, lw := strings.ToLower(s), strings.ToLower(w)
	for i := 0; ; {
		k := strings.Index(ls[i:], lw+".")
		if k < 0 {
			return false
		}
		k += i
		i = k + 1
		if k > 0 && !strings.ContainsRune("/.@ \t\n\"'(`", rune(ls[k-1])) {
			continue
		}
		if m := hostTail.FindString(ls[k+len(lw):]); m != "" {
			return true
		}
	}
}

// hostTail is a domain's rest after its first part: .com, .greptile.com,
// ending where the host does (not at an @ or more of a word)
var hostTail = regexp.MustCompile(`^(?:\.[a-z0-9-]+)*\.[a-z]{2,6}(?:[/:\s"'),\x60]|$)`)

// nameParticles are the words in lower case a name may have between its
// others: Ludwig van Beethoven, Ibn al Haytham.
var nameParticles = map[string]bool{
	"van": true, "von": true, "der": true, "den": true, "de": true, "da": true, "del": true, "della": true,
	"di": true, "du": true, "la": true, "le": true, "bin": true, "binti": true, "al": true, "el": true,
	"y": true, "dos": true, "das": true, "do": true, "ter": true, "ten": true, "zu": true,
}

// numberLike says v is written as a number is: digits, and the spaces,
// dashes, dots, brackets and + that group them, with a letter or two at
// most (an IBAN's, ext.). A size is no number (1624x1487).
func numberLike(v string) bool {
	if sizeRe.MatchString(v) || strings.Contains(v, "..") {
		return false
	}
	letters := 0
	for _, c := range v {
		switch {
		case c >= '0' && c <= '9', strings.ContainsRune(" -.()+/", c):
		case unicode.IsLetter(c):
			letters++
		default:
			return false
		}
	}
	return letters <= 4 && countDigits(v)*2 > len(v)
}

// epochNumber says v is a Unix time, as a log or a tool's JSON has one:
// ten digits, or thirteen in milliseconds, and nothing else, starting with
// 1. The model took "timestamp": 1792903687 for a phone, with "tool_call"
// before it as the cue (#3577). No phone is written so: a North American
// number's area code starts with 2 to 9, and a Chinese mobile has eleven
// digits (the PHONE rule's).
func epochNumber(v string) bool {
	if len(v) != 10 && len(v) != 13 || v[0] != '1' {
		return false
	}
	return strings.Trim(v, digits) == ""
}

func countDigits(v string) int {
	n := 0
	for i := 0; i < len(v); i++ {
		if v[i] >= '0' && v[i] <= '9' {
			n++
		}
	}
	return n
}

func isASCII(v string) bool {
	for i := 0; i < len(v); i++ {
		if v[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

// assistantNames are what agents and models call themselves, in every
// system prompt: the model takes each for a person's name.
var assistantNames = map[string]bool{
	"claude": true, "chatgpt": true, "gpt": true, "codex": true, "gemini": true, "copilot": true,
	"grok": true, "kimi": true, "qwen": true, "deepseek": true, "cursor": true, "devin": true,
	"kiro": true, "opencode": true, "opus": true, "sonnet": true, "haiku": true, "fable": true,
	"glm": true, "doubao": true, "magpie": true, "jev": true,
}

var (
	hexRe     = regexp.MustCompile(`^[0-9a-f]{7,64}$`)
	decimalRe = regexp.MustCompile(`^\d+\.\d+$`)
	// a time of day in words the model took for a passphrase (release
	// about 17:05Z)
	clockIn   = regexp.MustCompile(`(?:^|\s)\d{1,2}:\d{2}(?::\d{2})?Z?(?:\s|$)`)
	versionRe = regexp.MustCompile(`^v?\d+(?:\.\d+)+$`)
	sizeRe    = regexp.MustCompile(`^\d+ ?[x×] ?\d+$`)
	uuidIn    = regexp.MustCompile(`(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	// a name in Go's module cache (d6426ecaaf0a28de@v31)
	modCacheRe = regexp.MustCompile(`^[0-9a-f]{16}@v\d+$`)
	// a link, or a host's name with a path (discord.gg/…)
	linkRe = regexp.MustCompile(`^(?:[a-z][a-z0-9+.-]*://|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/)`)
)

var (
	accountCues = []string{"account", "acct", "a/c", "iban", "routing", "sort code", "card", "账号", "帐号", "账户", "帐户", "卡号", "户名"}
	secretCues  = []string{"key", "token", "secret", "password", "passwd", "密钥", "密码", "令牌"}
	phoneCues   = []string{"phone", "tel", "mobile", "cell", "call", "whatsapp", "sms", "电话", "手机", "联系", "致电"}
)

// cued says one of cues is in the 40 bytes before at, in any case.
func cued(s string, at int, cues []string) bool {
	before := strings.ToLower(s[max(0, at-40):at])
	for _, c := range cues {
		if strings.Contains(before, c) {
			return true
		}
	}
	return false
}

// regexpLike says v is a regexp's: grep's \| between alternatives, or a
// \b word boundary (qwen3-max\b\|qwen/qwen3).
func regexpLike(v string) bool {
	return strings.Contains(v, `\|`) || strings.Contains(v, `\b`)
}

// idAfter says the value at s[a:] is right after the word id, as a
// tool's output names a task's or a job's (with ID: kq3m8zx2t, (ID:
// bv7n2wq5p), <task-id>…, "backgroundTaskId":"…", "org_id": "…"): an id
// is no secret.
func idAfter(s string, a int) bool {
	t := strings.TrimRight(s[max(0, a-24):a], " :=#(>\"'`")
	n := len(t)
	if n < 2 || !strings.EqualFold(t[n-2:], "id") {
		return false
	}
	return n == 2 || !unicode.IsLetter(rune(t[n-3])) || t[n-2] == 'I' && t[n-1] == 'd'
}

// secretCued says a hex run at s[at:] is called a key, a token or a
// password: one of secretCues is right before it, with the cue's own word
// and an is, a colon or an = between (api key: 9f2c…, token is 9f2c…). A
// cue further back is about something else: GH_TOKEN in "env -u GH_TOKEN
// gh run view 48213097715" is not the run's.
func secretCued(s string, at int) bool {
	before := strings.ToLower(s[max(0, at-40):at])
	for _, c := range secretCues {
		k := strings.LastIndex(before, c)
		if k < 0 {
			continue
		}
		gap := strings.TrimLeftFunc(before[k+len(c):], func(r rune) bool { return r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r) })
		words := strings.FieldsFunc(gap, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
		if len(words) == 0 || len(words) == 1 && (words[0] == "is" || words[0] == "was" || words[0] == "是" || words[0] == "为") {
			return true
		}
	}
	return false
}

// patternWords says v is three or more words joined by |, as a grep's or
// a regexp's alternatives are.
func patternWords(v string) bool {
	parts := strings.Split(v, "|")
	if len(parts) < 3 {
		return false
	}
	for _, p := range parts {
		if p == "" || strings.IndexFunc(p, unicode.IsLetter) < 0 || strings.Trim(p, alnum+"_.-") != "" {
			return false
		}
	}
	return true
}
