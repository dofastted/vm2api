// Package detect implements official client recognition and the Web-Settings-driven
// double-gate passthrough decision:
//
//	AllowPassthrough = (WebSettingSwitch == ON) && (InboundProtocol == TargetProtocol) && (VerifiedOfficialBody == true)
//
// Cross-protocol requests, unofficial/third-party clients, and spoofed clients
// MUST NEVER passthrough.
package detect

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/dofastted/kin-gateway/protofront/internal/ir"
)

// WebSettings mirrors the relevant subset of vm2api routing.json / panel settings.
type WebSettings struct {
	Compatibility struct {
		OfficialCCPassthrough         bool   `json:"official_cc_passthrough"`
		DetectProxiedOfficialCC       *bool  `json:"detect_proxied_official_cc"`
		ClaudeCodeOnly                bool   `json:"claude_code_only"`
		CragPersonaPreset             string `json:"crag_persona_preset"`
		PersonaPreset                 string `json:"persona_preset"`
		CragGeminiPersonaPreset       string `json:"craggemini_persona_preset"`
		CragGeminiSystemPrompt        string `json:"craggemini_system_prompt"`
		CragGeminiPromptNormalization string `json:"craggemini_prompt_normalization"`
		CacheTTL                      string `json:"cache_ttl"`
		CragFoldHistorySystem         *bool  `json:"crag_fold_history_system"`
	} `json:"compatibility"`
	Codex struct {
		Enabled             *bool                           `json:"enabled"`
		OfficialPassthrough *bool                           `json:"official_passthrough"`
		Protocols           map[string]ProtocolRouteSetting `json:"protocols"`
		Clients             map[string]string               `json:"clients"`
	} `json:"codex"`
	Gemini struct {
		Enabled             *bool                           `json:"enabled"`
		OfficialPassthrough *bool                           `json:"official_passthrough"`
		Protocols           map[string]ProtocolRouteSetting `json:"protocols"`
	} `json:"gemini"`
	Sticky struct {
		OutboundSession string `json:"outbound_session"` // rebuild (default) | passthrough
	} `json:"sticky"`
	EndpointBodyPolicy string `json:"endpoint_body_policy"` // default | caller
}

type ProtocolRouteSetting struct {
	Mode    string `json:"mode"` // native | convert | reject
	Enabled *bool  `json:"enabled"`
}

// Decision captures client classification and the final passthrough verdict.
type Decision struct {
	ClientClass      string `json:"client_class"`
	OfficialClient   bool   `json:"official_client"`
	WebSwitchEnabled bool   `json:"web_switch_enabled"`
	SameProtocol     bool   `json:"same_protocol"`
	AllowPassthrough bool   `json:"allow_passthrough"`
	Reason           string `json:"reason"`
}

var (
	reClaudeCLIUA       = regexp.MustCompile(`(?i)^claude-cli/\d+\.\d+\.\d+`)
	reOfficialCodexUA   = regexp.MustCompile(`(?i)(?:^|[^\w-])codex(?:_cli_rs|_cli|_exec|_vscode)?(?:/|\s|$)`)
	reOfficialCodexOrig = regexp.MustCompile(`(?i)^codex(?:_cli_rs|_exec|_vscode)?$`)
	reClaudeCodeUA      = regexp.MustCompile(`(?i)claude-cli|claude-code|anthropic-ai/sdk`)
	reOpenAISDKUA       = regexp.MustCompile(`(?i)openai/|openai-node|openai-python|ChatGPT-User`)
	reOhMyPiUA          = regexp.MustCompile(`(?i)oh-my-pi|\bomp/`)
	reBillingEntrypoint = regexp.MustCompile(`(?i)x-anthropic-billing-header:.*cc_entrypoint=`)
	reThirdPartyCLI     = regexp.MustCompile(`(?i)You are Claude Code\b|You are OpenCode\b|You are Codex\b|x-anthropic-billing-header:`)
	reHex64             = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)
	reUUID              = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

