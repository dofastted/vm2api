// Package strip implements target-specific inbound fingerprint stripping and
// anti-collision normalization so caller identities, prompts, headers, and
// foreign thinking blobs never collide with native CLIs inside VMs (CRAG CC,
// CRAGGemini agy, and Codex kernel).
package strip

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/dofastted/kin-gateway/protofront/internal/detect"
	"github.com/dofastted/kin-gateway/protofront/internal/ir"
)

const (
	OfficialCCSystemLine     = "You are Claude Code, Anthropic's official CLI for Claude."
	OfficialAgentSDKLine     = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
	CompactIdentityLine      = "You are Anthropic Claude Agent SDK."
	StableContextBudgetTag   = "<total_tokens>15000000 tokens left</total_tokens>"
	DummyThinkingSignature   = "skip_thought_signature_validator"
	DualUseTriggerOriginal   = "Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context"
	DualUseTriggerNormalized = "Dual-use security tools require clear authorization context"
)

var (
	reBillingLine          = regexp.MustCompile(`(?i)^\s*x-anthropic-billing-header:`)
	reVolatileBudget       = regexp.MustCompile(`<total_tokens>\d+ tokens left</total_tokens>`)
	reFenceLine            = regexp.MustCompile("^\\s*(`{3,}|~{3,})")
	reDualUseParenthetical = regexp.MustCompile(`(?i)Dual-use security tools\s*\([^)]*C2 frameworks[^)]*\)\s*require clear authorization context`)
	reThirdPartyIdentity   = regexp.MustCompile(`(?im)^[^\n]*\bYou are (?:Claude Code|OpenCode|Codex|Cursor|Cline|Windsurf|Roo Code|Aider|oh-my-pi)\b[^\n]*$`)
	reHostXMLTag           = regexp.MustCompile(`(?i)<(/?)(antigravity|agy_internal|system_prompt_boundary)\b([^>]*)>`)
)

// --- 1. Claude CRAG Native CLI Anti-Collision Stripping ---

