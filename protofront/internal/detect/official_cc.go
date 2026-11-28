package detect

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf16"
)

const (
	fingerprintSalt              = "59cf53e54c78"
	securityMonitorPrefix        = "You are a security monitor for autonomous AI coding agents."
	securityMonitorMinLen        = 10_000
	maxUserIDJSONBytes           = 512
	zeroDeviceID64               = "0000000000000000000000000000000000000000000000000000000000000000"
	zeroUUID                     = "00000000-0000-0000-0000-000000000000"
	officialCCBetaToken          = "claude-code-20250219"
	officialInterleavedBetaToken = "interleaved-thinking-2025-05-14"
)

// OfficialCCVerdict captures the structured multi-signal verification outcome
// for an Anthropic Messages request (strict parity with official-cc-verifier.mjs).
type OfficialCCVerdict struct {
	Tier                string   `json:"tier"`
	Official            bool     `json:"official"`
	Direct              bool     `json:"direct"`
	Proxied             bool     `json:"proxied"`
	Auxiliary           bool     `json:"auxiliary"`
	AllowPassthrough    bool     `json:"allow_passthrough"`
	HasForeignSystem    bool     `json:"has_foreign_system"`
	HasNonOfficialTools bool     `json:"has_non_official_tools"`
	CloneID             string   `json:"clone_id,omitempty"`
	FailReasons         []string `json:"fail_reasons,omitempty"`
}

type parsedUserID struct {
	DeviceID        string
	AccountUUID     string
	SessionID       string
	ParentSessionID string
	RootSessionID   string
}

type parsedBillingHeader struct {
	Present           bool
	Valid             bool
	UnanchoredBilling bool
	Version           string
	FP3               string
	Entrypoint        string
	CCH               string
	FailReason        string
}

var (
	reStrictClaudeCLIUA      = regexp.MustCompile(`^claude-cli/(\d+\.\d+\.\d+) \(external, ([a-z0-9_-]+)(?:,\s*(?:agent-sdk|client-app|workload)/[^\s,)]+)*\)$`)
	reDesktopAgentSDKInUA    = regexp.MustCompile(`(?:,\s*|\s)agent-sdk/\d+\.\d+\.\d+(?:[,)])`)
	reSemverExact            = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
	reStainlessOS            = regexp.MustCompile(`^(?:Linux|MacOS|Windows|Other)$`)
	reStainlessArch          = regexp.MustCompile(`^(?:x64|arm64|x32|other)$`)
	reStainlessRuntime       = regexp.MustCompile(`^(?:node|bun|deno)$`)
	reStainlessRuntimeVer    = regexp.MustCompile(`^v?\d+\.\d+(?:\.\d+.*)?$`)
	reStainlessPkgVer        = regexp.MustCompile(`^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$`)
	reDigitsOnly             = regexp.MustCompile(`^\d+$`)
	reHex64Lower             = regexp.MustCompile(`^[0-9a-f]{64}$`)
	reUUIDv4                 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	reUUIDAny                = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	reLegacyOfficialUserID   = regexp.MustCompile(`^user_([0-9a-f]{64})_account_([0-9a-f-]*)_session_([0-9a-f-]{36})$`)
	reAnchoredBillingLine    = regexp.MustCompile(`(?i)^[ \t]*x-anthropic-billing-header:\s*(.+)$`)
	reAnyBillingMention      = regexp.MustCompile(`(?i)x-anthropic-billing-header`)
	reEnvHeadingLine         = regexp.MustCompile(`(?m)^[ \t]*# Environment\b`)
	reBillingCCVersionToken  = regexp.MustCompile(`\bcc_version=([^;\s]+)`)
	reBillingCCVersionStrict = regexp.MustCompile(`^(\d+\.\d+\.\d+)(?:\.([0-9a-f]{3}))?$`)
	reBillingCCEntryToken    = regexp.MustCompile(`\bcc_entrypoint=([a-z0-9_-]+)(?:;|\s|$)`)
	reBillingCCHToken        = regexp.MustCompile(`(?i)\bcch=([^;\s]*)`)
	reCCH5Hex                = regexp.MustCompile(`^[0-9a-f]{5}$`)
	reServerToolType         = regexp.MustCompile(`^(?:(?:web_search|web_fetch|code_execution|text_editor|computer|bash|memory|advisor)_\d+|tool_search_tool_[a-z0-9_]+|str_replace_based_edit_tool)$`)
	reWebSearchServerType    = regexp.MustCompile(`^web_search_\d+$`)
	reOfficialMCPTool        = regexp.MustCompile(`^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.:-]+$`)

	// Clone / third-party harness signatures (applied to zero-width-stripped text).
	reCloneOmpUA         = regexp.MustCompile(`(?i)oh-my-pi|\bomp/`)
	reCloneOmpSystem     = regexp.MustCompile(`(?i)oh-my-pi|\boh my pi\b|\bpi coding harness\b|\bomp coding harness\b|inside omp|running inside omp`)
	reCloneOmpTrusted    = regexp.MustCompile(`(?im)^You are omp['’]s trusted coding assistant\.?\s*$`)
	reCloneOmpRole       = regexp.MustCompile(`(?m)^ROLE\s*\n\s*=+`)
	reCloneOmpProject    = regexp.MustCompile(`(?m)^PROJECT\s*\n\s*=+`)
	reCloneRFC2119       = regexp.MustCompile(`(?i)RFC 2119 keywords:\s*MUST,\s*REQUIRED`)
	reCloneLocalAgentEP  = regexp.MustCompile(`(?i)\bcc_entrypoint\s*=\s*local-agent\b`)
	reCloneOpenClawUA    = regexp.MustCompile(`(?i)\b(?:openclaw|clawdbot|moltbot)\b`)
	reCloneOpenClawSys   = regexp.MustCompile(`(?i)\brunning inside OpenClaw\b|(?m)^## OpenClaw Control\b|"schema"\s*:\s*"openclaw\.inbound_meta\.|\bdocs\.openclaw\.ai\b`)
	reCloneOpenCodeUA    = regexp.MustCompile(`(?i)\bopencode\b`)
	reCloneOpenCodeSys   = regexp.MustCompile(`(?im)^You are OpenCode\b`)
	reClonePiSys         = regexp.MustCompile(`(?i)a coding assistant running inside pi\b`)
	reCloneHermesUA      = regexp.MustCompile(`(?i)hermes-agent|\bhermes/`)
	reCloneHermesSys     = regexp.MustCompile(`(?i)\bYou are Hermes Agent\b|an intelligent AI assistant (?:created|built) by Nous Research|\bNous Research\b`)
	reCloneCodexUA       = regexp.MustCompile(`(?i)\bcodex_cli_rs\b|\bcodex_cli\b`)
	reCloneCodexSys      = regexp.MustCompile(`(?i)\bYou are Codex,\s*an? (?:coding )?agent based on GPT-|You are a coding agent running in the Codex CLI\b`)
	reCloneClineRooKilo  = regexp.MustCompile(`(?im)^You are (?:Cline|Roo|Kilo Code)\b`)
	reCloneDeepSeekSys   = regexp.MustCompile(`(?i)\bpowered by DeepSeek Harness\b`)
	reCloneKeliAgentSys  = regexp.MustCompile(`(?i)你是\s*Keli Agent\b|\bYou are Keli Agent\b`)
	reCloneToonflowSys   = regexp.MustCompile(`(?i)你是\s*Toonflow\b|\bYou are Toonflow\b`)
	reOfficialChildTitle = regexp.MustCompile(`^You write short session titles\b`)
	reLeadingSysReminder = regexp.MustCompile(`(?is)^(?:\s*<system-reminder>[\s\S]*?</system-reminder>\s*)+`)
)

