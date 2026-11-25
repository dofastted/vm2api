package codec

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/dofastted/kin-gateway/protofront/internal/detect"
	"github.com/dofastted/kin-gateway/protofront/internal/ir"
)

// BuildOptions carries target-specific runtime flags (capabilities, persona preset, passthrough).
type BuildOptions struct {
	Target            ir.Target
	Decision          detect.Decision
	Settings          detect.WebSettings
	SlotCapabilities  []string
	OutboundSessionID string
	CanonicalHandoff  bool
}

// BuildResult is the compiled target-ready request payload + metadata.
type BuildResult struct {
	Body           map[string]any    `json:"outbound_body"`
	Headers        map[string]string `json:"outbound_headers,omitempty"`
	RestoreContext ir.RestoreContext `json:"restore_context,omitempty"`
	StrippedFields []string          `json:"stripped_fields,omitempty"`
}

func hasCap(caps []string, want string) bool {
	for _, c := range caps {
		if c == want {
			return true
		}
	}
	return false
}

// Build emits the minimal, strict target payload for the chosen target kernel / API backend.
func Build(req *ir.Request, opts BuildOptions) (*BuildResult, error) {
	switch opts.Target {
	case ir.TargetClaudeCRAG, ir.TargetClaudeCliNode, ir.TargetAPIAnthropic:
		return buildAnthropic(req, opts)
	case ir.TargetCodexKernel, ir.TargetAPIOpenAI:
		return buildCodexResponses(req, opts)
	case ir.TargetGeminiAntigravity, ir.TargetGeminiAPI, ir.TargetAPIGemini:
		return buildGemini(req, opts)
	default:
		return nil, badRequest("target", fmt.Sprintf("unsupported target %q", opts.Target), "unsupported_target")
	}
}

// --- 1. Anthropic / CRAG Minimal Whitelist Builder ---

