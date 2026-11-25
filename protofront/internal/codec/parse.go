// Package codec implements Magpie-style star-topology inbound parsing, target-specific
// wire building, and symmetric egress transcoding for all 4+1 protocols.
package codec

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"github.com/dofastted/kin-gateway/protofront/internal/ir"
)

// ParseOptions supplies route-level metadata (e.g., Gemini URL model and :streamGenerateContent).
type ParseOptions struct {
	RouteModel  string
	RouteStream *bool
}

// Parse converts any supported inbound protocol body into the canonical *ir.Request.
func Parse(proto ir.Protocol, raw map[string]any, opts ParseOptions) (*ir.Request, error) {
	if raw == nil {
		return nil, badRequest("body", "must be a JSON object", "invalid_request")
	}
	switch proto {
	case ir.ProtoAnthropic:
		return parseAnthropic(raw)
	case ir.ProtoChat:
		return parseChat(raw)
	case ir.ProtoCompletions:
		return parseCompletions(raw)
	case ir.ProtoResponses:
		return parseResponses(raw)
	case ir.ProtoGemini:
		return parseGemini(raw, opts)
	default:
		return nil, badRequest("protocol", fmt.Sprintf("unsupported protocol %q", proto), "unsupported_protocol")
	}
}

func badRequest(param, msg, code string) *ir.ProtocolError {
	return &ir.ProtocolError{Status: 400, Code: code, Type: "invalid_request_error", Param: param, Message: msg}
}

func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func asBool(v any) (bool, bool) {
	b, ok := v.(bool)
	return b, ok
}

func asInt(v any) (int, bool) {
	switch x := v.(type) {
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) || math.Trunc(x) != x {
			return 0, false
		}
		return int(x), true
	case int:
		return x, true
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return int(i), true
		}
	}
	return 0, false
}

func asFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return 0, false
		}
		return x, true
	case int:
		return float64(x), true
	case json.Number:
		if f, err := x.Float64(); err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
			return f, true
		}
	}
	return 0, false
}