// officialClaudeCodeToolNames is the strict case-sensitive PascalCase built-in allowlist
// covering all live 2.1.321–2.1.332 CC built-ins plus cli-node built-ins.
var officialClaudeCodeToolNames = map[string]struct{}{
	"Agent":                   {},
	"Artifact":                {},
	"AskUserQuestion":         {},
	"Bash":                    {},
	"BashOutput":              {},
	"Brief":                   {},
	"Config":                  {},
	"CronCreate":              {},
	"CronDelete":              {},
	"CronList":                {},
	"CtxInspect":              {},
	"DeferredToolPlaceholder": {},
	"DesignSync":              {},
	"Edit":                    {},
	"EnterPlanMode":           {},
	"EnterWorktree":           {},
	"ExitPlanMode":            {},
	"ExitWorktree":            {},
	"Glob":                    {},
	"Grep":                    {},
	"KillShell":               {},
	"LS":                      {},
	"LSP":                     {},
	"ListAgents":              {},
	"ListMcpResourcesTool":    {},
	"ListPeers":               {},
	"Monitor":                 {},
	"MultiEdit":               {},
	"NotebookEdit":            {},
	"PowerShell":              {},
	"PushNotification":        {},
	"REPL":                    {},
	"Read":                    {},
	"ReadMcpResourceDirTool":  {},
	"ReadMcpResourceTool":     {},
	"RemoteTrigger":           {},
	"ReportFindings":          {},
	"ScheduleWakeup":          {},
	"SendMessage":             {},
	"SendUserFile":            {},
	"SendUserMessage":         {},
	"Skill":                   {},
	"Sleep":                   {},
	"Snip":                    {},
	"StructuredOutput":        {},
	"SubscribePR":             {},
	"Task":                    {},
	"TaskCreate":              {},
	"TaskGet":                 {},
	"TaskList":                {},
	"TaskOutput":              {},
	"TaskStop":                {},
	"TaskUpdate":              {},
	"TeamCreate":              {},
	"TeamDelete":              {},
	"TerminalCapture":         {},
	"TodoWrite":               {},
	"ToolSearch":              {},
	"VerifyPlanExecution":     {},
	"WaitForMcpServers":       {},
	"WebBrowser":              {},
	"WebFetch":                {},
	"WebSearch":               {},
	"Workflow":                {},
	"Write":                   {},
}

var officialServerToolNames = map[string]struct{}{
	"web_search":                  {},
	"web_fetch":                   {},
	"code_execution":              {},
	"str_replace_based_edit_tool": {},
	"str_replace_editor":          {},
	"bash":                        {},
	"computer":                    {},
	"memory":                      {},
	"advisor":                     {},
	"tool_search_tool_regex":      {},
	"tool_search_tool_bm25":       {},
}

var allowedProxiedEntrypoints = map[string]struct{}{
	"cli":               {},
	"sdk-cli":           {},
	"cli-bg":            {},
	"claude-desktop-3p": {},
	"sdk-ts":            {},
	"local-agent":       {},
	"claude-vscode":     {},
	"vscode":            {},
	"desktop":           {},
	"cowork":            {},
	"claude-desktop":    {},
}

var securityMonitorMarkers = []string{
	"## Threat Model",
	"- `<transcript>`:",
	"## HARD BLOCK",
	"## SOFT BLOCK",
	"## Classification Process",
	"## Output Format",
}

var officialCCIdentityPrefixes = []string{
	"You are Claude Code, Anthropic's official CLI for Claude",
	"You are a Claude agent, built on Anthropic's Claude Agent SDK",
	"You are Claude Code, built on Anthropic's Claude Agent SDK",
}

var officialCCChildPrefixes = []string{
	"You are an interactive CLI tool that helps users",
	"You are a file search specialist for Claude Code",
	"You are a helpful AI assistant tasked with summarizing conversations",
	"You are an assistant for performing a web search tool use",
}

// stripZeroWidth removes invisible / zero-width formatting runes used by cloakers
// (U+00AD, U+180E, U+200B..U+200F, U+2060..U+2064, U+FEFF).
func stripZeroWidth(s string) string {
	return strings.Map(func(r rune) rune {
		if r == 0x00AD || r == 0x180E || r == 0xFEFF ||
			(r >= 0x200B && r <= 0x200F) ||
			(r >= 0x2060 && r <= 0x2064) {
			return -1
		}
		return r
	}, s)
}