func buildAnthropic(req *ir.Request, opts BuildOptions) (*BuildResult, error) {
	isCRAG := opts.Target == ir.TargetClaudeCRAG
	out := map[string]any{
		"model":  req.Model,
		"stream": true,
	}
	if opts.Target == ir.TargetAPIAnthropic && !opts.CanonicalHandoff {
		out["stream"] = req.Stream
	}
	if req.MaxTokens != nil && *req.MaxTokens > 0 {
		out["max_tokens"] = *req.MaxTokens
	} else if !isCRAG && !opts.CanonicalHandoff {
		out["max_tokens"] = 4096
	}
	if opts.CanonicalHandoff && req.InboundProtocol == ir.ProtoAnthropic && len(req.Metadata) > 0 {
		out["metadata"] = req.Metadata
	}
	if opts.CanonicalHandoff && req.AutomaticCacheControl != nil {
		out["cache_control"] = cacheControlMap(req.AutomaticCacheControl)
	}
	if req.Temperature != nil {
		out["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		out["top_p"] = *req.TopP
	}
	if req.TopK != nil {
		out["top_k"] = *req.TopK
	}
	if len(req.Stop) > 0 {
		out["stop_sequences"] = req.Stop
	}

	// System blocks (for CRAG non-passthrough zero/append preset, emit crag_prompt when configured)
	if len(req.System) > 0 {
		sysBlocks := make([]map[string]any, 0, len(req.System))
		for _, sb := range req.System {
			blk := map[string]any{"type": "text", "text": sb.Text}
			if sb.CacheControl != nil {
				blk["cache_control"] = cacheControlMap(sb.CacheControl)
			}
			sysBlocks = append(sysBlocks, blk)
		}
		preset := strings.ToLower(strings.TrimSpace(opts.Settings.Compatibility.CragPersonaPreset))
		if isCRAG && !opts.CanonicalHandoff && !opts.Decision.AllowPassthrough && preset == "zero" {
			var tailParts []string
			for _, sb := range req.System {
				if strings.TrimSpace(sb.Text) != "" {
					tailParts = append(tailParts, sb.Text)
				}
			}
			if len(tailParts) > 0 {
				out["crag_prompt"] = map[string]any{
					"mode": "replace",
					"text": strings.Join(tailParts, "\n\n"),
				}
			}
		} else {
			out["system"] = sysBlocks
		}
	}

	// Thinking & output_config
	if req.Reasoning != nil {
		mode := req.Reasoning.Mode
		if mode == "" && req.InboundProtocol != ir.ProtoAnthropic && req.Reasoning.Effort != "" && req.Reasoning.Effort != "none" {
			mode = "adaptive"
		}
		if mode != "" {
			th := map[string]any{"type": mode}
			if req.Reasoning.Budget != nil && mode == "enabled" {
				th["budget_tokens"] = *req.Reasoning.Budget
			}
			if req.Reasoning.Display != "" {
				th["display"] = req.Reasoning.Display
			}
			out["thinking"] = th
		}
	}
	outputCfg := map[string]any{}
	if len(req.OutputConfig) > 0 {
		_ = json.Unmarshal(req.OutputConfig, &outputCfg)
	}
	if req.Reasoning != nil && req.Reasoning.Effort != "" && outputCfg["effort"] == nil {
		outputCfg["effort"] = req.Reasoning.Effort
	}
	if req.Format != nil && outputCfg["format"] == nil {
		fmtObj := map[string]any{"type": "json_schema"}
		if len(req.Format.Schema) > 0 {
			var s any
			if json.Unmarshal(req.Format.Schema, &s) == nil {
				fmtObj["schema"] = s
			}
		}
		if req.Format.Name != "" {
			fmtObj["name"] = req.Format.Name
		}
		if req.Format.Description != "" {
			fmtObj["description"] = req.Format.Description
		}
		outputCfg["format"] = fmtObj
	}
	if len(outputCfg) > 0 {
		out["output_config"] = outputCfg
	}
	if len(req.ContextManagement) > 0 {
		var cm any
		if json.Unmarshal(req.ContextManagement, &cm) == nil {
			out["context_management"] = cm
		}
	}

	// Capability-gated CRAG extensions
	if len(req.Safeguards) > 0 && (!isCRAG || len(opts.SlotCapabilities) == 0 || hasCap(opts.SlotCapabilities, "request_safeguards")) {
		var sg any
		if json.Unmarshal(req.Safeguards, &sg) == nil {
			out["safeguards"] = sg
		}
	}
	if req.Speed != "" && (!isCRAG || len(opts.SlotCapabilities) == 0 || hasCap(opts.SlotCapabilities, "request_speed")) {
		out["speed"] = req.Speed
	}
	if len(req.Thread) > 0 && (!isCRAG || len(opts.SlotCapabilities) == 0 || hasCap(opts.SlotCapabilities, "message_threads_beta")) {
		var th any
		if json.Unmarshal(req.Thread, &th) == nil {
			out["thread"] = th
		}
	}
	if req.ServiceTier != "" {
		if !isCRAG || hasCap(opts.SlotCapabilities, "request_service_tier") {
			out["service_tier"] = req.ServiceTier
		} else if req.ServiceTier == "standard_only" {
			return nil, badRequest("service_tier", "service_tier=\"standard_only\" is not supported on CRAG", "unsupported_capability")
		}
	}

	// Tools
	if len(req.Tools) > 0 {
		toolsOut := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			switch t.Kind {
			case "advisor", "provider":
				var rawMap map[string]any
				if len(t.Raw) > 0 && json.Unmarshal(t.Raw, &rawMap) == nil {
					delete(rawMap, "annotations")
					delete(rawMap, "function")
					delete(rawMap, "parameters")
					toolsOut = append(toolsOut, rawMap)
				}
			case "google_search":
				toolsOut = append(toolsOut, map[string]any{"type": "web_search_20250305", "name": "web_search"})
			default:
				var schema any = map[string]any{"type": "object", "properties": map[string]any{}}
				if len(t.Schema) > 0 {
					_ = json.Unmarshal(t.Schema, &schema)
				}
				tm := map[string]any{
					"name":         t.Name,
					"input_schema": schema,
				}
				if t.Description != "" || req.InboundProtocol != ir.ProtoAnthropic {
					tm["description"] = t.Description
				}
				if t.Strict != nil {
					tm["strict"] = *t.Strict
				}
				if t.EagerInputStreaming != nil {
					tm["eager_input_streaming"] = *t.EagerInputStreaming
				}
				if t.DeferLoading != nil {
					tm["defer_loading"] = *t.DeferLoading
				}
				if t.CacheControl != nil {
					tm["cache_control"] = cacheControlMap(t.CacheControl)
				}
				toolsOut = append(toolsOut, tm)
			}
		}
		if len(toolsOut) > 0 {
			out["tools"] = toolsOut
		}
	}

	// ToolChoice
	if req.ToolChoice != nil {
		tc := map[string]any{}
		switch req.ToolChoice.Mode {
		case "auto", "none", "any":
			tc["type"] = req.ToolChoice.Mode
		case "required":
			tc["type"] = "any"
		case "tool":
			tc["type"] = "tool"
			tc["name"] = req.ToolChoice.Name
		default:
			if req.ToolChoice.Name != "" {
				tc["type"] = "tool"
				tc["name"] = req.ToolChoice.Name
			} else {
				tc["type"] = "auto"
			}
		}
		if req.ToolChoice.DisableParallelToolUse != nil {
			tc["disable_parallel_tool_use"] = *req.ToolChoice.DisableParallelToolUse
		} else if req.ParallelToolCalls != nil && !*req.ParallelToolCalls {
			tc["disable_parallel_tool_use"] = true
		}
		out["tool_choice"] = tc
	}

	// Messages
	msgsOut := make([]map[string]any, 0, len(req.Messages))
	for _, m := range req.Messages {
		blocks := make([]map[string]any, 0, len(m.Parts))
		for _, p := range m.Parts {
			blk := buildAnthropicPart(p)
			if blk != nil {
				blocks = append(blocks, blk)
			}
		}
		if len(blocks) == 0 && len(m.OutputConfig) == 0 && len(m.ClearAt) == 0 {
			continue
		}
		mm := map[string]any{
			"role":    m.Role,
			"content": blocks,
		}
		if len(m.OutputConfig) > 0 {
			var oc any
			if json.Unmarshal(m.OutputConfig, &oc) == nil {
				mm["output_config"] = oc
			}
		}
		if len(m.ClearAt) > 0 {
			var ca any
			if json.Unmarshal(m.ClearAt, &ca) == nil {
				mm["clear_at"] = ca
			}
		}
		msgsOut = append(msgsOut, mm)
	}
	if len(msgsOut) == 0 {
		return nil, badRequest("messages", "messages must contain at least one non-empty turn", "invalid_kernel_request")
	}
	out["messages"] = msgsOut

	return &BuildResult{
		Body:           out,
		StrippedFields: req.StrippedFields,
	}, nil
}