func stripBillingLines(text string) string {
	if !strings.Contains(strings.ToLower(text), "x-anthropic-billing-header:") {
		return text
	}
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		if reBillingLine.MatchString(line) {
			continue
		}
		out = append(out, line)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

func isCLIOwnedIdentityText(text string) bool {
	t := strings.TrimSpace(text)
	if t == "" {
		return true
	}
	if reBillingLine.MatchString(t) {
		return true
	}
	if t == OfficialCCSystemLine || t == OfficialAgentSDKLine || t == CompactIdentityLine {
		return true
	}
	if strings.HasPrefix(t, "You are Claude Code") {
		return true
	}
	return false
}

func stabilizeBudget(text string) string {
	if !strings.Contains(text, "<total_tokens>") {
		return text
	}
	return reVolatileBudget.ReplaceAllString(text, StableContextBudgetTag)
}

func hasUsableSignature(sig string) bool {
	s := strings.TrimSpace(sig)
	return len(s) >= 24 && s != DummyThinkingSignature
}

// ApplyClaudeCRAG strips colliding caller fingerprints from req in-place for CRAG native CLI.
// When decision.AllowPassthrough is true, caller system & cache breakpoints are preserved intact
// (validated only, never rewritten), while strictly blocking unsafe/unrepresentable fields.
func ApplyClaudeCRAG(req *ir.Request, decision detect.Decision, settings detect.WebSettings) error {
	// Fail closed on unrepresentable multi-candidate / sampling controls.
	if len(req.Unrepresentable) > 0 {
		first := req.Unrepresentable[0]
		return &ir.ProtocolError{
			Status:  400,
			Code:    "invalid_kernel_request",
			Type:    "invalid_request_error",
			Param:   first,
			Message: fmt.Sprintf("%s: unsupported request field for CRAG kernel", first),
		}
	}

	// Enforce claude_code_only gate before touching system or slots.
	if settings.Compatibility.ClaudeCodeOnly && !decision.OfficialClient {
		return &ir.ProtocolError{
			Status:  403,
			Code:    "claude_code_only",
			Type:    "permission_error",
			Message: "仅允许 Claude Code 家族请求",
		}
	}

	// Metadata is always owned by the VM/CRAG session boundary, never forwarded from caller.
	if req.Metadata != nil {
		req.Metadata = nil
		req.StrippedFields = append(req.StrippedFields, "metadata")
	}

	if decision.AllowPassthrough {
		// Official passthrough: validate cache breakpoints (max 4, 1h before 5m, none on thinking)
		// without mutating caller system, omitted TTLs, or thinking chains.
		return ValidateAnthropicCacheBreakpoints(req)
	}

	// Non-passthrough: strip caller billing headers, duplicate CLI identity, and stabilize volatile budget counters.
	cleanedSys := make([]ir.SystemBlock, 0, len(req.System))
	for _, blk := range req.System {
		txt := stripBillingLines(blk.Text)
		txt = stabilizeBudget(txt)
		if strings.TrimSpace(txt) == "" {
			continue
		}
		if isCLIOwnedIdentityText(txt) {
			req.StrippedFields = append(req.StrippedFields, "system.cli_identity")
			continue
		}
		cleanedSys = append(cleanedSys, ir.SystemBlock{Text: txt, CacheControl: blk.CacheControl})
	}
	req.System = cleanedSys

	// Third-party system relocation when claude_code_only is off and caller is unofficial:
	// move foreign system blocks ahead of first user turn so Anthropic OAuth never 400s on third-party system prompts.
	if !decision.OfficialClient && !settings.Compatibility.ClaudeCodeOnly && len(req.System) > 0 {
		movedParts := make([]ir.Part, 0, len(req.System))
		for _, sb := range req.System {
			movedParts = append(movedParts, ir.Part{
				Kind:         ir.PartText,
				Text:         sb.Text,
				CacheControl: sb.CacheControl,
			})
		}
		relocated := false
		for i := range req.Messages {
			if req.Messages[i].Role == "user" {
				req.Messages[i].Parts = append(movedParts, req.Messages[i].Parts...)
				relocated = true
				break
			}
		}
		if !relocated {
			req.Messages = append([]ir.Message{{Role: "user", Parts: movedParts}}, req.Messages...)
		}
		req.System = nil
		req.StrippedFields = append(req.StrippedFields, "system.relocated_third_party")
	}

	// Clean messages: stabilize budget counters, strip unsigned/dummy thinking blocks, strip cache_control on thinking.
	cleanedMsgs := make([]ir.Message, 0, len(req.Messages))
	for _, m := range req.Messages {
		parts := make([]ir.Part, 0, len(m.Parts))
		for _, p := range m.Parts {
			switch p.Kind {
			case ir.PartText:
				p.Text = stabilizeBudget(p.Text)
				parts = append(parts, p)
			case ir.PartThinking:
				p.CacheControl = nil
				if m.Role == "assistant" && hasUsableSignature(p.Signature) {
					parts = append(parts, p)
				} else {
					req.StrippedFields = append(req.StrippedFields, "thinking.unsigned_or_dummy")
				}
			case ir.PartRedactedThinking:
				p.CacheControl = nil
				if m.Role == "assistant" && strings.TrimSpace(p.Data) != "" {
					parts = append(parts, p)
				}
			default:
				parts = append(parts, p)
			}
		}
		if len(parts) > 0 || len(m.OutputConfig) > 0 || len(m.ClearAt) > 0 {
			m.Parts = parts
			cleanedMsgs = append(cleanedMsgs, m)
		}
	}
	req.Messages = cleanedMsgs

	// Fold mid-conversation role=system turns into adjacent user turns as <system-reminder>
	// for CRAG --resume cache prefix stability (mirrors crag-print-prompt.mjs:foldSystemTurns).
	fold := settings.Compatibility.CragFoldHistorySystem == nil || *settings.Compatibility.CragFoldHistorySystem
	if fold {
		req.Messages = foldHistorySystemMessages(req.Messages)
	}
	return ValidateAnthropicCacheBreakpoints(req)
}

func foldHistorySystemMessages(msgs []ir.Message) []ir.Message {
	hasSys := false
	for _, m := range msgs {
		if m.Role == "system" {
			hasSys = true
			break
		}
	}
	if !hasSys {
		return msgs
	}
	out := make([]ir.Message, 0, len(msgs))
	var pending []ir.Part
	for _, m := range msgs {
		if m.Role == "system" && len(m.ClearAt) == 0 {
			for _, p := range m.Parts {
				if p.Kind != ir.PartText || strings.TrimSpace(p.Text) == "" {
					continue
				}
				wrapped := p.Text
				if !strings.HasPrefix(strings.TrimSpace(wrapped), "<system-reminder>") {
					wrapped = "<system-reminder>\n" + wrapped + "\n</system-reminder>"
				}
				rem := ir.Part{Kind: ir.PartText, Text: wrapped, CacheControl: p.CacheControl}
				if len(pending) == 0 && len(out) > 0 && out[len(out)-1].Role == "user" {
					out[len(out)-1].Parts = append(out[len(out)-1].Parts, rem)
				} else {
					pending = append(pending, rem)
				}
			}
			continue
		}
		if len(pending) > 0 && m.Role == "user" {
			// Insert after leading tool_result blocks so Anthropic tool_result ordering stays valid.
			idx := 0
			for idx < len(m.Parts) && m.Parts[idx].Kind == ir.PartToolResult {
				idx++
			}
			merged := make([]ir.Part, 0, len(m.Parts)+len(pending))
			merged = append(merged, m.Parts[:idx]...)
			merged = append(merged, pending...)
			merged = append(merged, m.Parts[idx:]...)
			m.Parts = merged
			pending = nil
		}
		out = append(out, m)
	}
	if len(pending) > 0 {
		out = append(out, ir.Message{Role: "user", Parts: pending})
	}
	return out
}

// ValidateAnthropicCacheBreakpoints enforces the exact Anthropic/CRAG 4-breakpoint and 1h-before-5m contract.
func ValidateAnthropicCacheBreakpoints(req *ir.Request) error {
	count := 0
	sawShort := false
	visit := func(cc *ir.CacheControl, param string) error {
		if cc == nil {
			return nil
		}
		if cc.Type != "ephemeral" || (cc.TTL != "" && cc.TTL != "5m" && cc.TTL != "1h") {
			return &ir.ProtocolError{
				Status:  400,
				Code:    "invalid_cache_control",
				Type:    "invalid_request_error",
				Param:   param,
				Message: "Cache control must be ephemeral with an optional 5m or 1h TTL.",
			}
		}
		if sawShort && cc.TTL == "1h" {
			return &ir.ProtocolError{
				Status:  400,
				Code:    "invalid_cache_control",
				Type:    "invalid_request_error",
				Param:   param,
				Message: "Cache TTL must place 1h before 5m (including missing TTL).",
			}
		}
		if cc.TTL != "1h" {
			sawShort = true
		}
		count++
		if count > 4 {
			return &ir.ProtocolError{
				Status:  400,
				Code:    "invalid_cache_control",
				Type:    "invalid_request_error",
				Param:   param,
				Message: "Cache control exceeds four breakpoints.",
			}
		}
		return nil
	}
	for i, t := range req.Tools {
		if err := visit(t.CacheControl, fmt.Sprintf("tools[%d].cache_control", i)); err != nil {
			return err
		}
	}
	for i, sb := range req.System {
		if err := visit(sb.CacheControl, fmt.Sprintf("system[%d].cache_control", i)); err != nil {
			return err
		}
	}
	for i, m := range req.Messages {
		for j, p := range m.Parts {
			if (p.Kind == ir.PartThinking || p.Kind == ir.PartRedactedThinking) && p.CacheControl != nil {
				return &ir.ProtocolError{
					Status:  400,
					Code:    "invalid_cache_control",
					Type:    "invalid_request_error",
					Param:   fmt.Sprintf("messages[%d].content[%d].cache_control", i, j),
					Message: "Thinking blocks cannot carry cache_control.",
				}
			}
			if err := visit(p.CacheControl, fmt.Sprintf("messages[%d].content[%d].cache_control", i, j)); err != nil {
				return err
			}
		}
	}
	if req.AutomaticCacheControl != nil {
		if err := visit(req.AutomaticCacheControl, "cache_control"); err != nil {
			return err
		}
	}
	return nil
}

// --- 2. Gemini CRAGGemini (agy) Anti-Collision Normalizer ---

// NormalizeGeminiSystemText mirrors src/lib/gemini/prompt-normalizer.mjs:
// pure & idempotent across fenced code blocks; strips conflicting third-party CLI
// fingerprints and stock dual-use security enumerations that trigger Antigravity 429s.
func NormalizeGeminiSystemText(text, mode string, deconflictHostTags bool) (string, bool) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		mode = "auto"
	}
	if mode == "off" || text == "" {
		return text, false
	}

	lines := strings.Split(text, "\n")
	inFence := false
	fenceChar := byte(0)
	fenceLen := 0
	changed := false
	out := make([]string, 0, len(lines))

	for _, line := range lines {
		if m := reFenceLine.FindStringSubmatch(line); len(m) > 1 {
			marker := m[1]
			if !inFence {
				inFence = true
				fenceChar = marker[0]
				fenceLen = len(marker)
			} else if marker[0] == fenceChar && len(marker) >= fenceLen {
				inFence = false
			}
			out = append(out, line)
			continue
		}
		if inFence {
			out = append(out, line)
			continue
		}
		if reBillingLine.MatchString(line) {
			changed = true
			continue
		}
		next := line
		if reThirdPartyIdentity.MatchString(next) {
			next = reThirdPartyIdentity.ReplaceAllString(next, "You are an AI coding assistant.")
			if next != line {
				changed = true
			}
		}
		if reDualUseParenthetical.MatchString(next) {
			next = reDualUseParenthetical.ReplaceAllString(next, DualUseTriggerNormalized)
			changed = true
		}
		if deconflictHostTags && reHostXMLTag.MatchString(next) {
			next = reHostXMLTag.ReplaceAllString(next, "[$1$2$3]")
			changed = true
		}
		out = append(out, next)
	}
	return strings.TrimSpace(strings.Join(out, "\n")), changed
}