func startsWithClaudeCLIUA(ua string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(ua)), "claude-cli/")
}

func hasVerifiedDesktopHeaders(headers map[string]string, ua string) bool {
	m := reStrictClaudeCLIUA.FindStringSubmatch(strings.TrimSpace(ua))
	if len(m) < 3 || m[2] != "local-agent" {
		return false
	}
	if !reDesktopAgentSDKInUA.MatchString(ua) {
		return false
	}
	if headerVal(headers, "anthropic-client-platform") != "desktop_app" {
		return false
	}
	return reSemverExact.MatchString(headerVal(headers, "anthropic-client-version"))
}

func hasCoworkApplicationDetails(normSys string) bool {
	low := strings.ToLower(normSys)
	return strings.Contains(low, "<application_details>") && strings.Contains(low, "cowork mode")
}

// ComputeClaudeCodeFingerprintUTF16 computes Claude Code's 3-hex fp3 fingerprint
// using UTF-16 code-unit indexing at offsets 4, 7, 20 (matching cli-node/src/utils/fingerprint.ts).
func ComputeClaudeCodeFingerprintUTF16(firstUserText, semver string) string {
	units := utf16.Encode([]rune(firstUserText))
	var picked [3]rune
	for i, pos := range []int{4, 7, 20} {
		if pos < len(units) {
			picked[i] = rune(units[pos])
		} else {
			picked[i] = '0'
		}
	}
	sum := sha256.Sum256([]byte(fingerprintSalt + string(picked[:]) + semver))
	return hex.EncodeToString(sum[:])[:3]
}

// IsValidStrictOfficialUserID validates metadata.user_id (non-zero 64-hex device_id
// and non-zero RFC-4122 UUIDv4 session_id in either JSON or legacy format).
func IsValidStrictOfficialUserID(raw map[string]any) bool {
	_, ok := parseStrictOfficialUserID(raw)
	return ok
}

func parseStrictOfficialUserID(raw map[string]any) (parsedUserID, bool) {
	meta, ok := raw["metadata"].(map[string]any)
	if !ok {
		return parsedUserID{}, false
	}
	uid, ok := meta["user_id"].(string)
	if !ok {
		return parsedUserID{}, false
	}
	uid = strings.TrimSpace(uid)
	if uid == "" || len(uid) > maxUserIDJSONBytes {
		return parsedUserID{}, false
	}
	if strings.HasPrefix(uid, "{") {
		var parsed map[string]any
		if err := json.Unmarshal([]byte(uid), &parsed); err != nil {
			return parsedUserID{}, false
		}
		dev, _ := parsed["device_id"].(string)
		sess, _ := parsed["session_id"].(string)
		if !reHex64Lower.MatchString(dev) || dev == zeroDeviceID64 {
			return parsedUserID{}, false
		}
		if !isNonZeroUUIDv4(sess) {
			return parsedUserID{}, false
		}
		acc := ""
		if rawAcc, exists := parsed["account_uuid"]; exists && rawAcc != nil {
			accStr, okStr := rawAcc.(string)
			if !okStr {
				return parsedUserID{}, false
			}
			acc = strings.TrimSpace(accStr)
			if acc != "" && !isNonZeroUUID(acc) {
				return parsedUserID{}, false
			}
		}
		parentSess, _ := parsed["parent_session_id"].(string)
		rootSess, _ := parsed["root_session_id"].(string)
		return parsedUserID{
			DeviceID:        dev,
			AccountUUID:     acc,
			SessionID:       sess,
			ParentSessionID: strings.TrimSpace(parentSess),
			RootSessionID:   strings.TrimSpace(rootSess),
		}, true
	}

	m := reLegacyOfficialUserID.FindStringSubmatch(uid)
	if len(m) != 4 {
		return parsedUserID{}, false
	}
	dev, acc, sess := m[1], m[2], m[3]
	if dev == zeroDeviceID64 {
		return parsedUserID{}, false
	}
	if acc != "" && !isNonZeroUUID(acc) {
		return parsedUserID{}, false
	}
	if !isNonZeroUUIDv4(sess) {
		return parsedUserID{}, false
	}
	return parsedUserID{
		DeviceID:    dev,
		AccountUUID: acc,
		SessionID:   sess,
	}, true
}

func hasRawMetadataUserID(raw map[string]any) bool {
	meta, ok := raw["metadata"].(map[string]any)
	if !ok {
		return false
	}
	val, exists := meta["user_id"]
	if !exists || val == nil {
		return false
	}
	if s, ok := val.(string); ok {
		return strings.TrimSpace(s) != ""
	}
	return true
}

func isNonZeroUUID(s string) bool {
	s = strings.TrimSpace(s)
	return reUUIDAny.MatchString(s) && !strings.EqualFold(s, zeroUUID)
}

func isNonZeroUUIDv4(s string) bool {
	s = strings.TrimSpace(s)
	return reUUIDv4.MatchString(s) && !strings.EqualFold(s, zeroUUID)
}

// IsOfficialClaudeTool checks whether one Anthropic tool definition is an official
// Claude Code 2.1.321–2.1.332 built-in, versioned Anthropic server tool, official
// MCP tool (excluding mcp__openclaw__), or classify_result when allowClassifierTool is true.
func IsOfficialClaudeTool(tool map[string]any, allowClassifierTool bool) bool {
	if tool == nil {
		return false
	}
	typ, _ := tool["type"].(string)
	name, _ := tool["name"].(string)
	typ = strings.TrimSpace(typ)
	name = strings.TrimSpace(name)

	if typ != "" && typ != "custom" {
		if reServerToolType.MatchString(typ) {
			if name == "" {
				return true
			}
			_, ok := officialServerToolNames[name]
			return ok
		}
		return false
	}

	if name == "" {
		return false
	}
	if allowClassifierTool && name == "classify_result" {
		return true
	}
	if _, ok := officialClaudeCodeToolNames[name]; ok {
		return true
	}
	if reOfficialMCPTool.MatchString(name) {
		if strings.HasPrefix(strings.ToLower(name), "mcp__openclaw__") {
			return false
		}
		return true
	}
	return false
}