func cacheControlMap(cc *ir.CacheControl) map[string]any {
	m := map[string]any{"type": cc.Type}
	if cc.TTL != "" {
		m["ttl"] = cc.TTL
	}
	return m
}

func buildAnthropicPart(p ir.Part) map[string]any {
	var out map[string]any
	switch p.Kind {
	case ir.PartText:
		out = map[string]any{"type": "text", "text": p.Text}
	case ir.PartThinking:
		out = map[string]any{"type": "thinking", "thinking": p.Text}
		if p.Signature != "" {
			out["signature"] = p.Signature
		}
		return out // thinking never carries cache_control
	case ir.PartRedactedThinking:
		return map[string]any{"type": "redacted_thinking", "data": p.Data}
	case ir.PartImage:
		if p.Data != "" {
			mt := p.MediaType
			if mt == "" {
				mt = "image/png"
			}
			out = map[string]any{
				"type":   "image",
				"source": map[string]any{"type": "base64", "media_type": mt, "data": p.Data},
			}
		} else if p.URL != "" {
			out = map[string]any{
				"type":   "image",
				"source": map[string]any{"type": "url", "url": p.URL},
			}
		}
	case ir.PartDocument:
		var src any
		if len(p.Raw) > 0 {
			_ = json.Unmarshal(p.Raw, &src)
		}
		out = map[string]any{"type": "document", "source": src}
		if p.Title != "" {
			out["title"] = p.Title
		}
		if p.Context != "" {
			out["context"] = p.Context
		}
	case ir.PartToolCall:
		var inp any = map[string]any{}
		if len(p.Args) > 0 {
			_ = json.Unmarshal(p.Args, &inp)
		}
		out = map[string]any{"type": "tool_use", "id": p.CallID, "name": p.Name, "input": inp}
	case ir.PartToolResult:
		out = map[string]any{"type": "tool_result", "tool_use_id": p.CallID}
		if p.IsError {
			out["is_error"] = true
		}
		if len(p.ResultParts) > 0 {
			sub := make([]map[string]any, 0, len(p.ResultParts))
			for _, sp := range p.ResultParts {
				if sb := buildAnthropicPart(sp); sb != nil {
					sub = append(sub, sb)
				}
			}
			out["content"] = sub
		} else {
			out["content"] = p.ResultText
		}
	case ir.PartToolReference:
		out = map[string]any{"type": "tool_reference", "tool_name": p.ToolName}
	case ir.PartProviderBlock:
		if len(p.Raw) > 0 {
			_ = json.Unmarshal(p.Raw, &out)
			delete(out, "annotations")
		}
	}
	if out != nil && p.CacheControl != nil {
		out["cache_control"] = cacheControlMap(p.CacheControl)
	}
	return out
}