func mustRaw(v any) json.RawMessage {
	if v == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

func parseCacheControl(v any) *ir.CacheControl {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	cc := &ir.CacheControl{
		Type:  asString(m["type"]),
		TTL:   strings.TrimSpace(asString(m["ttl"])),
		Scope: strings.TrimSpace(asString(m["scope"])),
	}
	if cc.Type == "" {
		cc.Type = "ephemeral"
	}
	return cc
}

func parseDataURI(uri string) (mediaType, data string, ok bool) {
	if !strings.HasPrefix(uri, "data:") {
		return "", "", false
	}
	rest := strings.TrimPrefix(uri, "data:")
	comma := strings.IndexByte(rest, ',')
	if comma < 0 {
		return "", "", false
	}
	meta := rest[:comma]
	payload := rest[comma+1:]
	if !strings.Contains(meta, ";base64") {
		return "", "", false
	}
	mt := strings.TrimSpace(strings.Split(meta, ";")[0])
	if mt == "" {
		mt = "image/png"
	}
	return mt, payload, true
}

func parseStop(v any) []string {
	switch x := v.(type) {
	case string:
		if x != "" {
			return []string{x}
		}
	case []any:
		var out []string
		for _, item := range x {
			if s, ok := item.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func collectUnrepresentable(req *ir.Request, raw map[string]any) {
	if n, ok := asInt(raw["n"]); ok && n > 1 {
		req.CandidateCount = &n
		req.Unrepresentable = append(req.Unrepresentable, "n")
	}
	for _, k := range []string{"seed", "logprobs", "top_logprobs", "logit_bias", "presence_penalty", "frequency_penalty", "audio", "prediction"} {
		if v, exists := raw[k]; exists && v != nil {
			req.Unrepresentable = append(req.Unrepresentable, k)
		}
	}
}

func isEmptyEffort(v any) bool {
	if v == nil {
		return true
	}
	s, ok := v.(string)
	return ok && strings.TrimSpace(s) == ""
}

// --- 1. Anthropic Messages Parser ---

var providerHistoryBlockTypes = map[string]bool{
	"server_tool_use":                        true,
	"web_search_tool_result":                 true,
	"web_fetch_tool_result":                  true,
	"code_execution_tool_result":             true,
	"bash_code_execution_tool_result":        true,
	"text_editor_code_execution_tool_result": true,
	"tool_search_tool_result":                true,
	"container_upload":                       true,
	"advisor_tool_result":                    true,
}

func parseAnthropic(raw map[string]any) (*ir.Request, error) {
	req := &ir.Request{
		InboundProtocol: ir.ProtoAnthropic,
		Model:           strings.TrimSpace(asString(raw["model"])),
		RawExtra:        raw,
	}
	if b, ok := asBool(raw["stream"]); ok {
		req.Stream = b
	}
	if mt, ok := asInt(raw["max_tokens"]); ok {
		req.MaxTokens = &mt
	}
	if f, ok := asFloat(raw["temperature"]); ok {
		req.Temperature = &f
	}
	if f, ok := asFloat(raw["top_p"]); ok {
		req.TopP = &f
	}
	if k, ok := asInt(raw["top_k"]); ok {
		req.TopK = &k
	}
	req.Stop = parseStop(raw["stop_sequences"])
	req.Speed = strings.TrimSpace(asString(raw["speed"]))
	req.ServiceTier = strings.TrimSpace(asString(raw["service_tier"]))
	if raw["cache_control"] != nil {
		req.AutomaticCacheControl = parseCacheControl(raw["cache_control"])
	}
	if meta, ok := raw["metadata"].(map[string]any); ok {
		req.Metadata = meta
	}
	if raw["context_management"] != nil {
		req.ContextManagement = mustRaw(raw["context_management"])
	}
	if raw["safeguards"] != nil {
		req.Safeguards = mustRaw(raw["safeguards"])
	}
	if raw["thread"] != nil {
		req.Thread = mustRaw(raw["thread"])
	}
	collectUnrepresentable(req, raw)

	// System blocks
	switch sys := raw["system"].(type) {
	case string:
		if sys != "" {
			req.System = append(req.System, ir.SystemBlock{Text: sys})
		}
	case []any:
		for _, item := range sys {
			switch b := item.(type) {
			case string:
				req.System = append(req.System, ir.SystemBlock{Text: b})
			case map[string]any:
				req.System = append(req.System, ir.SystemBlock{
					Text:         asString(b["text"]),
					CacheControl: parseCacheControl(b["cache_control"]),
				})
			}
		}
	case map[string]any:
		req.System = append(req.System, ir.SystemBlock{
			Text:         asString(sys["text"]),
			CacheControl: parseCacheControl(sys["cache_control"]),
		})
	}

	// Thinking & output_config
	var effort string
	if oc, ok := raw["output_config"].(map[string]any); ok {
		cleanOC := map[string]any{}
		for k, v := range oc {
			if k == "effort" && isEmptyEffort(v) {
				continue
			}
			cleanOC[k] = v
		}
		if len(cleanOC) > 0 {
			req.OutputConfig = mustRaw(cleanOC)
		}
		effort = strings.TrimSpace(asString(cleanOC["effort"]))
		if fmtMap, ok := cleanOC["format"].(map[string]any); ok {
			req.Format = &ir.OutputFormat{
				Type:        asString(fmtMap["type"]),
				Name:        asString(fmtMap["name"]),
				Description: asString(fmtMap["description"]),
				Schema:      mustRaw(fmtMap["schema"]),
			}
		}
	}
	if th, ok := raw["thinking"].(map[string]any); ok {
		r := &ir.Reasoning{
			Mode:    strings.ToLower(strings.TrimSpace(asString(th["type"]))),
			Display: strings.TrimSpace(asString(th["display"])),
			Effort:  effort,
		}
		if b, ok := asInt(th["budget_tokens"]); ok {
			r.Budget = &b
		}
		req.Reasoning = r
	} else if effort != "" {
		req.Reasoning = &ir.Reasoning{Effort: effort}
	}

	// Tools
	if tools, ok := raw["tools"].([]any); ok {
		for _, item := range tools {
			tm, ok := item.(map[string]any)
			if !ok {
				continue
			}
			ttype := asString(tm["type"])
			t := ir.Tool{
				Type:         ttype,
				Name:         asString(tm["name"]),
				Description:  asString(tm["description"]),
				CacheControl: parseCacheControl(tm["cache_control"]),
				Raw:          mustRaw(tm),
			}
			if b, ok := asBool(tm["strict"]); ok {
				t.Strict = &b
			}
			if b, ok := asBool(tm["eager_input_streaming"]); ok {
				t.EagerInputStreaming = &b
			}
			if b, ok := asBool(tm["defer_loading"]); ok {
				t.DeferLoading = &b
			}
			switch {
			case ttype == "advisor_20260301":
				t.Kind = "advisor"
			case ttype != "" && ttype != "custom":
				t.Kind = "provider"
			default:
				t.Kind = "custom"
				t.Schema = mustRaw(tm["input_schema"])
			}
			req.Tools = append(req.Tools, t)
		}
	}

	// ToolChoice
	if tc, ok := raw["tool_choice"].(map[string]any); ok {
		choice := &ir.ToolChoice{
			Mode: asString(tc["type"]),
			Name: asString(tc["name"]),
			Raw:  mustRaw(tc),
		}
		if b, ok := asBool(tc["disable_parallel_tool_use"]); ok {
			choice.DisableParallelToolUse = &b
			p := !b
			req.ParallelToolCalls = &p
		}
		req.ToolChoice = choice
	}

	// Messages
	if msgs, ok := raw["messages"].([]any); ok {
		for _, item := range msgs {
			mm, ok := item.(map[string]any)
			if !ok {
				continue
			}
			msg := ir.Message{
				Role:    asString(mm["role"]),
				ClearAt: mustRaw(mm["clear_at"]),
			}
			if oc, ok := mm["output_config"].(map[string]any); ok {
				cleanOC := map[string]any{}
				for k, v := range oc {
					if k == "effort" && isEmptyEffort(v) {
						continue
					}
					cleanOC[k] = v
				}
				if len(cleanOC) > 0 {
					msg.OutputConfig = mustRaw(cleanOC)
				}
			}
			switch c := mm["content"].(type) {
			case string:
				if c != "" {
					msg.Parts = append(msg.Parts, ir.Part{Kind: ir.PartText, Text: c})
				}
			case []any:
				for _, b := range c {
					part, ok := parseAnthropicBlock(b)
					if ok {
						msg.Parts = append(msg.Parts, part)
					}
				}
			}
			req.Messages = append(req.Messages, msg)
		}
	}
	return req, nil
}

func parseAnthropicBlock(b any) (ir.Part, bool) {
	if s, ok := b.(string); ok {
		return ir.Part{Kind: ir.PartText, Text: s}, true
	}
	bm, ok := b.(map[string]any)
	if !ok {
		return ir.Part{}, false
	}
	cc := parseCacheControl(bm["cache_control"])
	typ := asString(bm["type"])
	switch typ {
	case "text":
		return ir.Part{Kind: ir.PartText, Text: asString(bm["text"]), CacheControl: cc}, true
	case "thinking":
		return ir.Part{Kind: ir.PartThinking, Text: asString(bm["thinking"]), Signature: asString(bm["signature"])}, true
	case "redacted_thinking":
		return ir.Part{Kind: ir.PartRedactedThinking, Data: asString(bm["data"])}, true
	case "image":
		p := ir.Part{Kind: ir.PartImage, CacheControl: cc}
		if src, ok := bm["source"].(map[string]any); ok {
			p.MediaType = asString(src["media_type"])
			p.Data = asString(src["data"])
			p.URL = asString(src["url"])
		}
		return p, true
	case "document":
		p := ir.Part{
			Kind:         ir.PartDocument,
			Title:        asString(bm["title"]),
			Context:      asString(bm["context"]),
			Citations:    mustRaw(bm["citations"]),
			CacheControl: cc,
			Raw:          mustRaw(bm["source"]),
		}
		if src, ok := bm["source"].(map[string]any); ok {
			p.MediaType = asString(src["media_type"])
			p.Data = asString(src["data"])
			p.URL = asString(src["url"])
		}
		return p, true
	case "tool_use":
		args := mustRaw(bm["input"])
		if len(args) == 0 {
			args = json.RawMessage(`{}`)
		}
		return ir.Part{
			Kind:         ir.PartToolCall,
			CallID:       asString(bm["id"]),
			Name:         asString(bm["name"]),
			Args:         args,
			Caller:       mustRaw(bm["caller"]),
			CacheControl: cc,
		}, true
	case "tool_result":
		p := ir.Part{
			Kind:         ir.PartToolResult,
			CallID:       asString(bm["tool_use_id"]),
			CacheControl: cc,
		}
		if b, ok := asBool(bm["is_error"]); ok {
			p.IsError = b
		}
		switch rc := bm["content"].(type) {
		case string:
			p.ResultText = rc
		case []any:
			for _, sub := range rc {
				if sp, ok := parseAnthropicBlock(sub); ok {
					p.ResultParts = append(p.ResultParts, sp)
				}
			}
		}
		return p, true
	case "tool_reference":
		return ir.Part{Kind: ir.PartToolReference, ToolName: asString(bm["tool_name"]), CacheControl: cc}, true
	default:
		if providerHistoryBlockTypes[typ] {
			return ir.Part{Kind: ir.PartProviderBlock, ProviderType: typ, CacheControl: cc, Raw: mustRaw(bm)}, true
		}
		return ir.Part{}, false
	}
}

// --- 2. OpenAI Chat Completions Parser ---

func parseChat(raw map[string]any) (*ir.Request, error) {
	req := &ir.Request{
		InboundProtocol: ir.ProtoChat,
		Model:           strings.TrimSpace(asString(raw["model"])),
		RawExtra:        raw,
	}
	if b, ok := asBool(raw["stream"]); ok {
		req.Stream = b
	}
	if mt, ok := asInt(raw["max_completion_tokens"]); ok {
		req.MaxTokens = &mt
	} else if mt, ok := asInt(raw["max_tokens"]); ok {
		req.MaxTokens = &mt
	}
	if f, ok := asFloat(raw["temperature"]); ok {
		req.Temperature = &f
	}
	if f, ok := asFloat(raw["top_p"]); ok {
		req.TopP = &f
	}
	req.Stop = parseStop(raw["stop"])
	if b, ok := asBool(raw["parallel_tool_calls"]); ok {
		req.ParallelToolCalls = &b
	}
	if eff := strings.TrimSpace(asString(raw["reasoning_effort"])); eff != "" {
		req.Reasoning = &ir.Reasoning{Effort: strings.ToLower(eff)}
	}
	req.ServiceTier = strings.TrimSpace(asString(raw["service_tier"]))
	req.PromptCacheKey = strings.TrimSpace(asString(raw["prompt_cache_key"]))
	if meta, ok := raw["metadata"].(map[string]any); ok {
		req.Metadata = meta
	}
	collectUnrepresentable(req, raw)

	// response_format (fail closed on malformed json_schema.schema)
	if rf, ok := raw["response_format"].(map[string]any); ok {
		typ := strings.ToLower(strings.TrimSpace(asString(rf["type"])))
		switch typ {
		case "json_schema":
			wrapper, _ := rf["json_schema"].(map[string]any)
			if wrapper == nil {
				wrapper = rf
			}
			schemaVal := wrapper["schema"]
			schemaMap, isObj := schemaVal.(map[string]any)
			if !isObj || schemaMap == nil {
				return nil, badRequest("response_format.json_schema.schema", "response_format.json_schema.schema must be a JSON schema object", "invalid_messages_conversion")
			}
			of := &ir.OutputFormat{
				Type:        "json_schema",
				Name:        asString(wrapper["name"]),
				Description: asString(wrapper["description"]),
				Schema:      mustRaw(schemaMap),
			}
			if b, ok := asBool(wrapper["strict"]); ok {
				of.Strict = &b
			}
			req.Format = of
		case "json_object":
			req.Format = &ir.OutputFormat{Type: "json_object", Schema: json.RawMessage(`{"type":"object"}`)}
		}
	}

	// Tools (standard tools[] + legacy functions[])
	if tools, ok := raw["tools"].([]any); ok {
		for _, item := range tools {
			tm, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if fn, ok := tm["function"].(map[string]any); ok {
				schema := mustRaw(fn["parameters"])
				if len(schema) == 0 {
					schema = json.RawMessage(`{"type":"object","properties":{}}`)
				}
				t := ir.Tool{
					Kind:        "custom",
					Name:        asString(fn["name"]),
					Description: asString(fn["description"]),
					Schema:      schema,
				}
				if b, ok := asBool(fn["strict"]); ok {
					t.Strict = &b
				}
				req.Tools = append(req.Tools, t)
			} else if name := asString(tm["name"]); name != "" {
				schema := mustRaw(tm["parameters"])
				if len(schema) == 0 {
					schema = json.RawMessage(`{"type":"object","properties":{}}`)
				}
				req.Tools = append(req.Tools, ir.Tool{
					Kind:        "custom",
					Name:        name,
					Description: asString(tm["description"]),
					Schema:      schema,
				})
			}
		}
	} else if fns, ok := raw["functions"].([]any); ok {
		req.RestoreContext.LegacyFunctions = true
		for _, item := range fns {
			fn, ok := item.(map[string]any)
			if !ok {
				continue
			}
			schema := mustRaw(fn["parameters"])
			if len(schema) == 0 {
				schema = json.RawMessage(`{"type":"object","properties":{}}`)
			}
			req.Tools = append(req.Tools, ir.Tool{
				Kind:        "custom",
				Name:        asString(fn["name"]),
				Description: asString(fn["description"]),
				Schema:      schema,
			})
		}
	}

	// tool_choice
	if tc := raw["tool_choice"]; tc != nil {
		req.ToolChoice = parseOpenAIToolChoice(tc)
	}

	// Messages
	if msgs, ok := raw["messages"].([]any); ok {
		for _, item := range msgs {
			mm, ok := item.(map[string]any)
			if !ok {
				continue
			}
			role := strings.ToLower(strings.TrimSpace(asString(mm["role"])))
			switch role {
			case "system", "developer":
				txt := extractChatText(mm["content"])
				if txt != "" {
					req.System = append(req.System, ir.SystemBlock{Text: txt})
				}
			case "tool", "function":
				callID := asString(mm["tool_call_id"])
				if callID == "" {
					callID = asString(mm["id"])
				}
				if callID == "" {
					callID = "call_unknown"
				}
				tr := ir.Part{
					Kind:       ir.PartToolResult,
					CallID:     callID,
					Name:       asString(mm["name"]),
					ResultText: extractChatText(mm["content"]),
				}
				// Merge consecutive tool results into the same user message for alternation safety.
				if len(req.Messages) > 0 && req.Messages[len(req.Messages)-1].Role == "user" &&
					len(req.Messages[len(req.Messages)-1].Parts) > 0 &&
					req.Messages[len(req.Messages)-1].Parts[0].Kind == ir.PartToolResult {
					req.Messages[len(req.Messages)-1].Parts = append(req.Messages[len(req.Messages)-1].Parts, tr)
				} else {
					req.Messages = append(req.Messages, ir.Message{Role: "user", Parts: []ir.Part{tr}})
				}
			case "assistant":
				var parts []ir.Part
				if rc := asString(mm["reasoning_content"]); rc != "" {
					parts = append(parts, ir.Part{Kind: ir.PartThinking, Text: rc})
				}
				parts = append(parts, parseChatContentParts(mm["content"])...)
				if tcs, ok := mm["tool_calls"].([]any); ok {
					for _, rawTC := range tcs {
						tcm, ok := rawTC.(map[string]any)
						if !ok {
							continue
						}
						fn, _ := tcm["function"].(map[string]any)
						name := asString(fn["name"])
						if name == "" {
							name = asString(tcm["name"])
						}
						rawArgs := fn["arguments"]
						if rawArgs == nil {
							rawArgs = tcm["arguments"]
						}
						args := normalizeToolArgsJSON(rawArgs)
						callID := asString(tcm["id"])
						if callID == "" {
							callID = "call_" + name
						}
						parts = append(parts, ir.Part{
							Kind:   ir.PartToolCall,
							CallID: callID,
							Name:   name,
							Args:   args,
						})
					}
				}
				if len(parts) > 0 {
					req.Messages = append(req.Messages, ir.Message{Role: "assistant", Parts: parts})
				}
			default:
				parts := parseChatContentParts(mm["content"])
				if len(parts) > 0 {
					if len(req.Messages) > 0 && req.Messages[len(req.Messages)-1].Role == "user" {
						req.Messages[len(req.Messages)-1].Parts = append(req.Messages[len(req.Messages)-1].Parts, parts...)
					} else {
						req.Messages = append(req.Messages, ir.Message{Role: "user", Parts: parts})
					}
				}
			}
		}
	}
	return req, nil
}

func extractChatText(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		var sb strings.Builder
		for _, item := range c {
			if s, ok := item.(string); ok {
				if sb.Len() > 0 {
					sb.WriteByte('\n')
				}
				sb.WriteString(s)
			} else if m, ok := item.(map[string]any); ok {
				if t := asString(m["text"]); t != "" {
					if sb.Len() > 0 {
						sb.WriteByte('\n')
					}
					sb.WriteString(t)
				}
			}
		}
		return sb.String()
	}
	return ""
}

func parseChatContentParts(content any) []ir.Part {
	switch c := content.(type) {
	case string:
		if c == "" {
			return nil
		}
		return []ir.Part{{Kind: ir.PartText, Text: c}}
	case []any:
		var out []ir.Part
		for _, item := range c {
			if s, ok := item.(string); ok && s != "" {
				out = append(out, ir.Part{Kind: ir.PartText, Text: s})
				continue
			}
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			typ := asString(m["type"])
			switch typ {
			case "image_url", "input_image":
				var urlStr string
				if iu, ok := m["image_url"].(map[string]any); ok {
					urlStr = asString(iu["url"])
				} else {
					urlStr = asString(m["image_url"])
				}
				if urlStr == "" {
					urlStr = asString(m["url"])
				}
				if mt, b64, ok := parseDataURI(urlStr); ok {
					out = append(out, ir.Part{Kind: ir.PartImage, MediaType: mt, Data: b64})
				} else if urlStr != "" {
					out = append(out, ir.Part{Kind: ir.PartImage, URL: urlStr})
				}
			default:
				if txt := asString(m["text"]); txt != "" {
					out = append(out, ir.Part{Kind: ir.PartText, Text: txt})
				}
			}
		}
		return out
	}
	return nil
}

func normalizeToolArgsJSON(v any) json.RawMessage {
	switch x := v.(type) {
	case string:
		trimmed := strings.TrimSpace(x)
		if trimmed == "" {
			return json.RawMessage(`{}`)
		}
		if json.Valid([]byte(trimmed)) {
			var check map[string]any
			if err := json.Unmarshal([]byte(trimmed), &check); err == nil && check != nil {
				return json.RawMessage(trimmed)
			}
		}
		b, _ := json.Marshal(map[string]any{"raw": trimmed})
		return b
	case map[string]any:
		return mustRaw(x)
	default:
		return json.RawMessage(`{}`)
	}
}

func parseOpenAIToolChoice(tc any) *ir.ToolChoice {
	switch x := tc.(type) {
	case string:
		m := strings.ToLower(strings.TrimSpace(x))
		if m == "required" || m == "any" {
			return &ir.ToolChoice{Mode: "any"}
		}
		if m == "auto" || m == "none" {
			return &ir.ToolChoice{Mode: m}
		}
	case map[string]any:
		typ := strings.ToLower(strings.TrimSpace(asString(x["type"])))
		name := strings.TrimSpace(asString(x["name"]))
		if fn, ok := x["function"].(map[string]any); ok && name == "" {
			name = strings.TrimSpace(asString(fn["name"]))
		}
		switch typ {
		case "auto", "none":
			return &ir.ToolChoice{Mode: typ}
		case "required", "any":
			return &ir.ToolChoice{Mode: "any"}
		case "function", "tool", "custom":
			if name != "" {
				return &ir.ToolChoice{Mode: "tool", Name: name}
			}
			return &ir.ToolChoice{Mode: "any"}
		case "allowed_tools":
			out := &ir.ToolChoice{Mode: "allowed_tools", Raw: mustRaw(x)}
			if arr, ok := x["tools"].([]any); ok {
				for _, item := range arr {
					if m, ok := item.(map[string]any); ok {
						n := asString(m["name"])
						if fn, ok := m["function"].(map[string]any); ok && n == "" {
							n = asString(fn["name"])
						}
						if n != "" {
							out.AllowedNames = append(out.AllowedNames, n)
						}
					}
				}
			}
			return out
		}
	}
	return nil
}

// --- 3. OpenAI Legacy Completions Parser ---

func parseCompletions(raw map[string]any) (*ir.Request, error) {
	req := &ir.Request{
		InboundProtocol: ir.ProtoCompletions,
		Model:           strings.TrimSpace(asString(raw["model"])),
		RawExtra:        raw,
	}
	if b, ok := asBool(raw["stream"]); ok {
		req.Stream = b
	}
	if mt, ok := asInt(raw["max_tokens"]); ok {
		req.MaxTokens = &mt
	}
	if f, ok := asFloat(raw["temperature"]); ok {
		req.Temperature = &f
	}
	if f, ok := asFloat(raw["top_p"]); ok {
		req.TopP = &f
	}
	req.Stop = parseStop(raw["stop"])
	collectUnrepresentable(req, raw)

	var prompt string
	switch p := raw["prompt"].(type) {
	case string:
		prompt = p
	case []any:
		var parts []string
		for _, item := range p {
			if s, ok := item.(string); ok {
				parts = append(parts, s)
			}
		}
		prompt = strings.Join(parts, "\n")
	}
	if prompt != "" {
		req.Messages = append(req.Messages, ir.Message{
			Role:  "user",
			Parts: []ir.Part{{Kind: ir.PartText, Text: prompt}},
		})
	}
	return req, nil
}

// --- 4. OpenAI Responses Parser ---

func parseResponses(raw map[string]any) (*ir.Request, error) {
	req := &ir.Request{
		InboundProtocol: ir.ProtoResponses,
		Model:           strings.TrimSpace(asString(raw["model"])),
		RawExtra:        raw,
	}
	if b, ok := asBool(raw["stream"]); ok {
		req.Stream = b
	}
	if mt, ok := asInt(raw["max_output_tokens"]); ok {
		req.MaxTokens = &mt
	}
	if f, ok := asFloat(raw["temperature"]); ok {
		req.Temperature = &f
	}
	if f, ok := asFloat(raw["top_p"]); ok {
		req.TopP = &f
	}
	if b, ok := asBool(raw["parallel_tool_calls"]); ok {
		req.ParallelToolCalls = &b
	}
	if b, ok := asBool(raw["store"]); ok {
		req.Store = &b
	}
	if inc, ok := raw["include"].([]any); ok {
		for _, x := range inc {
			if s, ok := x.(string); ok && s != "" {
				req.Include = append(req.Include, s)
			}
		}
	}
	req.ServiceTier = strings.TrimSpace(asString(raw["service_tier"]))
	req.PromptCacheKey = strings.TrimSpace(asString(raw["prompt_cache_key"]))
	req.ConversationID = strings.TrimSpace(asString(raw["conversation_id"]))
	if req.ConversationID == "" {
		req.ConversationID = strings.TrimSpace(asString(raw["session_id"]))
	}
	if meta, ok := raw["metadata"].(map[string]any); ok {
		req.Metadata = meta
	}
	if inst := asString(raw["instructions"]); strings.TrimSpace(inst) != "" {
		req.System = append(req.System, ir.SystemBlock{Text: inst})
	}
	if rMap, ok := raw["reasoning"].(map[string]any); ok {
		if eff := strings.ToLower(strings.TrimSpace(asString(rMap["effort"]))); eff != "" {
			req.Reasoning = &ir.Reasoning{Effort: eff}
		}
	}
	if txtMap, ok := raw["text"].(map[string]any); ok {
		if fMap, ok := txtMap["format"].(map[string]any); ok {
			typ := strings.ToLower(strings.TrimSpace(asString(fMap["type"])))
			if typ == "json_schema" || typ == "json_object" {
				of := &ir.OutputFormat{
					Type:        typ,
					Name:        asString(fMap["name"]),
					Description: asString(fMap["description"]),
					Schema:      mustRaw(fMap["schema"]),
				}
				if typ == "json_object" && len(of.Schema) == 0 {
					of.Schema = json.RawMessage(`{"type":"object"}`)
				}
				req.Format = of
			}
		}
	}
	if tools, ok := raw["tools"].([]any); ok {
		for _, item := range tools {
			tm, ok := item.(map[string]any)
			if !ok {
				continue
			}
			ttype := asString(tm["type"])
			if ttype == "web_search" || ttype == "web_search_preview" {
				req.Tools = append(req.Tools, ir.Tool{Kind: "google_search", Type: ttype, Name: "web_search", Raw: mustRaw(tm)})
				continue
			}
			name := asString(tm["name"])
			if fn, ok := tm["function"].(map[string]any); ok && name == "" {
				name = asString(fn["name"])
			}
			if name == "" {
				continue
			}
			schema := mustRaw(tm["parameters"])
			if len(schema) == 0 {
				schema = json.RawMessage(`{"type":"object","properties":{}}`)
			}
			req.Tools = append(req.Tools, ir.Tool{
				Kind:        "custom",
				Type:        ttype,
				Name:        name,
				Description: asString(tm["description"]),
				Schema:      schema,
				Raw:         mustRaw(tm),
			})
		}
	}
	if tc := raw["tool_choice"]; tc != nil {
		req.ToolChoice = parseOpenAIToolChoice(tc)
	}

	// Input items
	switch inp := raw["input"].(type) {
	case string:
		if inp != "" {
			req.Messages = append(req.Messages, ir.Message{Role: "user", Parts: []ir.Part{{Kind: ir.PartText, Text: inp}}})
		}
	case []any:
		for _, item := range inp {
			if s, ok := item.(string); ok && s != "" {
				req.Messages = append(req.Messages, ir.Message{Role: "user", Parts: []ir.Part{{Kind: ir.PartText, Text: s}}})
				continue
			}
			im, ok := item.(map[string]any)
			if !ok {
				continue
			}
			typ := asString(im["type"])
			switch typ {
			case "function_call":
				name := asString(im["name"])
				callID := asString(im["call_id"])
				if callID == "" {
					callID = asString(im["id"])
				}
				part := ir.Part{
					Kind:   ir.PartToolCall,
					CallID: callID,
					Name:   name,
					Args:   normalizeToolArgsJSON(im["arguments"]),
				}
				if len(req.Messages) > 0 && req.Messages[len(req.Messages)-1].Role == "assistant" {
					req.Messages[len(req.Messages)-1].Parts = append(req.Messages[len(req.Messages)-1].Parts, part)
				} else {
					req.Messages = append(req.Messages, ir.Message{Role: "assistant", Parts: []ir.Part{part}})
				}
			case "function_call_output":
				callID := asString(im["call_id"])
				if callID == "" {
					callID = "call_unknown"
				}
				part := ir.Part{
					Kind:       ir.PartToolResult,
					CallID:     callID,
					ResultText: extractChatText(im["output"]),
				}
				if len(req.Messages) > 0 && req.Messages[len(req.Messages)-1].Role == "user" &&
					len(req.Messages[len(req.Messages)-1].Parts) > 0 &&
					req.Messages[len(req.Messages)-1].Parts[0].Kind == ir.PartToolResult {
					req.Messages[len(req.Messages)-1].Parts = append(req.Messages[len(req.Messages)-1].Parts, part)
				} else {
					req.Messages = append(req.Messages, ir.Message{Role: "user", Parts: []ir.Part{part}})
				}
			case "reasoning":
				// Reopen magpie-claude1 sealed thinking blocks for Anthropic targets; drop opaque foreign blobs cleanly.
				enc := asString(im["encrypted_content"])
				if block, ours := ir.OpenClaudeSeal(enc); ours && len(block) > 0 {
					var bm map[string]any
					if err := json.Unmarshal(block, &bm); err == nil {
						if p, ok := parseAnthropicBlock(bm); ok {
							if len(req.Messages) > 0 && req.Messages[len(req.Messages)-1].Role == "assistant" {
								req.Messages[len(req.Messages)-1].Parts = append(req.Messages[len(req.Messages)-1].Parts, p)
							} else {
								req.Messages = append(req.Messages, ir.Message{Role: "assistant", Parts: []ir.Part{p}})
							}
						}
					}
				} else if sum, ok := im["summary"].([]any); ok {
					var sb strings.Builder
					for _, s := range sum {
						if sm, ok := s.(map[string]any); ok {
							sb.WriteString(asString(sm["text"]))
						}
					}
					if sb.Len() > 0 {
						p := ir.Part{Kind: ir.PartThinking, Text: sb.String()}
						if len(req.Messages) > 0 && req.Messages[len(req.Messages)-1].Role == "assistant" {
							req.Messages[len(req.Messages)-1].Parts = append(req.Messages[len(req.Messages)-1].Parts, p)
						} else {
							req.Messages = append(req.Messages, ir.Message{Role: "assistant", Parts: []ir.Part{p}})
						}
					}
				}
			default:
				role := strings.ToLower(strings.TrimSpace(asString(im["role"])))
				if role == "system" || role == "developer" {
					if txt := extractChatText(im["content"]); txt != "" {
						req.System = append(req.System, ir.SystemBlock{Text: txt})
					}
					continue
				}
				if role == "" {
					role = "user"
				}
				parts := parseChatContentParts(im["content"])
				if len(parts) > 0 {
					req.Messages = append(req.Messages, ir.Message{Role: role, Parts: parts})
				}
			}
		}
	}
	return req, nil
}

// --- 5. Google Gemini Parser ---

func snakeToCamelKey(k string) string {
	if !strings.Contains(k, "_") {
		return k
	}
	segs := strings.Split(k, "_")
	var sb strings.Builder
	sb.WriteString(segs[0])
	for _, s := range segs[1:] {
		if s == "" {
			continue
		}
		sb.WriteString(strings.ToUpper(s[:1]) + s[1:])
	}
	return sb.String()
}

// camelCaseGeminiProto converts snake_case proto keys while preserving caller-owned args/response/labels/schema payloads.
func camelCaseGeminiProto(v any, preserveKeys bool) any {
	switch x := v.(type) {
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = camelCaseGeminiProto(item, preserveKeys)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			nk := k
			if !preserveKeys {
				nk = snakeToCamelKey(k)
			}
			childPreserve := preserveKeys || nk == "args" || nk == "response" || nk == "labels" ||
				nk == "parameters" || nk == "parametersJsonSchema" || nk == "responseSchema" || nk == "responseJsonSchema"
			out[nk] = camelCaseGeminiProto(val, childPreserve)
		}
		return out
	default:
		return v
	}
}

func parseGemini(raw map[string]any, opts ParseOptions) (*ir.Request, error) {
	norm, _ := camelCaseGeminiProto(raw, false).(map[string]any)
	model := strings.TrimSpace(opts.RouteModel)
	if model == "" {
		model = strings.TrimSpace(asString(norm["model"]))
	}
	req := &ir.Request{
		InboundProtocol: ir.ProtoGemini,
		Model:           model,
		RawExtra:        norm,
	}
	if opts.RouteStream != nil {
		req.Stream = *opts.RouteStream
	} else if b, ok := asBool(norm["stream"]); ok {
		req.Stream = b
	}

	// systemInstruction
	if si, ok := norm["systemInstruction"].(map[string]any); ok {
		if parts, ok := si["parts"].([]any); ok {
			for _, p := range parts {
				if pm, ok := p.(map[string]any); ok {
					if txt := asString(pm["text"]); txt != "" {
						req.System = append(req.System, ir.SystemBlock{Text: txt})
					}
				}
			}
		}
	}

	// generationConfig
	if gc, ok := norm["generationConfig"].(map[string]any); ok {
		if cc, ok := asInt(gc["candidateCount"]); ok && cc > 1 {
			return nil, badRequest("generationConfig.candidateCount", "candidateCount > 1 is not supported", "invalid_request")
		}
		if mt, ok := asInt(gc["maxOutputTokens"]); ok {
			req.MaxTokens = &mt
		}
		if f, ok := asFloat(gc["temperature"]); ok {
			req.Temperature = &f
		}
		if f, ok := asFloat(gc["topP"]); ok {
			req.TopP = &f
		}
		if k, ok := asInt(gc["topK"]); ok {
			req.TopK = &k
		}
		req.Stop = parseStop(gc["stopSequences"])
		mime := strings.ToLower(strings.TrimSpace(asString(gc["responseMimeType"])))
		schema := gc["responseJsonSchema"]
		if schema == nil {
			schema = gc["responseSchema"]
		}
		if schema != nil {
			req.Format = &ir.OutputFormat{Type: "json_schema", Schema: mustRaw(schema)}
		} else if mime == "application/json" {
			req.Format = &ir.OutputFormat{Type: "json_object", Schema: json.RawMessage(`{"type":"object"}`)}
		}
		if tc, ok := gc["thinkingConfig"].(map[string]any); ok {
			r := &ir.Reasoning{Effort: strings.ToLower(strings.TrimSpace(asString(tc["thinkingLevel"])))}
			if b, ok := asInt(tc["thinkingBudget"]); ok {
				r.Budget = &b
				if b == 0 {
					r.Mode = "disabled"
				} else {
					r.Mode = "enabled"
				}
			}
			if inc, ok := asBool(tc["includeThoughts"]); ok {
				r.IncludeThoughts = &inc
			}
			req.Reasoning = r
		}
	}

	// tools
	if tools, ok := norm["tools"].([]any); ok {
		for _, item := range tools {
			tm, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if tm["googleSearch"] != nil {
				req.Tools = append(req.Tools, ir.Tool{Kind: "google_search", Name: "google_search", Raw: mustRaw(tm)})
			}
			if tm["codeExecution"] != nil {
				req.Tools = append(req.Tools, ir.Tool{Kind: "code_execution", Name: "code_execution", Raw: mustRaw(tm)})
			}
			if decls, ok := tm["functionDeclarations"].([]any); ok {
				for _, d := range decls {
					dm, ok := d.(map[string]any)
					if !ok {
						continue
					}
					schema := mustRaw(dm["parametersJsonSchema"])
					if len(schema) == 0 {
						schema = mustRaw(dm["parameters"])
					}
					if len(schema) == 0 {
						schema = json.RawMessage(`{"type":"object","properties":{}}`)
					}
					req.Tools = append(req.Tools, ir.Tool{
						Kind:        "custom",
						Name:        asString(dm["name"]),
						Description: asString(dm["description"]),
						Schema:      schema,
					})
				}
			}
		}
	}

	// toolConfig
	if tc, ok := norm["toolConfig"].(map[string]any); ok {
		if fcc, ok := tc["functionCallingConfig"].(map[string]any); ok {
			mode := strings.ToUpper(strings.TrimSpace(asString(fcc["mode"])))
			var allowed []string
			if names, ok := fcc["allowedFunctionNames"].([]any); ok {
				for _, n := range names {
					if s, ok := n.(string); ok && s != "" {
						allowed = append(allowed, s)
					}
				}
			}
			switch mode {
			case "NONE":
				req.ToolChoice = &ir.ToolChoice{Mode: "none"}
			case "ANY":
				if len(allowed) == 1 {
					req.ToolChoice = &ir.ToolChoice{Mode: "tool", Name: allowed[0]}
				} else {
					req.ToolChoice = &ir.ToolChoice{Mode: "any", AllowedNames: allowed}
				}
			case "AUTO":
				req.ToolChoice = &ir.ToolChoice{Mode: "auto", AllowedNames: allowed}
			}
		}
	}

	// contents
	if contents, ok := norm["contents"].([]any); ok {
		callSeq := 0
		for _, c := range contents {
			cm, ok := c.(map[string]any)
			if !ok {
				continue
			}
			role := strings.ToLower(strings.TrimSpace(asString(cm["role"])))
			if role == "model" {
				role = "assistant"
			} else if role == "" {
				role = "user"
			}
			var parts []ir.Part
			if rawParts, ok := cm["parts"].([]any); ok {
				for _, rp := range rawParts {
					pm, ok := rp.(map[string]any)
					if !ok {
						continue
					}
					sig := asString(pm["thoughtSignature"])
					if isThought, _ := asBool(pm["thought"]); isThought {
						parts = append(parts, ir.Part{Kind: ir.PartThinking, Text: asString(pm["text"]), Signature: sig})
						continue
					}
					if txt, exists := pm["text"]; exists && asString(txt) != "" {
						parts = append(parts, ir.Part{Kind: ir.PartText, Text: asString(txt), Signature: sig})
						continue
					}
					if idata, ok := pm["inlineData"].(map[string]any); ok {
						parts = append(parts, ir.Part{
							Kind:      ir.PartImage,
							MediaType: asString(idata["mimeType"]),
							Data:      asString(idata["data"]),
						})
						continue
					}
					if fdata, ok := pm["fileData"].(map[string]any); ok {
						parts = append(parts, ir.Part{
							Kind:      ir.PartImage,
							MediaType: asString(fdata["mimeType"]),
							URL:       asString(fdata["fileUri"]),
						})
						continue
					}
					if fc, ok := pm["functionCall"].(map[string]any); ok {
						callSeq++
						cid := asString(fc["id"])
						if cid == "" {
							cid = fmt.Sprintf("call_gem_%d", callSeq)
						}
						args := mustRaw(fc["args"])
						if len(args) == 0 {
							args = json.RawMessage(`{}`)
						}
						parts = append(parts, ir.Part{
							Kind:      ir.PartToolCall,
							CallID:    cid,
							Name:      StripGeminiToolPrefix(asString(fc["name"])),
							Args:      args,
							Signature: sig,
						})
						continue
					}
					if fr, ok := pm["functionResponse"].(map[string]any); ok {
						cid := asString(fr["id"])
						if cid == "" {
							cid = fmt.Sprintf("call_gem_%d", callSeq)
						}
						respJSON := mustRaw(fr["response"])
						parts = append(parts, ir.Part{
							Kind:       ir.PartToolResult,
							CallID:     cid,
							Name:       StripGeminiToolPrefix(asString(fr["name"])),
							ResultText: string(respJSON),
						})
					}
				}
			}
			if len(parts) > 0 {
				req.Messages = append(req.Messages, ir.Message{Role: role, Parts: parts})
			}
		}
	}
	return req, nil
}

// StripGeminiToolPrefix removes default_api: / _x_ synthetic prefixes added for Gemini tool names.
func StripGeminiToolPrefix(name string) string {
	s := strings.TrimPrefix(name, "default_api:")
	s = strings.TrimPrefix(s, "default_api.")
	s = strings.TrimPrefix(s, "_x_")
	return s
}

// SanitizeGeminiFuncName ensures tool names satisfy Gemini's [A-Za-z_][A-Za-z0-9_.:-]* constraint.
func SanitizeGeminiFuncName(name string) string {
	if name == "" {
		return "_x_tool"
	}
	first := name[0]
	if !((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z') || first == '_') {
		return "_x_" + name
	}
	return name
}