func hasNonOfficialTools(raw map[string]any, allowClassifierTool bool) bool {
	tools, ok := raw["tools"].([]any)
	if !ok || len(tools) == 0 {
		return false
	}
	for _, item := range tools {
		tm, ok := item.(map[string]any)
		if !ok {
			return true
		}
		if !IsOfficialClaudeTool(tm, allowClassifierTool) {
			return true
		}
	}
	return false
}

func toolNamesFromMap(raw map[string]any) []string {
	tools, ok := raw["tools"].([]any)
	if !ok || len(tools) == 0 {
		return nil
	}
	out := make([]string, 0, len(tools))
	for _, item := range tools {
		tm, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if name, ok := tm["name"].(string); ok && strings.TrimSpace(name) != "" {
			out = append(out, stripZeroWidth(strings.TrimSpace(name)))
		}
	}
	return out
}

// DetectCloneHarness inspects zero-width-normalized headers, system text, and tool names
// for known third-party clones/harnesses (OMP, OpenCode, Pi, OpenClaw, Hermes, Codex,
// Cline/Roo/Kilo, DeepSeek Harness, Keli Agent, Toonflow).
func DetectCloneHarness(headers map[string]string, raw map[string]any, sysTexts []string) string {
	ua := stripZeroWidth(headerVal(headers, "user-agent"))
	normBlocks := make([]string, 0, len(sysTexts))
	for _, t := range sysTexts {
		normBlocks = append(normBlocks, stripZeroWidth(t))
	}
	normSys := strings.Join(normBlocks, "\n")
	toolNames := toolNamesFromMap(raw)

	// 1. oh-my-pi (omp) — checked first so OMP spoofs report ClientClass="oh_my_pi".
	if reCloneOmpUA.MatchString(ua) ||
		reCloneOmpSystem.MatchString(normSys) ||
		reCloneOmpTrusted.MatchString(normSys) ||
		reCloneRFC2119.MatchString(normSys) ||
		(reCloneOmpRole.MatchString(normSys) && reCloneOmpProject.MatchString(normSys)) ||
		(strings.Contains(strings.ToLower(normSys), "<system-conventions>") &&
			(strings.Contains(strings.ToLower(normSys), "oh my pi") || strings.Contains(strings.ToLower(normSys), "<workstation>"))) ||
		(strings.Contains(strings.ToLower(normSys), "<project-context>") && strings.Contains(strings.ToLower(normSys), "<workstation>")) {
		return "oh_my_pi"
	}

	// local-agent stealth check:
	// - Direct CC with local-agent MUST carry verified Desktop headers.
	// - Proxied local-agent (no claude-cli UA) MUST carry genuine Cowork <application_details>.
	if m := reStrictClaudeCLIUA.FindStringSubmatch(ua); len(m) >= 3 && m[2] == "local-agent" {
		if !hasVerifiedDesktopHeaders(headers, ua) {
			return "oh_my_pi"
		}
	}
	if reCloneLocalAgentEP.MatchString(normSys) {
		if startsWithClaudeCLIUA(ua) {
			if !hasVerifiedDesktopHeaders(headers, ua) {
				return "oh_my_pi"
			}
		} else if !hasCoworkApplicationDetails(normSys) {
			return "oh_my_pi"
		}
	}

	// 2. OpenClaw / Clawdbot / Moltbot.
	if reCloneOpenClawUA.MatchString(ua) || reCloneOpenClawSys.MatchString(normSys) {
		return "openclaw"
	}
	for _, name := range toolNames {
		if strings.HasPrefix(strings.ToLower(name), "mcp__openclaw__") {
			return "openclaw"
		}
	}

	// 3. OpenCode.
	if reCloneOpenCodeUA.MatchString(ua) || reCloneOpenCodeSys.MatchString(normSys) {
		return "opencode"
	}

	// 4. Pi / __pi_deferred_placeholder__.
	if reClonePiSys.MatchString(normSys) {
		return "pi"
	}
	for _, name := range toolNames {
		if name == "__pi_deferred_placeholder__" {
			return "pi"
		}
	}

	// 5. Hermes Agent / Nous Research.
	if reCloneHermesUA.MatchString(ua) || reCloneHermesSys.MatchString(normSys) {
		return "hermes"
	}

	// 6. Codex CLI.
	orig := strings.ToLower(headerVal(headers, "originator"))
	if reCloneCodexUA.MatchString(ua) ||
		strings.HasPrefix(orig, "codex_") ||
		headerVal(headers, "x-codex-installation-id") != "" ||
		reCloneCodexSys.MatchString(normSys) {
		return "codex"
	}

	// 7. Cline / Roo / Kilo Code.
	if reCloneClineRooKilo.MatchString(normSys) {
		return "cline_roo_kilo"
	}

	// 8. DeepSeek Harness.
	if reCloneDeepSeekSys.MatchString(normSys) {
		return "deepseek_harness"
	}

	// 9. Keli Agent.
	if reCloneKeliAgentSys.MatchString(normSys) {
		return "keli_agent"
	}

	// 10. Toonflow.
	if reCloneToonflowSys.MatchString(normSys) {
		return "toonflow"
	}

	return ""
}

