package redact

import (
	"bytes"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

// kept are the keys whose strings are left alone: ids, names and cur().kinds the
// vendor needs as they are, and what is sealed or encoded (a thinking
// block's signature, reasoning's encrypted content, an image's data). A
// tool is named by its name and, for an MCP tool, its server's: a
// Responses function_call's namespace, an mcp_call's server_label,
// Anthropic's mcp_tool_use server_name. Codex checks a namespace against
// ^[a-zA-Z0-9_-]+$, so one with a word masked in it was a 400 on every turn
// that replayed the call (#3143).
var kept = map[string]bool{
	"signature": true, "encrypted_content": true, "data": true, "thoughtSignature": true, "thought_signature": true,
	"model": true, "id": true, "tool_use_id": true, "call_id": true, "item_id": true, "type": true, "role": true,
	"name": true, "namespace": true, "server_label": true, "server_name": true, "previous_response_id": true, "prompt_cache_key": true, "media_type": true, "mime_type": true,
	"mimeType": true, "url": true, "image_url": true, "file_id": true, "reasoning_effort": true, "effort": true,
	"stop_reason": true, "finish_reason": true, "status": true, "object": true, "event": true,
}

func keep(key, s string) bool {
	return kept[key] || strings.HasPrefix(s, "data:")
}

// keepIn is keep for a request's string at path, with its ids kept too.
// In a tool call's arguments (args) the keys are the tool's, not the
// vendor's: a "signature", "name" or "user_id" there holds what the agent
// wrote, so only an encoded data: value is kept. In what the agent defines
// for the vendor to check (defs: its tools, their schemas and grammars, the
// output's schema, the request's settings) only a description is masked:
// the rest is read by the vendor as structure, and a word masked inside a
// Lark grammar's rule name ("pd" in update_hunk) left a grammar the vendor
// turned away with 400 "Invalid lark grammar" (#1911).
func keepIn(path, key, s string, args, defs []string) bool {
	if strings.HasPrefix(s, "data:") {
		return true
	}
	if under(path, args) {
		return false
	}
	if under(path, defs) {
		return key != "description"
	}
	return kept[key] || isID(key)
}

// isID says a key holds an identifier the vendor matches against another:
// a tool result's tool_call_id against its call's id, an approval's
// approval_request_id against its request. A vendor's ids are its own
// letters and digits, and GLM's call_ and 19 digits can read as a bank
// card number; masked on one side only, the two no longer match.
func isID(key string) bool {
	return key == "id" || key == "ids" || strings.HasSuffix(key, "_id") || strings.HasSuffix(key, "_ids") ||
		strings.HasSuffix(key, "Id") || strings.HasSuffix(key, "Ids")
}

// signatureKeys are the keys of what a vendor seals the content beside it
// with: Anthropic's thinking signature, Gemini's thought signature,
// Responses' encrypted reasoning.
var signatureKeys = []string{"signature", "thoughtSignature", "thought_signature", "encrypted_content"}

// scan finds three cur().kinds of objects in body. signed are those a vendor
// sealed with a signature: what is in them the vendor wrote and checks, so
// it goes back exactly as the vendor wrote it. args are a tool call's
// arguments (Anthropic's tool_use input, Gemini's functionCall args), whose
// keys are the tool's own; nothing in them counts as sealed. defs are what
// the agent defines for the vendor rather than says to the model
// (definitions).
func scan(body []byte) (signed, args, defs []string) {
	found := false
	for _, k := range append(signatureKeys, "tool_use", "functionCall", "function_call") {
		found = found || bytes.Contains(body, []byte(`"`+k+`"`))
	}
	for _, k := range defKeys {
		found = found || bytes.Contains(body, []byte(`"`+k+`"`))
	}
	if !found {
		return nil, nil, nil
	}
	var v any
	if json.Unmarshal(body, &v) != nil {
		return nil, nil, nil
	}
	defs = definitions(v)
	var visit func(path, key string, v any)
	visit = func(path, key string, v any) {
		switch x := v.(type) {
		case map[string]any:
			if sealed(x) {
				signed = append(signed, path)
				return
			}
			t, _ := x["type"].(string)
			for k, c := range x {
				if k == "input" && (t == "tool_use" || t == "server_tool_use") ||
					k == "args" && (key == "functionCall" || key == "function_call") {
					args = append(args, join(path, k))
					continue
				}
				visit(join(path, k), k, c)
			}
		case []any:
			for i, c := range x {
				visit(join(path, strconv.Itoa(i)), key, c)
			}
		}
	}
	visit("", "", v)
	return signed, args, defs
}

// defKeys are the request's own keys whose cur().values the agent defines for the
// vendor to read as structure, in every protocol an agent sends: the tools
// (Anthropic, Chat Completions, Responses, Gemini) and the choice among
// them, the output's schema (Chat's response_format, Responses' text,
// Anthropic's output_format and output_config, Gemini's generationConfig),
// Responses' reasoning and include, how the reply streams
// (stream_options, whose reasoning_summary_delivery the vendor checks is
// "sequential" or "sequential_cutoff", #3144), and the client's ids that
// no model reads (client_metadata: Codex's installation, session, thread,
// turn and window, as a JSON string in x-codex-turn-metadata, which the
// vendor and magpie's own sessions match a turn by).
var defKeys = []string{
	"tools", "tool_choice", "functions", "function_call", "toolConfig", "tool_config",
	"response_format", "text", "reasoning", "include", "output_format", "output_config",
	"generationConfig", "generation_config", "stream_options", "client_metadata",
}

// defItems are the Responses input items that carry tools: Responses
// Lite's additional_tools, which Codex sends its tools in in place of the
// request's tools, and a tool search's output, the tools it found.
var defItems = map[string]bool{"additional_tools": true, "tool_search_output": true}

// definitions are the paths in a request v at which the agent defines
// rather than says: the request's own defKeys, and the tools of its
// defItems. Only where they sit in the protocol counts: a "tools" or
// "text" key deeper in, in a message or a tool call's arguments, is what
// the agent or the model wrote.
func definitions(v any) []string {
	m, _ := v.(map[string]any)
	if m == nil {
		return nil
	}
	var defs []string
	for _, k := range defKeys {
		if _, ok := m[k]; !ok {
			continue
		}
		if k == "text" {
			// Responses' text is the output's settings; a prompt's text
			// (a completion's, a Gemini contents part's) is a string
			if _, ok := m[k].(map[string]any); !ok {
				continue
			}
		}
		defs = append(defs, k)
	}
	items, _ := m["input"].([]any)
	for i, it := range items {
		if im, _ := it.(map[string]any); im != nil {
			if t, _ := im["type"].(string); defItems[t] {
				defs = append(defs, join(join("input", strconv.Itoa(i)), "tools"))
			}
		}
	}
	return defs
}

// sealed says x is a block the vendor signed: a part with Gemini's thought
// signature, or a thinking or reasoning block with Anthropic's signature or
// Responses' encrypted content. Another object with a key of that name
// (a text block, the request itself) holds the agent's words.
func sealed(x map[string]any) bool {
	t, _ := x["type"].(string)
	for _, k := range signatureKeys {
		if s, _ := x[k].(string); s == "" {
			continue
		}
		if k == "thoughtSignature" || k == "thought_signature" ||
			t == "thinking" || t == "reasoning" || strings.HasPrefix(t, "reasoning.") {
			return true
		}
	}
	return false
}

// under says path is in one of the objects at roots.
func under(path string, roots []string) bool {
	for _, r := range roots {
		if r == "" || path == r || strings.HasPrefix(path, r+".") {
			return true
		}
	}
	return false
}

// walk calls fn with every string value in the JSON document b — its path
// (keys and indexes joined by dots) and the key it is under — and writes
// what fn returns in its place. Everything else is kept byte for byte, and
// b comes back as it is if nothing changed; if it isn't JSON, ok is false.
func walk(b []byte, fn func(path, key, s string) string) (out []byte, ok bool) {
	w := walker{in: b, fn: fn}
	i, good := w.value(w.ws(0), "", "")
	if !good || w.ws(i) != len(b) {
		return b, false
	}
	if w.last == 0 {
		return b, true
	}
	w.out.Write(b[w.last:])
	out = w.out.Bytes()
	if cap(out)-len(out) > len(out)/8 {
		// placeholders longer than what they stand for grew it past the
		// room made for it: held as it is, a doubled buffer (#3383)
		out = bytes.Clone(out)
	}
	return out, true
}

type walker struct {
	in   []byte
	out  bytes.Buffer
	last int
	fn   func(path, key, s string) string
}

func (w *walker) ws(i int) int {
	for i < len(w.in) && (w.in[i] == ' ' || w.in[i] == '\t' || w.in[i] == '\n' || w.in[i] == '\r') {
		i++
	}
	return i
}

func join(path, k string) string {
	if path == "" {
		return k
	}
	return path + "." + k
}

// str is the end of the string literal that starts at i.
func (w *walker) str(i int) (end int, escaped, ok bool) {
	for j := i + 1; j < len(w.in); j++ {
		switch w.in[j] {
		case '\\':
			escaped = true
			j++
		case '"':
			return j + 1, escaped, true
		}
	}
	return 0, false, false
}

func (w *walker) value(i int, path, key string) (int, bool) {
	if i >= len(w.in) {
		return i, false
	}
	switch c := w.in[i]; c {
	case '{':
		i = w.ws(i + 1)
		if i < len(w.in) && w.in[i] == '}' {
			return i + 1, true
		}
		for {
			if i >= len(w.in) || w.in[i] != '"' {
				return i, false
			}
			end, esc, ok := w.str(i)
			if !ok {
				return i, false
			}
			k := string(w.in[i+1 : end-1])
			if esc {
				if json.Unmarshal(w.in[i:end], &k) != nil {
					return i, false
				}
			}
			i = w.ws(end)
			if i >= len(w.in) || w.in[i] != ':' {
				return i, false
			}
			if i, ok = w.value(w.ws(i+1), join(path, k), k); !ok {
				return i, false
			}
			i = w.ws(i)
			if i < len(w.in) && w.in[i] == ',' {
				i = w.ws(i + 1)
				continue
			}
			if i < len(w.in) && w.in[i] == '}' {
				return i + 1, true
			}
			return i, false
		}
	case '[':
		i = w.ws(i + 1)
		if i < len(w.in) && w.in[i] == ']' {
			return i + 1, true
		}
		for n := 0; ; n++ {
			var ok bool
			// an array's strings are under the key the array is
			if i, ok = w.value(i, join(path, strconv.Itoa(n)), key); !ok {
				return i, false
			}
			i = w.ws(i)
			if i < len(w.in) && w.in[i] == ',' {
				i = w.ws(i + 1)
				continue
			}
			if i < len(w.in) && w.in[i] == ']' {
				return i + 1, true
			}
			return i, false
		}
	case '"':
		end, esc, ok := w.str(i)
		if !ok {
			return i, false
		}
		s := string(w.in[i+1 : end-1])
		if esc && json.Unmarshal(w.in[i:end], &s) != nil {
			return i, false
		}
		if t := w.fn(path, key, s); t != s {
			if w.out.Cap() == 0 {
				// the masked body is about the body's size: grown by
				// doubling, its buffer was up to twice that, held as the
				// request's body while it streams (#3383)
				w.out.Grow(len(w.in) + len(w.in)/16 + 64)
			}
			w.out.Write(w.in[w.last:i])
			w.out.WriteByte('"')
			w.out.WriteString(jsonEscape(t))
			w.out.WriteByte('"')
			w.last = end
		}
		return end, true
	default:
		j := i
		for j < len(w.in) && !strings.ContainsRune(",]} \t\r\n", rune(w.in[j])) {
			j++
		}
		if j == i {
			return i, false
		}
		return j, true
	}
}

// jsonEscape is s as it goes between the quotes of a JSON string.
func jsonEscape(s string) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(s)
	out := b.Bytes()
	return string(out[1 : len(out)-2]) // the quotes and the newline
}