// EscapeLeadingSlash inserts U+200B before a leading '/' command so native agy TUI
// does not intercept caller text as a host slash command.
func EscapeLeadingSlash(text string) (string, bool) {
	if !strings.HasPrefix(text, "/") || strings.HasPrefix(text, "\u200b/") {
		return text, false
	}
	return "\u200b" + text, true
}

// ApplyGeminiAntigravity normalizes system & user text inside req for CRAGGemini SHM.
func ApplyGeminiAntigravity(req *ir.Request, settings detect.WebSettings) {
	mode := strings.ToLower(strings.TrimSpace(settings.Compatibility.CragGeminiPromptNormalization))
	if mode == "" {
		mode = "auto"
	}
	deconflict := mode == "strict" || mode == "auto"

	// Prepend optional global system prompt from Web Settings.
	globalPrompt := strings.TrimSpace(settings.Compatibility.CragGeminiSystemPrompt)
	if globalPrompt != "" {
		req.System = append([]ir.SystemBlock{{Text: globalPrompt}}, req.System...)
	}

	if mode != "off" {
		cleanedSys := make([]ir.SystemBlock, 0, len(req.System))
		for _, sb := range req.System {
			norm, changed := NormalizeGeminiSystemText(sb.Text, mode, deconflict)
			if changed {
				req.StrippedFields = append(req.StrippedFields, "gemini.system_fingerprint")
			}
			if norm != "" {
				cleanedSys = append(cleanedSys, ir.SystemBlock{Text: norm})
			}
		}
		req.System = cleanedSys

		for i := range req.Messages {
			for j := range req.Messages[i].Parts {
				p := &req.Messages[i].Parts[j]
				if p.Kind != ir.PartText {
					continue
				}
				if escaped, ok := EscapeLeadingSlash(p.Text); ok {
					p.Text = escaped
					req.StrippedFields = append(req.StrippedFields, "gemini.slash_escaped")
				}
				if deconflict && reHostXMLTag.MatchString(p.Text) {
					p.Text = reHostXMLTag.ReplaceAllString(p.Text, "[$1$2$3]")
					req.StrippedFields = append(req.StrippedFields, "gemini.host_tag_deconflicted")
				}
			}
		}
	}
}