func firstUserCandidateTexts(raw map[string]any) []string {
	msgs, ok := raw["messages"].([]any)
	if !ok || len(msgs) == 0 {
		return []string{""}
	}
	var candidates []string
	addCand := func(s string) {
		addOne := func(val string) {
			for _, prev := range candidates {
				if prev == val {
					return
				}
			}
			candidates = append(candidates, val)
		}
		addOne(s)
		if stripped := strings.TrimLeft(reLeadingSysReminder.ReplaceAllString(s, ""), " \t\r\n"); stripped != s && stripped != "" {
			addOne(stripped)
		}
	}
	sawFirstUser := false
	sawNonMeta := false
	for _, item := range msgs {
		m, ok := item.(map[string]any)
		if !ok || m["role"] != "user" {
			continue
		}
		switch c := m["content"].(type) {
		case string:
			if !sawFirstUser {
				sawFirstUser = true
				addCand(c)
			}
			if !sawNonMeta && !strings.HasPrefix(strings.TrimSpace(c), "<system-reminder>") {
				sawNonMeta = true
				addCand(c)
			}
		case []any:
			var firstText string
			hasFirst := false
			var firstNonMeta string
			hasNonMeta := false
			for _, blk := range c {
				switch b := blk.(type) {
				case string:
					if !hasFirst {
						hasFirst = true
						firstText = b
					}
					if !hasNonMeta && !strings.HasPrefix(strings.TrimSpace(b), "<system-reminder>") {
						hasNonMeta = true
						firstNonMeta = b
					}
				case map[string]any:
					if b["type"] == "text" {
						if txt, ok := b["text"].(string); ok {
							if !hasFirst {
								hasFirst = true
								firstText = txt
							}
							if !hasNonMeta && !strings.HasPrefix(strings.TrimSpace(txt), "<system-reminder>") {
								hasNonMeta = true
								firstNonMeta = txt
							}
						}
					}
				}
			}
			if !sawFirstUser {
				sawFirstUser = true
				if hasFirst {
					addCand(firstText)
				} else {
					addCand("")
				}
			}
			if !sawNonMeta && hasNonMeta {
				sawNonMeta = true
				addCand(firstNonMeta)
			}
		}
		if sawFirstUser && sawNonMeta {
			break
		}
	}
	if len(candidates) == 0 {
		return []string{""}
	}
	return candidates
}

func parseBillingHeader(sysTexts []string, raw map[string]any) parsedBillingHeader {
	if len(sysTexts) == 0 {
		return parsedBillingHeader{}
	}
	firstLine := sysTexts[0]
	hasTrailing := false
	if nl := strings.IndexAny(firstLine, "\r\n"); nl >= 0 {
		hasTrailing = strings.TrimSpace(firstLine[nl:]) != ""
		firstLine = firstLine[:nl]
	}
	m := reAnchoredBillingLine.FindStringSubmatch(firstLine)
	if len(m) < 2 {
		for _, t := range sysTexts {
			if reAnyBillingMention.MatchString(t) {
				return parsedBillingHeader{UnanchoredBilling: true}
			}
		}
		return parsedBillingHeader{}
	}
	res := parsedBillingHeader{Present: true}
	if hasTrailing {
		res.FailReason = "billing_trailing_content"
		return res
	}
	rest := m[1]

	vm := reBillingCCVersionToken.FindStringSubmatch(rest)
	if len(vm) < 2 {
		res.FailReason = "billing_missing_version"
		return res
	}
	vStrict := reBillingCCVersionStrict.FindStringSubmatch(vm[1])
	if len(vStrict) < 2 {
		res.FailReason = "billing_invalid_version"
		return res
	}
	res.Version = vStrict[1]
	res.FP3 = vStrict[2]

	em := reBillingCCEntryToken.FindStringSubmatch(rest)
	if len(em) < 2 {
		res.FailReason = "billing_missing_entrypoint"
		return res
	}
	res.Entrypoint = em[1]

	if cm := reBillingCCHToken.FindStringSubmatch(rest); len(cm) >= 2 {
		cchVal := strings.TrimSpace(cm[1])
		res.CCH = cchVal
		if cchVal == "00000" {
			res.FailReason = "cch_placeholder"
			return res
		}
		if !reCCH5Hex.MatchString(cchVal) {
			res.FailReason = "cch_invalid"
			return res
		}
	}

	if res.FP3 != "" {
		matched := false
		for _, cand := range firstUserCandidateTexts(raw) {
			if ComputeClaudeCodeFingerprintUTF16(cand, res.Version) == res.FP3 {
				matched = true
				break
			}
		}
		if !matched {
			res.FailReason = "fp3_mismatch"
			return res
		}
	}

	res.Valid = true
	return res
}

func isOfficialSecurityMonitorBlock(text string) bool {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, securityMonitorPrefix) {
		return false
	}
	if len(trimmed) < securityMonitorMinLen {
		return false
	}
	for _, marker := range securityMonitorMarkers {
		if !strings.Contains(trimmed, marker) {
			return false
		}
	}
	return true
}

func isOfficialSecurityMonitorPrompt(sysTexts []string) bool {
	for _, t := range sysTexts {
		if isOfficialSecurityMonitorBlock(t) {
			return true
		}
	}
	return false
}

func hasAnchoredIdentityPrefix(text string) bool {
	trimmed := strings.TrimSpace(text)
	for _, p := range officialCCIdentityPrefixes {
		if strings.HasPrefix(trimmed, p) {
			return true
		}
	}
	return false
}

func hasAnchoredChildPrefix(text string) bool {
	trimmed := strings.TrimSpace(text)
	for _, p := range officialCCChildPrefixes {
		if strings.HasPrefix(trimmed, p) {
			return true
		}
	}
	return false
}

func hasAnchoredOfficialBlock(text string, allowChild bool, allowTitle bool) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return false
	}
	if hasAnchoredIdentityPrefix(trimmed) {
		return true
	}
	if allowChild && hasAnchoredChildPrefix(trimmed) {
		return true
	}
	if allowTitle && reOfficialChildTitle.MatchString(trimmed) {
		return true
	}
	return false
}

func anchoredSystemBlock(sysTexts []string, billingPresent bool) string {
	idx := 0
	if billingPresent {
		idx = 1
	}
	if idx >= len(sysTexts) {
		return ""
	}
	return sysTexts[idx]
}