// --- 2. OpenAI Responses / Codex Kernel Builder (fixes G1, G2, G3!) ---

func buildCodexResponses(req *ir.Request, opts BuildOptions) (*BuildResult, error) {
	out := map[string]any{
		"model":  req.Model,
		"stream": true,
		"store":  false,
	}
	if opts.Target == ir.TargetAPIOpenAI {
		out["stream"] = req.Stream
	}
	useDeveloperInput := req.InboundProtocol == ir.ProtoChat || req.InboundProtocol == ir.ProtoCompletions
	if len(req.System) > 0 && !useDeveloperInput {
		var parts []string
		for _, sb := range req.System {
			if strings.TrimSpace(sb.Text) != "" {
				parts = append(parts, sb.Text)
			}
		}
		if len(parts) > 0 {
			out["instructions"] = strings.Join(parts, "\n\n")
		}
	}
	if req.MaxTokens != nil && *req.MaxTokens > 0 && opts.Target == ir.TargetAPIOpenAI {
		out["max_output_tokens"] = *req.MaxTokens
	}
	if req.Temperature != nil && opts.Target == ir.TargetAPIOpenAI {
		out["temperature"] = *req.Temperature
	}
	if req.TopP != nil && opts.Target == ir.TargetAPIOpenAI {
		out["top_p"] = *req.TopP
	}
	if req.ParallelToolCalls != nil {
		out["parallel_tool_calls"] = *req.ParallelToolCalls
	}
	if req.ServiceTier != "" {
		tier := strings.TrimSpace(req.ServiceTier)
		if opts.Target == ir.TargetCodexKernel && strings.EqualFold(tier, "fast") {
			tier = "priority"
		}
		out["service_tier"] = tier
	}
	if req.PromptCacheKey != "" {
		out["prompt_cache_key"] = req.PromptCacheKey
	}
	// Preserve Anthropic thinking / output_config.effort -> Codex reasoning.effort (fixes G2!)
	if req.Reasoning != nil {
		eff := req.Reasoning.Effort
		if eff == "" && req.Reasoning.Mode == "enabled" {
			if req.Reasoning.Budget != nil && *req.Reasoning.Budget >= 8192 {
				eff = "high"
			} else if req.Reasoning.Budget != nil && *req.Reasoning.Budget <= 1024 {
				eff = "low"
			} else {
				eff = "medium"
			}
		} else if eff == "" && req.Reasoning.Mode == "adaptive" {
			eff = "high"
		} else if req.Reasoning.Mode == "disabled" {
			eff = "none"
		}
		if eff != "" && eff != "none" {
			rObj := map[string]any{"effort": eff}
			if req.InboundProtocol == ir.ProtoAnthropic || req.InboundProtocol == ir.ProtoGemini {
				rObj["summary"] = "auto"
			}
			out["reasoning"] = rObj
		}
	}
	if req.Format != nil && req.Format.Type != "" {
		fmtObj := map[string]any{"type": req.Format.Type}
		if req.Format.Name != "" {
			fmtObj["name"] = req.Format.Name
		}
		if len(req.Format.Schema) > 0 {
			var s any
			if json.Unmarshal(req.Format.Schema, &s) == nil {
				fmtObj["schema"] = s
			}
		}
		out["text"] = map[string]any{"format": fmtObj}
	}

	// Tools
	if len(req.Tools) > 0 {
		toolsOut := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			if t.Kind == "google_search" {
				toolsOut = append(toolsOut, map[string]any{"type": "web_search"})
				continue
			}
			if t.Kind != "custom" {
				continue
			}
			var params any = map[string]any{"type": "object", "properties": map[string]any{}}
			if len(t.Schema) > 0 {
				_ = json.Unmarshal(t.Schema, &params)
			}
			tm := map[string]any{
				"type":        "function",
				"name":        t.Name,
				"description": t.Description,
				"parameters":  params,
			}
			if t.Strict != nil {
				tm["strict"] = *t.Strict
			}
			toolsOut = append(toolsOut, tm)
		}
		if len(toolsOut) > 0 {
			out["tools"] = toolsOut
		}
	}

	// ToolChoice
	if req.ToolChoice != nil {
		switch req.ToolChoice.Mode {
		case "none", "auto":
			out["tool_choice"] = req.ToolChoice.Mode
		case "any", "required":
			out["tool_choice"] = "required"
		case "tool":
			if req.ToolChoice.Name != "" {
				out["tool_choice"] = map[string]any{"type": "function", "name": req.ToolChoice.Name}
			}
		}
	}

	// Input items (preserves Anthropic images -> input_image, fixes G3!)
	var items []map[string]any
	if useDeveloperInput && len(req.System) > 0 {
		for _, sb := range req.System {
			if strings.TrimSpace(sb.Text) != "" {
				items = append(items, map[string]any{
					"type":    "message",
					"role":    "developer",
					"content": []map[string]any{{"type": "input_text", "text": sb.Text}},
				})
			}
		}
	}
	for _, m := range req.Messages {
		if m.Role == "assistant" {
			var textParts []map[string]any
			for _, p := range m.Parts {
				switch p.Kind {
				case ir.PartText:
					if p.Text != "" {
						textParts = append(textParts, map[string]any{"type": "output_text", "text": p.Text})
					}
				case ir.PartToolCall:
					if len(textParts) > 0 {
						items = append(items, map[string]any{"type": "message", "role": "assistant", "content": textParts})
						textParts = nil
					}
					argsStr := "{}"
					if len(p.Args) > 0 {
						argsStr = string(p.Args)
					}
					items = append(items, map[string]any{
						"type":      "function_call",
						"call_id":   p.CallID,
						"name":      p.Name,
						"arguments": argsStr,
					})
				}
			}
			if len(textParts) > 0 {
				items = append(items, map[string]any{"type": "message", "role": "assistant", "content": textParts})
			}
			continue
		}

		// User or system turn
		role := "user"
		if m.Role == "system" {
			role = "developer"
		}
		var userParts []map[string]any
		flushUser := func() {
			if len(userParts) > 0 {
				items = append(items, map[string]any{"type": "message", "role": role, "content": userParts})
				userParts = nil
			}
		}
		for _, p := range m.Parts {
			switch p.Kind {
			case ir.PartToolResult:
				flushUser()
				outText := p.ResultText
				if outText == "" && len(p.ResultParts) > 0 {
					var sb strings.Builder
					for _, sp := range p.ResultParts {
						if sp.Kind == ir.PartText {
							sb.WriteString(sp.Text)
						}
					}
					outText = sb.String()
				}
				items = append(items, map[string]any{
					"type":    "function_call_output",
					"call_id": p.CallID,
					"output":  outText,
				})
			case ir.PartImage:
				imgURL := p.URL
				if imgURL == "" && p.Data != "" {
					mt := p.MediaType
					if mt == "" {
						mt = "image/png"
					}
					imgURL = fmt.Sprintf("data:%s;base64,%s", mt, p.Data)
				}
				if imgURL != "" {
					userParts = append(userParts, map[string]any{"type": "input_image", "image_url": imgURL})
				}
			case ir.PartText:
				if p.Text != "" {
					userParts = append(userParts, map[string]any{"type": "input_text", "text": p.Text})
				}
			}
		}
		flushUser()
	}
	out["input"] = items

	return &BuildResult{
		Body:           out,
		StrippedFields: req.StrippedFields,
	}, nil
}