// MaskJSON masks the strings of a request body, and says how many cur().values
// it masked. A body that isn't JSON is masked as text.
//
// What a vendor sealed with a signature (a thinking block, Gemini's
// thoughts, Responses' encrypted reasoning) is checked by the vendor
// against the text it wrote, so it goes back as written: the cur().values
// masked elsewhere in the request become their placeholders again, which
// is what the vendor wrote where the agent reads the value (Restore), as
// do the secrets masked before (knownSpans), and nothing else in it is
// touched. Masked by the rules instead, a value the
// vendor wrote as a placeholder in other words around it ("the password
// is {{SECRET_…}}") went back as the value itself, and what the vendor
// wrote of its own that looks like an email or a phone number went as a
// placeholder: either way the text no longer matched its signature, and
// Anthropic answers 400 "Invalid `signature` in `thinking` block".
func MaskJSON(body []byte, o Options) ([]byte, int) {
	o.sent = true
	signed, args, defs := scan(body)
	masked := func(path, key, s string) bool {
		return !keepIn(path, key, s, args, defs) && (signed == nil || !under(path, signed))
	}
	if o.Model != nil {
		// the model is asked once, for all of the request's texts
		var texts []string
		if _, ok := walk(body, func(path, key, s string) string {
			if masked(path, key, s) {
				texts = append(texts, s)
			}
			return s
		}); ok {
			o = withModel(o, texts)
		}
	}
	total := 0
	put := func(kind, v string) string {
		return o.put()(kind, v)
	}
	out, ok := walk(body, func(path, key, s string) string {
		if !masked(path, key, s) {
			return s
		}
		t, n := mask(s, o, put, asJSON(key, ""))
		total += n
		return t
	})
	if !ok {
		t, n := Mask(string(body), o)
		return []byte(t), n
	}
	// Signed text is left unchanged. A hit there is rejected before send.
	return out, total
}