func hasTranscriptOrClassifyTool(raw map[string]any) bool {
	if tc, ok := raw["tool_choice"].(map[string]any); ok {
		if typ, _ := tc["type"].(string); typ == "tool" {
			if name, _ := tc["name"].(string); name == "classify_result" {
				return true
			}
		}
	}
	msgs, ok := raw["messages"].([]any)
	if !ok {
		return false
	}
	for _, item := range msgs {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		switch c := m["content"].(type) {
		case string:
			if strings.Contains(c, "<transcript>") {
				return true
			}
		case []any:
			for _, blk := range c {
				if bm, ok := blk.(map[string]any); ok {
					if txt, ok := bm["text"].(string); ok && strings.Contains(txt, "<transcript>") {
						return true
					}
				}
			}
		}
	}
	return false
}

func isKnownOfficialSystemBlock(idx int, text string, isSecMon bool, zeroTools bool) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return true
	}
	if idx == 0 && reAnchoredBillingLine.MatchString(trimmed) {
		return true
	}
	if hasAnchoredIdentityPrefix(trimmed) || hasAnchoredChildPrefix(trimmed) {
		return true
	}
	if zeroTools && reOfficialChildTitle.MatchString(trimmed) {
		return true
	}
	if isOfficialSecurityMonitorBlock(trimmed) {
		return true
	}
	if isSecMon && strings.HasPrefix(trimmed, "## Session Context") {
		return true
	}
	if strings.HasPrefix(trimmed, "You are an interactive agent that helps users with software engineering tasks") ||
		strings.HasPrefix(trimmed, "You are an agent working with the user toward their goals") ||
		strings.HasPrefix(trimmed, "You are Anthropic Claude Agent SDK.") ||
		strings.Contains(trimmed, "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__") ||
		(strings.Contains(trimmed, "# Doing tasks") && strings.Contains(trimmed, "# Tone and style")) ||
		(strings.Contains(trimmed, "# System") && strings.Contains(trimmed, "# Doing tasks")) ||
		reEnvHeadingLine.MatchString(text) ||
		hasCoworkApplicationDetails(trimmed) {
		return true
	}
	return false
}

func hasForeignSystemBlocks(sysTexts []string, isSecMon bool, zeroTools bool) bool {
	for i, t := range sysTexts {
		if !isKnownOfficialSystemBlock(i, t, isSecMon, zeroTools) {
			return true
		}
	}
	return false
}

func checkDirectCCHeaders(headers map[string]string) (uaVersion, uaEntrypoint string, fails []string) {
	ua := headerVal(headers, "user-agent")
	m := reStrictClaudeCLIUA.FindStringSubmatch(ua)
	if len(m) < 3 {
		fails = append(fails, "ua_syntax")
	} else {
		uaVersion = m[1]
		uaEntrypoint = m[2]
		if uaEntrypoint == "local-agent" && !hasVerifiedDesktopHeaders(headers, ua) {
			fails = append(fails, "missing_desktop_headers")
		}
	}

	xApp := strings.ToLower(headerVal(headers, "x-app"))
	if xApp != "cli" && xApp != "cli-bg" {
		fails = append(fails, "invalid_x_app")
	}
	if headerVal(headers, "anthropic-version") != "2023-06-01" {
		fails = append(fails, "invalid_anthropic_version")
	}
	if headerVal(headers, "anthropic-dangerous-direct-browser-access") != "true" {
		fails = append(fails, "missing_browser_access_header")
	}
	if headerVal(headers, "x-stainless-lang") != "js" ||
		!reStainlessOS.MatchString(headerVal(headers, "x-stainless-os")) ||
		!reStainlessArch.MatchString(headerVal(headers, "x-stainless-arch")) ||
		!reStainlessRuntime.MatchString(headerVal(headers, "x-stainless-runtime")) ||
		!reStainlessRuntimeVer.MatchString(headerVal(headers, "x-stainless-runtime-version")) ||
		!reStainlessPkgVer.MatchString(headerVal(headers, "x-stainless-package-version")) ||
		!reDigitsOnly.MatchString(headerVal(headers, "x-stainless-retry-count")) ||
		!reDigitsOnly.MatchString(headerVal(headers, "x-stainless-timeout")) {
		fails = append(fails, "missing_stainless_headers")
	}
	if !isNonZeroUUIDv4(headerVal(headers, "x-claude-code-session-id")) {
		fails = append(fails, "invalid_session_header")
	}
	return uaVersion, uaEntrypoint, fails
}

func sessionHeaderMatchesUserID(headers map[string]string, uid parsedUserID) bool {
	sess := headerVal(headers, "x-claude-code-session-id")
	if sess == "" {
		return false
	}
	if strings.EqualFold(sess, uid.SessionID) {
		return true
	}
	if uid.ParentSessionID != "" && strings.EqualFold(sess, uid.ParentSessionID) {
		return true
	}
	if uid.RootSessionID != "" && strings.EqualFold(sess, uid.RootSessionID) {
		return true
	}
	return false
}

func singleUserMessageText(raw map[string]any) (string, bool) {
	msgs, ok := raw["messages"].([]any)
	if !ok || len(msgs) != 1 {
		return "", false
	}
	m, ok := msgs[0].(map[string]any)
	if !ok || m["role"] != "user" {
		return "", false
	}
	switch c := m["content"].(type) {
	case string:
		return c, true
	case []any:
		if len(c) != 1 {
			return "", false
		}
		if blk, ok := c[0].(map[string]any); ok && blk["type"] == "text" {
			if txt, ok := blk["text"].(string); ok {
				return txt, true
			}
		}
	}
	return "", false
}

func toolCount(raw map[string]any) int {
	tools, ok := raw["tools"].([]any)
	if !ok {
		return 0
	}
	return len(tools)
}

func intValue(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		if n == float64(int(n)) {
			return int(n), true
		}
	}
	return 0, false
}

func isDirectQuotaProbe(raw map[string]any, sysTexts []string) bool {
	mt, ok := intValue(raw["max_tokens"])
	if !ok || mt != 1 || len(sysTexts) > 0 || toolCount(raw) > 0 {
		return false
	}
	txt, ok := singleUserMessageText(raw)
	return ok && txt == "quota"
}