func headerVal(headers map[string]string, name string) string {
	want := strings.ToLower(name)
	for k, v := range headers {
		if strings.ToLower(k) == want {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func systemTextsFromMap(raw map[string]any) []string {
	var out []string
	sys := raw["system"]
	switch v := sys.(type) {
	case string:
		if strings.TrimSpace(v) != "" {
			out = append(out, v)
		}
	case []any:
		for _, item := range v {
			switch b := item.(type) {
			case string:
				if strings.TrimSpace(b) != "" {
					out = append(out, b)
				}
			case map[string]any:
				if txt, ok := b["text"].(string); ok && strings.TrimSpace(txt) != "" {
					out = append(out, txt)
				}
			}
		}
	case map[string]any:
		if txt, ok := v["text"].(string); ok && strings.TrimSpace(txt) != "" {
			out = append(out, txt)
		}
	}
	if si, ok := raw["systemInstruction"].(map[string]any); ok {
		if parts, ok := si["parts"].([]any); ok {
			for _, p := range parts {
				if pm, ok := p.(map[string]any); ok {
					if txt, ok := pm["text"].(string); ok && strings.TrimSpace(txt) != "" {
						out = append(out, txt)
					}
				}
			}
		}
	}
	return out
}

func looksLikeOhMyPi(headers map[string]string, sysTexts []string) bool {
	if reOhMyPiUA.MatchString(headerVal(headers, "user-agent")) {
		return true
	}
	for _, t := range sysTexts {
		low := strings.ToLower(t)
		if strings.Contains(low, "oh-my-pi") || strings.Contains(low, "inside omp") || strings.Contains(low, "running inside omp") {
			return true
		}
	}
	return false
}

func isValidOfficialCCUserID(raw map[string]any) bool {
	meta, ok := raw["metadata"].(map[string]any)
	if !ok {
		return false
	}
	uid, ok := meta["user_id"].(string)
	if !ok || strings.TrimSpace(uid) == "" {
		return false
	}
	uid = strings.TrimSpace(uid)
	if strings.HasPrefix(uid, "{") {
		var parsed map[string]any
		if err := json.Unmarshal([]byte(uid), &parsed); err != nil {
			return false
		}
		dev, _ := parsed["device_id"].(string)
		sess, _ := parsed["session_id"].(string)
		return reHex64.MatchString(dev) && reUUID.MatchString(sess)
	}
	// Legacy format: user_<64hex>_account_<uuid>_session_<uuid>
	if strings.HasPrefix(uid, "user_") && strings.Contains(uid, "_session_") {
		return len(uid) >= 80
	}
	return false
}

func hasOpenAIToolShape(raw map[string]any) bool {
	tools, ok := raw["tools"].([]any)
	if !ok {
		return false
	}
	for _, item := range tools {
		tm, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if tm["type"] == "function" || tm["function"] != nil || tm["parameters"] != nil {
			return true
		}
	}
	return false
}

func hasOfficialCCSystem(sysTexts []string) bool {
	for _, t := range sysTexts {
		trimmed := strings.TrimSpace(t)
		if strings.HasPrefix(trimmed, "You are Claude Code, Anthropic's official CLI for Claude") ||
			strings.HasPrefix(trimmed, "You are a Claude agent, built on Anthropic's Claude Agent SDK") ||
			strings.HasPrefix(trimmed, "You are an interactive CLI tool that helps users") ||
			strings.HasPrefix(trimmed, "You are a file search specialist for Claude Code") ||
			strings.HasPrefix(trimmed, "You are a helpful AI assistant tasked with summarizing conversations") ||
			strings.HasPrefix(trimmed, "You are a security monitor for autonomous AI coding agents.") ||
			reBillingEntrypoint.MatchString(trimmed) {
			return true
		}
	}
	return false
}

func hasOfficialCCBillingBlock(sysTexts []string) bool {
	for _, t := range sysTexts {
		if reBillingEntrypoint.MatchString(t) {
			return true
		}
	}
	return false
}

func hasBetaToken(headers map[string]string, token string) bool {
	raw := headerVal(headers, "anthropic-beta")
	for _, part := range strings.Split(raw, ",") {
		if strings.TrimSpace(part) == token {
			return true
		}
	}
	return false
}

// IsOfficialClaudeCode mirrors crs-persona.mjs:isOfficialClaudeCodeTraffic (4-gate check).
func IsOfficialClaudeCode(headers map[string]string, raw map[string]any) bool {
	ua := headerVal(headers, "user-agent")
	if !reClaudeCLIUA.MatchString(ua) {
		return false
	}
	sysTexts := systemTextsFromMap(raw)
	if looksLikeOhMyPi(headers, sysTexts) {
		return false
	}
	if !isValidOfficialCCUserID(raw) {
		return false
	}
	if hasOpenAIToolShape(raw) {
		return false
	}
	return hasOfficialCCSystem(sysTexts)
}

// IsProxiedOfficialClaudeCode mirrors crs-persona.mjs:isProxiedOfficialClaudeCode.
func IsProxiedOfficialClaudeCode(headers map[string]string, raw map[string]any) bool {
	sysTexts := systemTextsFromMap(raw)
	if looksLikeOhMyPi(headers, sysTexts) {
		return false
	}
	if hasOpenAIToolShape(raw) {
		return false
	}
	if hasOfficialCCBillingBlock(sysTexts) {
		return true
	}
	if !isValidOfficialCCUserID(raw) {
		return false
	}
	return hasBetaToken(headers, "claude-code-20250219") && hasOfficialCCSystem(sysTexts)
}

// ClassifyCodexClient mirrors codex-restriction.mjs:classifyCodexClient.
func ClassifyCodexClient(headers map[string]string, raw map[string]any, proto ir.Protocol) string {
	ua := headerVal(headers, "user-agent")
	if reClaudeCodeUA.MatchString(ua) {
		return "claude_code"
	}
	orig := headerVal(headers, "originator")
	if reOfficialCodexUA.MatchString(ua) ||
		reOfficialCodexOrig.MatchString(orig) ||
		headerVal(headers, "x-codex-installation-id") != "" ||
		headerVal(headers, "session-id") != "" {
		return "official_codex"
	}
	if reOpenAISDKUA.MatchString(ua) ||
		headerVal(headers, "openai-beta") != "" ||
		raw["messages"] != nil ||
		raw["input"] != nil ||
		strings.HasPrefix(string(proto), "openai.") {
		return "openai_compatible"
	}
	return "unknown"
}

// IsOfficialGeminiBody checks that a Google Gemini request is genuinely native Gemini
// and does not carry conflicting third-party CLI identity declarations.
func IsOfficialGeminiBody(headers map[string]string, raw map[string]any) bool {
	if _, ok := raw["contents"].([]any); !ok {
		return false
	}
	ua := strings.ToLower(headerVal(headers, "user-agent"))
	if strings.Contains(ua, "claude-cli") || strings.Contains(ua, "opencode") || strings.Contains(ua, "codex") {
		return false
	}
	for _, txt := range systemTextsFromMap(raw) {
		if reThirdPartyCLI.MatchString(txt) {
			return false
		}
	}
	return true
}

// Evaluate applies the strict Web Settings + Official Body double-gate for any target.
func Evaluate(proto ir.Protocol, target ir.Target, headers map[string]string, raw map[string]any, settings WebSettings) Decision {
	sameProto := proto == target.WireProtocol()
	switch target {
	case ir.TargetClaudeCRAG, ir.TargetClaudeCliNode:
		detectProxied := settings.Compatibility.DetectProxiedOfficialCC == nil || *settings.Compatibility.DetectProxiedOfficialCC
		official := sameProto && (IsOfficialClaudeCode(headers, raw) || (detectProxied && IsProxiedOfficialClaudeCode(headers, raw)))
		clientClass := "third_party"
		if official {
			clientClass = "claude_code_official"
		} else if looksLikeOhMyPi(headers, systemTextsFromMap(raw)) {
			clientClass = "oh_my_pi"
		}
		webOn := settings.Compatibility.OfficialCCPassthrough
		allow := webOn && sameProto && official
		reason := "ir_normalize"
		switch {
		case !sameProto:
			reason = "cross_protocol_forbids_passthrough"
		case !official:
			reason = "unofficial_body_forbids_passthrough"
		case !webOn:
			reason = "web_setting_official_cc_passthrough_off"
		default:
			reason = "official_cc_passthrough"
		}
		return Decision{
			ClientClass:      clientClass,
			OfficialClient:   official,
			WebSwitchEnabled: webOn,
			SameProtocol:     sameProto,
			AllowPassthrough: allow,
			Reason:           reason,
		}

	case ir.TargetCodexKernel:
		cls := ClassifyCodexClient(headers, raw, proto)
		official := sameProto && cls == "official_codex"
		// Default to native mode check when explicit official_passthrough is omitted;
		// third-party openai_compatible NEVER passes through as official!
		webOn := false
		if settings.Codex.OfficialPassthrough != nil {
			webOn = *settings.Codex.OfficialPassthrough
		} else {
			entry, exists := settings.Codex.Protocols[string(ir.ProtoResponses)]
			if !exists || (entry.Mode != "reject" && entry.Mode != "convert" && (entry.Enabled == nil || *entry.Enabled)) {
				webOn = true
			}
		}
		allow := webOn && sameProto && official
		reason := "ir_normalize"
		switch {
		case !sameProto:
			reason = "cross_protocol_forbids_passthrough"
		case !official:
			reason = "unofficial_codex_forbids_passthrough"
		case !webOn:
			reason = "web_setting_codex_passthrough_off"
		default:
			reason = "official_codex_passthrough"
		}
		return Decision{
			ClientClass:      cls,
			OfficialClient:   official,
			WebSwitchEnabled: webOn,
			SameProtocol:     sameProto,
			AllowPassthrough: allow,
			Reason:           reason,
		}

	case ir.TargetGeminiAntigravity, ir.TargetGeminiAPI:
		official := sameProto && IsOfficialGeminiBody(headers, raw)
		cls := "third_party"
		if official {
			cls = "official_gemini"
		}
		webOn := false
		if settings.Gemini.OfficialPassthrough != nil {
			webOn = *settings.Gemini.OfficialPassthrough
		} else {
			entry, exists := settings.Gemini.Protocols[string(ir.ProtoGemini)]
			if !exists || (entry.Mode != "reject" && entry.Mode != "convert" && (entry.Enabled == nil || *entry.Enabled)) {
				webOn = true
			}
		}
		// Note: even when AllowPassthrough is true for Antigravity SHM, the minimal 8-key SHM
		// projection and configured prompt normalization still run at the native CLI boundary.
		allow := webOn && sameProto && official
		reason := "ir_normalize"
		switch {
		case !sameProto:
			reason = "cross_protocol_forbids_passthrough"
		case !official:
			reason = "unofficial_gemini_forbids_passthrough"
		case !webOn:
			reason = "web_setting_gemini_passthrough_off"
		default:
			reason = "official_gemini_passthrough"
		}
		return Decision{
			ClientClass:      cls,
			OfficialClient:   official,
			WebSwitchEnabled: webOn,
			SameProtocol:     sameProto,
			AllowPassthrough: allow,
			Reason:           reason,
		}

	case ir.TargetAPIAnthropic:
		detectProxied := settings.Compatibility.DetectProxiedOfficialCC == nil || *settings.Compatibility.DetectProxiedOfficialCC
		official := sameProto && (IsOfficialClaudeCode(headers, raw) || (detectProxied && IsProxiedOfficialClaudeCode(headers, raw)))
		callerOptIn := settings.EndpointBodyPolicy == "caller"
		webOn := callerOptIn || settings.Compatibility.OfficialCCPassthrough
		allow := sameProto && ((callerOptIn && (official || raw["messages"] != nil)) || (settings.Compatibility.OfficialCCPassthrough && official))
		return Decision{
			ClientClass:      map[bool]string{true: "claude_code_official", false: "api_caller"}[official],
			OfficialClient:   official,
			WebSwitchEnabled: webOn,
			SameProtocol:     sameProto,
			AllowPassthrough: allow,
			Reason:           map[bool]string{true: "api_caller_passthrough", false: "api_ir_normalize"}[allow],
		}

	case ir.TargetAPIOpenAI, ir.TargetAPIGemini:
		webOn := settings.EndpointBodyPolicy == "caller"
		allow := webOn && sameProto
		return Decision{
			ClientClass:      "api_caller",
			OfficialClient:   sameProto,
			WebSwitchEnabled: webOn,
			SameProtocol:     sameProto,
			AllowPassthrough: allow,
			Reason:           map[bool]string{true: "api_caller_passthrough", false: "api_ir_normalize"}[allow],
		}
	}
	return Decision{ClientClass: "unknown", SameProtocol: sameProto, Reason: "ir_normalize"}
}