// replacerOf swaps each value of pairs (value, placeholder, …) for its
// placeholder, the longest value first where two start at the same place.
func replacerOf(pairs []string) *strings.Replacer {
	type pair struct{ v, p string }
	var ps []pair
	have := map[string]bool{}
	for i := 0; i+1 < len(pairs); i += 2 {
		if !have[pairs[i]] {
			have[pairs[i]] = true
			ps = append(ps, pair{pairs[i], pairs[i+1]})
		}
	}
	sort.SliceStable(ps, func(i, j int) bool { return len(ps[i].v) > len(ps[j].v) })
	args := make([]string, 0, 2*len(ps))
	for _, p := range ps {
		args = append(args, p.v, p.p)
	}
	return strings.NewReplacer(args...)
}

// asJSON says a string under key holds JSON text of its own, so a value
// put back in it goes in escaped: a tool call's arguments, as a whole or
// streamed in pieces.
func asJSON(key, eventType string) bool {
	return key == "arguments" || key == "partial_json" || key == "delta" && strings.Contains(eventType, "arguments")
}

// RestoreJSON puts the cur().values back in a response body.
func RestoreJSON(body []byte) []byte { return restoreJSON(body, nil) }

// restoreJSON is RestoreJSON, counting in put as restore does.
func restoreJSON(body []byte, put map[string]int) []byte {
	if !bytes.Contains(body, []byte("{{")) && !hasShapes(body) {
		return body
	}
	typ := ""
	out, ok := walk(body, func(path, key, s string) string {
		if path == "type" {
			typ = s
		}
		return restore(s, asJSON(key, typ), put)
	})
	if !ok {
		return []byte(restore(string(body), false, put))
	}
	return out
}