func isDirectSideQuery(raw map[string]any, sysTexts []string, billing parsedBillingHeader) bool {
	if !billing.Present || !billing.Valid || len(sysTexts) < 2 {
		return false
	}
	if !hasAnchoredIdentityPrefix(sysTexts[1]) {
		return false
	}
	txt, ok := singleUserMessageText(raw)
	if !ok {
		return false
	}
	tools, _ := raw["tools"].([]any)
	if len(tools) == 0 {
		return strings.HasPrefix(txt, "\nWeb page content:\n---\n")
	}
	if len(tools) == 1 {
		if tm, ok := tools[0].(map[string]any); ok {
			typ, _ := tm["type"].(string)
			name, _ := tm["name"].(string)
			return reWebSearchServerType.MatchString(typ) &&
				name == "web_search" &&
				strings.HasPrefix(txt, "Perform a web search for the query: ")
		}
	}
	return false
}

func isDirectAuxiliaryRequest(headers map[string]string, raw map[string]any, sysTexts []string, billing parsedBillingHeader, isSecMon bool) bool {
	if isDirectQuotaProbe(raw, sysTexts) {
		return true
	}
	if isDirectSideQuery(raw, sysTexts, billing) {
		return true
	}
	if isSecMon && hasTranscriptOrClassifyTool(raw) {
		return true
	}
	anchor := anchoredSystemBlock(sysTexts, billing.Present)
	reqClass := strings.ToLower(headerVal(headers, "x-claude-code-request-class"))
	switch reqClass {
	case "compaction", "auxiliary", "side_reply", "subagent":
		if hasAnchoredOfficialBlock(anchor, true, toolCount(raw) == 0) {
			return true
		}
	}
	if toolCount(raw) == 0 && (hasAnchoredChildPrefix(anchor) || reOfficialChildTitle.MatchString(strings.TrimSpace(anchor))) {
		return true
	}
	return false
}

func hasSubstantialMultiBlockOfficialPrompt(sysTexts []string) bool {
	if len(sysTexts) < 2 {
		return false
	}
	if !hasAnchoredIdentityPrefix(sysTexts[0]) {
		return false
	}
	for _, t := range sysTexts[1:] {
		trimmed := strings.TrimSpace(t)
		if len(trimmed) >= 200 ||
			strings.HasPrefix(trimmed, "You are an interactive agent that helps users with software engineering tasks") ||
			strings.HasPrefix(trimmed, "You are an agent working with the user toward their goals") ||
			(strings.Contains(trimmed, "# Doing tasks") && strings.Contains(trimmed, "# Tone and style")) ||
			reEnvHeadingLine.MatchString(t) {
			return true
		}
	}
	return false
}