// --- 3. Codex Kernel Anti-Collision Stripping ---

var codexIdentityTopKeys = []string{
	"base_url",
	"custom_base_url",
	"endpoint",
	"hostname",
	"api_key",
	"authorization",
	"client_metadata",
}

var codexHeaderAllowlist = map[string]bool{
	"openai-beta":                            true,
	"session-id":                             true,
	"thread-id":                              true,
	"x-client-request-id":                    true,
	"x-codex-beta-features":                  true,
	"x-codex-installation-id":                true,
	"x-codex-parent-thread-id":               true,
	"x-codex-turn-metadata":                  true,
	"x-codex-turn-state":                     true,
	"x-codex-window-id":                      true,
	"x-openai-internal-codex-responses-lite": true,
	"x-openai-memgen-request":                true,
	"x-openai-subagent":                      true,
}

// SanitizeCodexBody strips caller identity fields, unsupported Codex parameters,
// magpie-claude1 sealed reasoning items, normalizes string input / system->developer /
// fast->priority tier, and enforces outbound_session rebuild (prompt_cache_key = outboundSessionID).
func SanitizeCodexBody(body map[string]any, settings detect.WebSettings, outboundSessionID string) (map[string]any, []string) {
	return sanitizeCodexBodyWithMode(body, settings, outboundSessionID, true)
}