// --- 3. Gemini / CRAGGemini Minimal 8-Key SHM Builder ---

// sanitizeGeminiSchemaPlain resolves $defs/$ref and removes keywords rejected by Gemini/Antigravity.
func sanitizeGeminiSchemaPlain(raw any, defs map[string]any, depth int) any {
	if depth > 16 {
		return map[string]any{"type": "object"}
	}
	m, ok := raw.(map[string]any)
	if !ok {
		if b, isBool := raw.(bool); isBool {
			if b {
				return map[string]any{}
			}
			return nil
		}
		return raw
	}
	if defs == nil {
		if d, ok := m["$defs"].(map[string]any); ok {
			defs = d
		} else if d, ok := m["definitions"].(map[string]any); ok {
			defs = d
		}
	}
	if ref, ok := m["$ref"].(string); ok && defs != nil {
		name := ref
		if idx := strings.LastIndex(ref, "/"); idx >= 0 {
			name = ref[idx+1:]
		}
		if target, exists := defs[name]; exists {
			return sanitizeGeminiSchemaPlain(target, defs, depth+1)
		}
		return map[string]any{"type": "object"}
	}
	out := map[string]any{}
	allowed := map[string]bool{
		"type": true, "description": true, "enum": true, "nullable": true,
		"required": true, "pattern": true, "minimum": true, "maximum": true,
		"minLength": true, "maxLength": true, "minItems": true, "maxItems": true,
		"format": true,
	}
	for k, v := range m {
		if allowed[k] {
			out[k] = v
		}
	}
	if props, ok := m["properties"].(map[string]any); ok {
		cleanProps := map[string]any{}
		for pk, pv := range props {
			if sp := sanitizeGeminiSchemaPlain(pv, defs, depth+1); sp != nil {
				cleanProps[pk] = sp
			}
		}
		out["properties"] = cleanProps
	}
	if items, exists := m["items"]; exists {
		out["items"] = sanitizeGeminiSchemaPlain(items, defs, depth+1)
	}
	if anyOf, ok := m["anyOf"].([]any); ok && out["type"] == nil {
		for _, opt := range anyOf {
			if om, ok := opt.(map[string]any); ok {
				if om["type"] == "null" {
					out["nullable"] = true
				} else if out["type"] == nil {
					cleaned, _ := sanitizeGeminiSchemaPlain(om, defs, depth+1).(map[string]any)
					for ck, cv := range cleaned {
						out[ck] = cv
					}
				}
			}
		}
	}
	if out["type"] == "array" && out["items"] == nil {
		out["items"] = map[string]any{"type": "string"}
	}
	return out
}