// VerifyOfficialClaudeCode runs the strict fail-closed multi-signal verifier
// mirroring src/lib/identity/official-cc-verifier.mjs.
func VerifyOfficialClaudeCode(headers map[string]string, raw map[string]any, detectProxied bool) OfficialCCVerdict {
	if raw == nil {
		return OfficialCCVerdict{Tier: "third_party", FailReasons: []string{"nil_body"}}
	}
	ua := headerVal(headers, "user-agent")
	sysTexts := systemTextsFromMap(raw)
	isSecMon := isOfficialSecurityMonitorPrompt(sysTexts)
	zeroTools := toolCount(raw) == 0

	// Gate 0: Hard disqualifiers (OpenAI tools, clones, invalid billing, non-official tools).
	if hasOpenAIToolShape(raw) {
		return OfficialCCVerdict{Tier: failTier(ua), FailReasons: []string{"openai_tool_shape"}}
	}
	if cloneID := DetectCloneHarness(headers, raw, sysTexts); cloneID != "" {
		return OfficialCCVerdict{
			Tier:        failTier(ua),
			CloneID:     cloneID,
			FailReasons: []string{"clone:" + cloneID},
		}
	}
	billing := parseBillingHeader(sysTexts, raw)
	if billing.Present && !billing.Valid {
		return OfficialCCVerdict{
			Tier:        failTier(ua),
			FailReasons: []string{billing.FailReason},
		}
	}
	if hasNonOfficialTools(raw, isSecMon) {
		return OfficialCCVerdict{
			Tier:                failTier(ua),
			HasNonOfficialTools: true,
			FailReasons:         []string{"non_official_tool"},
		}
	}

	hasForeign := hasForeignSystemBlocks(sysTexts, isSecMon, zeroTools)

	// Branch 1: Direct CC (UA starts with claude-cli/). NEVER falls back to proxied!
	if startsWithClaudeCLIUA(ua) {
		uaVer, uaEP, hdrFails := checkDirectCCHeaders(headers)
		if len(hdrFails) > 0 {
			return OfficialCCVerdict{
				Tier:             "spoofed_claude_code",
				HasForeignSystem: hasForeign,
				FailReasons:      hdrFails,
			}
		}
		if billing.Present {
			if billing.Version != uaVer {
				return OfficialCCVerdict{
					Tier:             "spoofed_claude_code",
					HasForeignSystem: hasForeign,
					FailReasons:      []string{"billing_version_mismatch"},
				}
			}
			if billing.Entrypoint != uaEP {
				return OfficialCCVerdict{
					Tier:             "spoofed_claude_code",
					HasForeignSystem: hasForeign,
					FailReasons:      []string{"billing_entrypoint_mismatch"},
				}
			}
		}
		uid, uidOK := parseStrictOfficialUserID(raw)
		if !uidOK {
			return OfficialCCVerdict{
				Tier:             "spoofed_claude_code",
				HasForeignSystem: hasForeign,
				FailReasons:      []string{"invalid_user_id"},
			}
		}
		if !sessionHeaderMatchesUserID(headers, uid) {
			return OfficialCCVerdict{
				Tier:             "spoofed_claude_code",
				HasForeignSystem: hasForeign,
				FailReasons:      []string{"session_mismatch"},
			}
		}

		// Tier 1: official_direct (claude-code-20250219 beta + official anchored system at block 0 or 1).
		anchor := anchoredSystemBlock(sysTexts, billing.Present)
		if hasBetaToken(headers, officialCCBetaToken) &&
			(hasAnchoredOfficialBlock(anchor, true, zeroTools) || (isSecMon && hasTranscriptOrClassifyTool(raw))) {
			return OfficialCCVerdict{
				Tier:             "official_direct",
				Official:         true,
				Direct:           true,
				AllowPassthrough: !hasForeign,
				HasForeignSystem: hasForeign,
			}
		}

		// Tier 2: official_auxiliary (strict subtypes with full H1+H2+B1 already verified).
		if isDirectAuxiliaryRequest(headers, raw, sysTexts, billing, isSecMon) {
			return OfficialCCVerdict{
				Tier:             "official_auxiliary",
				Official:         true,
				Direct:           true,
				Auxiliary:        true,
				AllowPassthrough: !hasForeign,
				HasForeignSystem: hasForeign,
			}
		}

		return OfficialCCVerdict{
			Tier:             "spoofed_claude_code",
			HasForeignSystem: hasForeign,
			FailReasons:      []string{"missing_official_beta_or_system"},
		}
	}

	// Branch 2: Proxied / Relayed CC (only when detectProxied is ON and UA is NOT claude-cli/*).
	if !detectProxied {
		return OfficialCCVerdict{
			Tier:             "third_party",
			HasForeignSystem: hasForeign,
			FailReasons:      []string{"proxied_detection_disabled"},
		}
	}

	// Tier 3a: Anchored verified billing header in system[0] WITH verified fp3.
	if billing.Present && billing.Valid {
		if billing.FP3 == "" {
			return OfficialCCVerdict{
				Tier:             "third_party",
				HasForeignSystem: hasForeign,
				FailReasons:      []string{"proxied_missing_fp3"},
			}
		}
		if _, ok := allowedProxiedEntrypoints[billing.Entrypoint]; !ok {
			return OfficialCCVerdict{
				Tier:             "third_party",
				HasForeignSystem: hasForeign,
				FailReasons:      []string{"proxied_unknown_entrypoint"},
			}
		}
		if hasForeign {
			return OfficialCCVerdict{
				Tier:             "third_party",
				HasForeignSystem: true,
				FailReasons:      []string{"foreign_system_block"},
			}
		}
		secondBlock := anchoredSystemBlock(sysTexts, true)
		if billing.Entrypoint == "claude-desktop-3p" || billing.Entrypoint == "sdk-ts" {
			// Per live ph24 census: user_id is often absent on these two entrypoints,
			// but if present it MUST be strictly valid (rejects fake/all-zero user_id).
			if hasRawMetadataUserID(raw) {
				if _, ok := parseStrictOfficialUserID(raw); !ok {
					return OfficialCCVerdict{
						Tier:        "third_party",
						FailReasons: []string{"invalid_user_id"},
					}
				}
			}
			if !hasAnchoredOfficialBlock(secondBlock, false, zeroTools) {
				return OfficialCCVerdict{
					Tier:        "third_party",
					FailReasons: []string{"missing_official_system"},
				}
			}
			return OfficialCCVerdict{
				Tier:             "official_proxied",
				Official:         true,
				Proxied:          true,
				AllowPassthrough: true,
			}
		}

		// Other entrypoints (cli, sdk-cli, local-agent, claude-vscode, ...):
		// require strict non-zero metadata.user_id + official system or verified security monitor.
		if _, ok := parseStrictOfficialUserID(raw); !ok {
			return OfficialCCVerdict{
				Tier:        "third_party",
				FailReasons: []string{"invalid_user_id"},
			}
		}
		if !hasAnchoredOfficialBlock(secondBlock, true, zeroTools) && !isSecMon {
			return OfficialCCVerdict{
				Tier:        "third_party",
				FailReasons: []string{"missing_official_system"},
			}
		}
		return OfficialCCVerdict{
			Tier:             "official_proxied",
			Official:         true,
			Proxied:          true,
			AllowPassthrough: true,
		}
	}

	// Tier 3b: Relay stripped billing header.
	// Reject any unanchored billing header mention anywhere in system blocks.
	if billing.UnanchoredBilling {
		return OfficialCCVerdict{
			Tier:             "third_party",
			HasForeignSystem: hasForeign,
			FailReasons:      []string{"unanchored_billing_header"},
		}
	}
	// Require strict non-zero user_id + claude-code-20250219 beta + zero foreign blocks +
	// (multi-block official prompt OR verified 0-tool warmup OR 10KB/6-marker security monitor).
	if hasForeign {
		return OfficialCCVerdict{
			Tier:             "third_party",
			HasForeignSystem: true,
			FailReasons:      []string{"foreign_system_block"},
		}
	}
	if _, ok := parseStrictOfficialUserID(raw); !ok {
		return OfficialCCVerdict{
			Tier:        "third_party",
			FailReasons: []string{"invalid_user_id"},
		}
	}
	if !hasBetaToken(headers, officialCCBetaToken) {
		return OfficialCCVerdict{
			Tier:        "third_party",
			FailReasons: []string{"missing_claude_code_beta"},
		}
	}
	isVerifiedWarmup := zeroTools &&
		len(sysTexts) == 1 &&
		hasAnchoredIdentityPrefix(sysTexts[0]) &&
		hasBetaToken(headers, officialInterleavedBetaToken)
	if hasSubstantialMultiBlockOfficialPrompt(sysTexts) || isVerifiedWarmup || isSecMon {
		return OfficialCCVerdict{
			Tier:             "official_proxied",
			Official:         true,
			Proxied:          true,
			AllowPassthrough: true,
		}
	}

	return OfficialCCVerdict{
		Tier:        "third_party",
		FailReasons: []string{"insufficient_proxied_signals"},
	}
}

func failTier(ua string) string {
	if startsWithClaudeCLIUA(ua) {
		return "spoofed_claude_code"
	}
	return "third_party"
}