// SanitizeOpenAIAPIBody strips claudeseal reasoning items while preserving API-supported fields
// like max_output_tokens, temperature, and top_p.
func SanitizeOpenAIAPIBody(body map[string]any) (map[string]any, []string) {
	return sanitizeCodexBodyWithMode(body, detect.WebSettings{}, "", false)
}

func sanitizeCodexBodyWithMode(body map[string]any, settings detect.WebSettings, outboundSessionID string, isCodexKernel bool) (map[string]any, []string) {
	out := make(map[string]any, len(body))
	for k, v := range body {
		out[k] = v
	}
	var stripped []string
	for _, k := range codexIdentityTopKeys {
		if _, exists := out[k]; exists {
			delete(out, k)
			stripped = append(stripped, k)
		}
	}
	if isCodexKernel {
		// Normalize fast alias tier and drop Codex-unsupported sampling/token limits.
		if tier, ok := out["service_tier"].(string); ok && strings.EqualFold(strings.TrimSpace(tier), "fast") {
			out["service_tier"] = "priority"
		}
		for _, k := range []string{"max_output_tokens", "max_completion_tokens", "max_tokens", "temperature", "prompt_cache_retention", "reasoning_effort"} {
			if _, exists := out[k]; exists {
				if k == "reasoning_effort" {
					if eff, ok := out[k].(string); ok && strings.TrimSpace(eff) != "" && out["reasoning"] == nil {
						low := strings.ToLower(strings.TrimSpace(eff))
						if low != "none" && low != "off" {
							out["reasoning"] = map[string]any{"effort": low}
						}
					}
				}
				delete(out, k)
				stripped = append(stripped, k)
			}
		}
		if rMap, ok := out["reasoning"].(map[string]any); ok {
			if eff, _ := rMap["effort"].(string); strings.TrimSpace(eff) == "" || strings.EqualFold(strings.TrimSpace(eff), "none") || strings.EqualFold(strings.TrimSpace(eff), "off") {
				delete(out, "reasoning")
			}
		}
		// ChatGPT Codex rejects raw string input; normalize to message array.
		if s, ok := out["input"].(string); ok {
			out["input"] = []any{
				map[string]any{
					"type":    "message",
					"role":    "user",
					"content": []any{map[string]any{"type": "input_text", "text": s}},
				},
			}
		}
	}
	if meta, ok := out["metadata"].(map[string]any); ok {
		cleanMeta := make(map[string]any, len(meta))
		for k, v := range meta {
			if k == "user_id" || k == "device_id" || k == "installation_id" {
				stripped = append(stripped, "metadata."+k)
				continue
			}
			cleanMeta[k] = v
		}
		if len(cleanMeta) > 0 {
			out["metadata"] = cleanMeta
		} else {
			delete(out, "metadata")
		}
	}
	// Strip magpie-claude1 / anthropic-thinking-v1 sealed reasoning items and map system->developer.
	if inp, ok := out["input"].([]any); ok {
		kept := make([]any, 0, len(inp))
		for _, item := range inp {
			if m, ok := item.(map[string]any); ok {
				if m["type"] == "reasoning" {
					if enc, _ := m["encrypted_content"].(string); ir.IsClaudeSeal(enc) {
						stripped = append(stripped, "input.reasoning.claudeseal")
						continue
					}
				}
				if isCodexKernel && m["type"] == "message" && m["role"] == "system" {
					cp := make(map[string]any, len(m))
					for mk, mv := range m {
						cp[mk] = mv
					}
					cp["role"] = "developer"
					kept = append(kept, cp)
					continue
				}
			}
			kept = append(kept, item)
		}
		out["input"] = kept
	}
	// Session rebuild unless explicitly configured as passthrough.
	mode := strings.ToLower(strings.TrimSpace(settings.Sticky.OutboundSession))
	if mode == "" {
		mode = "rebuild"
	}
	if isCodexKernel && mode == "rebuild" && outboundSessionID != "" {
		out["prompt_cache_key"] = outboundSessionID
		if _, ok := out["conversation_id"]; ok {
			delete(out, "conversation_id")
			stripped = append(stripped, "conversation_id")
		}
		if _, ok := out["session_id"]; ok {
			delete(out, "session_id")
			stripped = append(stripped, "session_id")
		}
	}
	return out, stripped
}

// FilterCodexHeaders applies the strict CODEX_KERNEL_HEADER_ALLOWLIST + routing hint.
func FilterCodexHeaders(headers map[string]string, body map[string]any, outboundSessionID string) map[string]string {
	out := map[string]string{}
	for k, v := range headers {
		lk := strings.ToLower(k)
		if codexHeaderAllowlist[lk] && strings.TrimSpace(v) != "" {
			out[lk] = strings.TrimSpace(v)
		}
	}
	if outboundSessionID != "" {
		out["session-id"] = outboundSessionID
	}
	if model, _ := body["model"].(string); strings.TrimSpace(model) != "" {
		model = strings.TrimSpace(model)
		tier, _ := body["service_tier"].(string)
		tier = strings.ToLower(strings.TrimSpace(tier))
		if tier != "" && tier != "default" && tier != "standard" && tier != "auto" {
			out["x-codex-routing-hint"] = fmt.Sprintf("model=%s;tier=%s", model, tier)
		} else {
			out["x-codex-routing-hint"] = fmt.Sprintf("model=%s", model)
		}
	}
	return out
}

// MustJSON helper for tests / serialization checks.
func MustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