func buildGemini(req *ir.Request, opts BuildOptions) (*BuildResult, error) {
	isAG := opts.Target == ir.TargetGeminiAntigravity
	restore := req.RestoreContext
	if restore.ToolNameMap == nil {
		restore.ToolNameMap = map[string]string{}
	}
	out := map[string]any{}

	// systemInstruction
	if len(req.System) > 0 {
		parts := make([]map[string]any, 0, len(req.System))
		for _, sb := range req.System {
			if strings.TrimSpace(sb.Text) != "" {
				parts = append(parts, map[string]any{"text": sb.Text})
			}
		}
		if len(parts) > 0 {
			out["systemInstruction"] = map[string]any{"parts": parts}
		}
	}

	// contents
	contents := make([]map[string]any, 0, len(req.Messages))
	callNameByID := map[string]string{}
	for _, m := range req.Messages {
		role := "user"
		if m.Role == "assistant" {
			role = "model"
		}
		parts := make([]map[string]any, 0, len(m.Parts))
		for _, p := range m.Parts {
			switch p.Kind {
			case ir.PartText:
				if p.Text != "" {
					part := map[string]any{"text": p.Text}
					if p.Signature != "" {
						part["thoughtSignature"] = p.Signature
					}
					parts = append(parts, part)
				}
			case ir.PartThinking:
				if p.Text != "" || p.Signature != "" {
					part := map[string]any{"thought": true, "text": p.Text}
					if p.Signature != "" {
						part["thoughtSignature"] = p.Signature
					}
					parts = append(parts, part)
				}
			case ir.PartImage:
				if p.Data != "" {
					mt := p.MediaType
					if mt == "" {
						mt = "image/png"
					}
					parts = append(parts, map[string]any{
						"inlineData": map[string]any{"mimeType": mt, "data": p.Data},
					})
				} else if p.URL != "" {
					parts = append(parts, map[string]any{
						"fileData": map[string]any{"mimeType": p.MediaType, "fileUri": p.URL},
					})
				}
			case ir.PartToolCall:
				safeName := SanitizeGeminiFuncName(p.Name)
				if safeName != p.Name {
					restore.ToolNameMap[safeName] = p.Name
				}
				callNameByID[p.CallID] = safeName
				var args any = map[string]any{}
				if len(p.Args) > 0 {
					_ = json.Unmarshal(p.Args, &args)
				}
				fc := map[string]any{"name": safeName, "args": args}
				if p.CallID != "" {
					fc["id"] = p.CallID
				}
				part := map[string]any{"functionCall": fc}
				if p.Signature != "" {
					part["thoughtSignature"] = p.Signature
				}
				parts = append(parts, part)
			case ir.PartToolResult:
				fnName := SanitizeGeminiFuncName(p.Name)
				if fnName == "_x_tool" && callNameByID[p.CallID] != "" {
					fnName = callNameByID[p.CallID]
				}
				var respObj map[string]any
				if p.ResultText != "" && json.Unmarshal([]byte(p.ResultText), &respObj) == nil && respObj != nil {
					// Keep JSON object response
				} else {
					respObj = map[string]any{"result": p.ResultText}
				}
				fr := map[string]any{"name": fnName, "response": respObj}
				if p.CallID != "" {
					fr["id"] = p.CallID
				}
				parts = append(parts, map[string]any{"functionResponse": fr})
				for _, sp := range p.ResultParts {
					if sp.Kind == ir.PartImage && sp.Data != "" {
						parts = append(parts, map[string]any{
							"inlineData": map[string]any{"mimeType": sp.MediaType, "data": sp.Data},
						})
					}
				}
			}
		}
		if len(parts) > 0 {
			contents = append(contents, map[string]any{"role": role, "parts": parts})
		}
	}
	out["contents"] = contents

	// tools
	if len(req.Tools) > 0 {
		var funcDecls []map[string]any
		var extraTools []map[string]any
		for _, t := range req.Tools {
			switch t.Kind {
			case "google_search":
				extraTools = append(extraTools, map[string]any{"googleSearch": map[string]any{}})
			case "code_execution":
				extraTools = append(extraTools, map[string]any{"codeExecution": map[string]any{}})
			case "custom":
				safeName := SanitizeGeminiFuncName(t.Name)
				if safeName != t.Name {
					restore.ToolNameMap[safeName] = t.Name
				}
				var rawSchema any
				if len(t.Schema) > 0 {
					_ = json.Unmarshal(t.Schema, &rawSchema)
				}
				cleanedSchema := sanitizeGeminiSchemaPlain(rawSchema, nil, 0)
				fd := map[string]any{
					"name":        safeName,
					"description": t.Description,
					"parameters":  cleanedSchema,
				}
				funcDecls = append(funcDecls, fd)
			}
		}
		var toolsArr []map[string]any
		if len(funcDecls) > 0 {
			toolsArr = append(toolsArr, map[string]any{"functionDeclarations": funcDecls})
		}
		toolsArr = append(toolsArr, extraTools...)
		if len(toolsArr) > 0 {
			out["tools"] = toolsArr
		}
	}

	// toolConfig
	if req.ToolChoice != nil {
		fcc := map[string]any{}
		switch req.ToolChoice.Mode {
		case "none":
			fcc["mode"] = "NONE"
		case "any", "required":
			fcc["mode"] = "ANY"
		case "tool":
			fcc["mode"] = "ANY"
			if req.ToolChoice.Name != "" {
				safe := SanitizeGeminiFuncName(req.ToolChoice.Name)
				fcc["allowedFunctionNames"] = []string{safe}
			}
		default:
			fcc["mode"] = "AUTO"
		}
		out["toolConfig"] = map[string]any{"functionCallingConfig": fcc}
	}

	// generationConfig (strictly minimal on Antigravity SHM!)
	gc := map[string]any{}
	if req.Temperature != nil {
		gc["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		gc["topP"] = *req.TopP
	}
	if req.TopK != nil {
		gc["topK"] = *req.TopK
	}
	if req.MaxTokens != nil && *req.MaxTokens > 0 {
		gc["maxOutputTokens"] = *req.MaxTokens
		if isAG {
			restore.MaxOutputTokens = req.MaxTokens
		}
	}
	if len(req.Stop) > 0 {
		gc["stopSequences"] = req.Stop
		if isAG {
			restore.StopSequences = req.Stop
		}
	}
	if req.Format != nil {
		if isAG {
			restore.ResponseFormat = req.Format
		} else {
			gc["responseMimeType"] = "application/json"
			if len(req.Format.Schema) > 0 {
				var s any
				if json.Unmarshal(req.Format.Schema, &s) == nil {
					gc["responseSchema"] = sanitizeGeminiSchemaPlain(s, nil, 0)
				}
			}
		}
	}
	if req.Reasoning != nil {
		tc := map[string]any{}
		if req.Reasoning.Mode == "disabled" || req.Reasoning.Effort == "none" {
			tc["thinkingBudget"] = 0
		} else {
			if req.Reasoning.Budget != nil {
				tc["thinkingBudget"] = *req.Reasoning.Budget
			}
			if req.Reasoning.Effort != "" {
				tc["thinkingLevel"] = strings.ToUpper(req.Reasoning.Effort)
			}
			if req.Reasoning.IncludeThoughts != nil {
				tc["includeThoughts"] = *req.Reasoning.IncludeThoughts
			} else {
				tc["includeThoughts"] = true
			}
		}
		if len(tc) > 0 {
			gc["thinkingConfig"] = tc
		}
	}
	if len(gc) > 0 {
		out["generationConfig"] = gc
	}

	return &BuildResult{
		Body:           out,
		RestoreContext: restore,
		StrippedFields: req.StrippedFields,
	}, nil
}
