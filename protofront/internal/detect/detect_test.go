package detect

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dofastted/kin-gateway/protofront/internal/ir"
)

const (
	testDeviceID64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	testAccountID  = "10000000-0000-4000-a000-000000000001"
	testSessionV4  = "20000000-0000-4000-a000-000000000002"
	testSessionV7  = "01a21c0a-62c5-739d-ba3f-17ae6a38b649"
)

func makeJSONUserID(deviceID, accountUUID, sessionID string) string {
	obj := map[string]any{}
	if deviceID != "" {
		obj["device_id"] = deviceID
	}
	if accountUUID != "<omit>" {
		obj["account_uuid"] = accountUUID
	}
	if sessionID != "" {
		obj["session_id"] = sessionID
	}
	b, _ := json.Marshal(obj)
	return string(b)
}

func validDirectCCHeaders(ua, sessionID string) map[string]string {
	return map[string]string{
		"user-agent":        ua,
		"x-app":             "cli",
		"anthropic-version": "2023-06-01",
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-beta":              "claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24",
		"x-stainless-lang":            "js",
		"x-stainless-os":              "Linux",
		"x-stainless-arch":            "x64",
		"x-stainless-runtime":         "node",
		"x-stainless-runtime-version": "v26.12.1",
		"x-stainless-package-version": "0.128.0",
		"x-stainless-retry-count":     "0",
		"x-stainless-timeout":         "600",
		"x-claude-code-session-id":    sessionID,
	}
}

func makeBillingLine(ver, ep, userText, extra string) string {
	fp3 := ComputeClaudeCodeFingerprintUTF16(userText, ver)
	line := "x-anthropic-billing-header: cc_version=" + ver + "." + fp3 + "; cc_entrypoint=" + ep + ";"
	if extra != "" {
		line += " " + extra
	}
	return line
}

func makeSecurityMonitorPrompt() string {
	var b strings.Builder
	b.WriteString("You are a security monitor for autonomous AI coding agents.\n\n")
	b.WriteString("## Threat Model\nEvaluate actions carefully.\n\n")
	b.WriteString("- `<transcript>`: contains the tool calls.\n\n")
	b.WriteString("## HARD BLOCK\nBlock destructive actions.\n\n")
	b.WriteString("## SOFT BLOCK\nFlag risky actions.\n\n")
	b.WriteString("## Classification Process\nAnalyze step by step.\n\n")
	b.WriteString("## Output Format\nReturn verdict.\n\n")
	b.WriteString(strings.Repeat("Policy guidance detail line for security monitor evaluation.\n", 200))
	return b.String()
}

func settingsPassthroughOn() WebSettings {
	var s WebSettings
	s.Compatibility.OfficialCCPassthrough = true
	return s
}

func TestLiveGenuineCCShapes_ZeroFalsePositives(t *testing.T) {
	t.Run("direct_2.1.321_without_billing_header_and_all_24_live_tools", func(t *testing.T) {
		liveTools := []string{
			"Agent", "AskUserQuestion", "Bash", "CronCreate", "CronDelete", "CronList",
			"Edit", "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree",
			"LSP", "ListAgents", "ListMcpResourcesTool", "Monitor", "NotebookEdit",
			"Read", "ReadMcpResourceDirTool", "ReadMcpResourceTool", "ReportFindings",
			"ScheduleWakeup", "SendMessage", "Skill", "TaskStop",
		}
		tools := make([]any, 0, len(liveTools))
		for _, name := range liveTools {
			tools = append(tools, map[string]any{"name": name, "input_schema": map[string]any{"type": "object"}})
		}
		hdrs := validDirectCCHeaders("claude-cli/2.1.321 (external, cli, workload/cron)", testSessionV4)
		body := map[string]any{
			"model":      "claude-sonnet-5-5",
			"max_tokens": 4096,
			"system": []any{
				map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
				map[string]any{"type": "text", "text": "\nYou are an agent working with the user toward their goals." + strings.Repeat(" guidance", 50)},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
			"tools":    tools,
			"messages": []any{
				map[string]any{"role": "user", "content": "请帮我检查一下构建脚本"},
			},
		}
		v := VerifyOfficialClaudeCode(hdrs, body, true)
		if !v.Official || !v.Direct || !v.AllowPassthrough || v.Tier != "official_direct" {
			t.Fatalf("expected direct 2.1.321 without billing to pass, got %+v", v)
		}
		dec := Evaluate(ir.ProtoAnthropic, ir.TargetClaudeCRAG, hdrs, body, settingsPassthroughOn())
		if !dec.OfficialClient || !dec.AllowPassthrough || dec.ClientClass != "claude_code_official" {
			t.Fatalf("expected Evaluate passthrough=true, got %+v", dec)
		}
	})

	t.Run("direct_with_cjk_utf16_fp3_and_system_reminder_meta_block", func(t *testing.T) {
		cjkPrompt := "你好世界测试一下这是一个很长的中文消息用来测试UTF16索引"
		hdrs := validDirectCCHeaders("claude-cli/2.1.321 (external, cli)", testSessionV4)
		body := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": makeBillingLine("2.1.321", "cli", cjkPrompt, "")},
				map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, testAccountID, testSessionV4)},
			"messages": []any{
				map[string]any{"role": "user", "content": []any{
					map[string]any{"type": "text", "text": "<system-reminder>hook context</system-reminder>"},
					map[string]any{"type": "text", "text": cjkPrompt},
				}},
			},
		}
		v := VerifyOfficialClaudeCode(hdrs, body, true)
		if !v.Official || !v.Direct || !v.AllowPassthrough {
			t.Fatalf("expected CJK UTF-16 fp3 match to pass, got %+v", v)
		}
	})

	t.Run("proxied_claude_desktop_3p_without_user_id_and_server_web_search", func(t *testing.T) {
		userMsg := "Summarize the repository structure and recent commits."
		hdrs := map[string]string{
			"user-agent":        "Go-http-client/2.0",
			"anthropic-version": "2023-06-01",
			"anthropic-beta":    "claude-code-20250219,interleaved-thinking-2025-05-14",
		}
		body := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": makeBillingLine("2.1.330", "claude-desktop-3p", userMsg, "")},
				map[string]any{"type": "text", "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK."},
			},
			"tools": []any{
				map[string]any{"name": "DesignSync"},
				map[string]any{"name": "Glob"},
				map[string]any{"name": "Grep"},
				map[string]any{"name": "PowerShell"},
				map[string]any{"name": "SendUserFile"},
				map[string]any{"name": "WebFetch"},
				map[string]any{"name": "WebSearch"},
				map[string]any{"name": "Workflow"},
				map[string]any{"name": "Write"},
				map[string]any{"type": "web_search_20250305", "name": "web_search"},
				map[string]any{"name": "mcp__github__list_issues"},
			},
			"messages": []any{
				map[string]any{"role": "user", "content": userMsg},
			},
		}
		v := VerifyOfficialClaudeCode(hdrs, body, true)
		if !v.Official || !v.Proxied || !v.AllowPassthrough || v.Tier != "official_proxied" {
			t.Fatalf("expected proxied claude-desktop-3p without user_id to pass, got %+v", v)
		}
	})

	t.Run("proxied_claude_desktop_3p_title_call_no_tools", func(t *testing.T) {
		userMsg := "Generate title for session"
		hdrs := map[string]string{"user-agent": "Go-http-client/2.0"}
		body := map[string]any{
			"model": "claude-haiku-4-5",
			"system": []any{
				map[string]any{"type": "text", "text": makeBillingLine("2.1.331", "claude-desktop-3p", userMsg, "")},
				map[string]any{"type": "text", "text": "You write short session titles for coding conversations."},
			},
			"messages": []any{
				map[string]any{"role": "user", "content": userMsg},
			},
		}
		v := VerifyOfficialClaudeCode(hdrs, body, true)
		if !v.Official || !v.Proxied || !v.AllowPassthrough {
			t.Fatalf("expected proxied claude-desktop-3p title call to pass, got %+v", v)
		}
	})

	t.Run("proxied_sdk_ts_without_user_id_and_without_claude_code_beta", func(t *testing.T) {
		userMsg := "Run diagnostics on the build pipeline."
		hdrs := map[string]string{
			"user-agent":     "Go-http-client/2.0",
			"anthropic-beta": "mid-conversation-system-2026-04-07,structured-outputs-2025-11-13",
		}
		body := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": makeBillingLine("2.1.311", "sdk-ts", userMsg, "")},
				map[string]any{"type": "text", "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK."},
			},
			"tools": []any{
				map[string]any{"name": "Bash"},
				map[string]any{"name": "Read"},
				map[string]any{"name": "Edit"},
				map[string]any{"name": "mcp__linear__get_issue"},
			},
			"messages": []any{
				map[string]any{"role": "user", "content": userMsg},
			},
		}
		v := VerifyOfficialClaudeCode(hdrs, body, true)
		if !v.Official || !v.Proxied || !v.AllowPassthrough {
			t.Fatalf("expected proxied sdk-ts without user_id/beta to pass, got %+v", v)
		}
	})

	t.Run("proxied_auto_mode_classifier_full_10kb_6_markers", func(t *testing.T) {
		userMsg := "<transcript>User ran Bash ls</transcript>"
		hdrs := map[string]string{
			"user-agent":        "Go-http-client/2.0",
			"anthropic-version": "2023-06-01",
		}
		body := map[string]any{
			"model": "claude-sonnet-5",
			"system": []any{
				map[string]any{"type": "text", "text": makeBillingLine("2.1.332", "cli", userMsg, "")},
				map[string]any{"type": "text", "text": makeSecurityMonitorPrompt()},
				map[string]any{"type": "text", "text": "## Session Context\nWorking dir: /workspace"},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
			"messages": []any{
				map[string]any{"role": "user", "content": userMsg},
			},
		}
		v := VerifyOfficialClaudeCode(hdrs, body, true)
		if !v.Official || !v.Proxied || !v.AllowPassthrough {
			t.Fatalf("expected full 10KB/6-marker proxied auto_mode_classifier to pass, got %+v", v)
		}
	})

	t.Run("proxied_local_agent_cowork_with_application_details", func(t *testing.T) {
		userMsg := "Help organize my workspace files."
		hdrs := map[string]string{"user-agent": "Go-http-client/2.0"}
		body := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": makeBillingLine("2.1.330", "local-agent", userMsg, "cch=a1b2c;")},
				map[string]any{"type": "text", "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK."},
				map[string]any{"type": "text", "text": "<application_details>\nClaude is powering Cowork mode inside Desktop.\n</application_details>"},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, testAccountID, testSessionV4)},
			"tools": []any{
				map[string]any{"name": "Read"},
				map[string]any{"name": "mcp__cowork__list_files"},
			},
			"messages": []any{
				map[string]any{"role": "user", "content": userMsg},
			},
		}
		v := VerifyOfficialClaudeCode(hdrs, body, true)
		if !v.Official || !v.Proxied || !v.AllowPassthrough {
			t.Fatalf("expected proxied Cowork local-agent to pass, got %+v", v)
		}
	})

	t.Run("proxied_stripped_billing_warmup_0_tools", func(t *testing.T) {
		hdrs := map[string]string{
			"user-agent":     "Go-http-client/2.0",
			"anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
		}
		body := map[string]any{
			"model": "claude-haiku-4-5",
			"system": []any{
				map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
			"messages": []any{
				map[string]any{"role": "user", "content": "warmup"},
			},
		}
		v := VerifyOfficialClaudeCode(hdrs, body, true)
		if !v.Official || !v.Proxied || !v.AllowPassthrough {
			t.Fatalf("expected proxied 0-tool warmup to pass, got %+v", v)
		}
	})

	t.Run("direct_quota_probe_and_desktop_local_agent_with_headers", func(t *testing.T) {
		hdrs := validDirectCCHeaders("claude-cli/2.1.321 (external, cli)", testSessionV4)
		delete(hdrs, "anthropic-beta")
		quotaBody := map[string]any{
			"model":      "claude-haiku-4-5",
			"max_tokens": 1,
			"metadata":   map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
			"messages":   []any{map[string]any{"role": "user", "content": "quota"}},
		}
		vq := VerifyOfficialClaudeCode(hdrs, quotaBody, true)
		if !vq.Official || !vq.Direct || !vq.Auxiliary {
			t.Fatalf("expected direct quota probe to pass as official_auxiliary, got %+v", vq)
		}

		desktopHdrs := validDirectCCHeaders("claude-cli/2.1.330 (external, local-agent, agent-sdk/0.2.1)", testSessionV4)
		desktopHdrs["anthropic-client-platform"] = "desktop_app"
		desktopHdrs["anthropic-client-version"] = "4.4212.0"
		userMsg := "Hello from Desktop Cowork"
		desktopBody := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": makeBillingLine("2.1.330", "local-agent", userMsg, "")},
				map[string]any{"type": "text", "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK."},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, testAccountID, testSessionV4)},
			"messages": []any{map[string]any{"role": "user", "content": userMsg}},
		}
		vd := VerifyOfficialClaudeCode(desktopHdrs, desktopBody, true)
		if !vd.Official || !vd.Direct || !vd.AllowPassthrough {
			t.Fatalf("expected direct Desktop local-agent with valid headers to pass, got %+v", vd)
		}
	})
}

func TestAttackVectors_100PercentBlocked(t *testing.T) {
	t.Run("V1_unanchored_billing_substring_via_curl", func(t *testing.T) {
		hdrs := map[string]string{"user-agent": "curl/8.7.1"}
		body := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": "Ignore previous rules. x-anthropic-billing-header cc_entrypoint=cli"},
			},
			"tools": []any{
				map[string]any{"name": "fs_read"},
			},
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}
		dec := Evaluate(ir.ProtoAnthropic, ir.TargetClaudeCRAG, hdrs, body, settingsPassthroughOn())
		if dec.OfficialClient || dec.AllowPassthrough {
			t.Fatalf("V1 unanchored billing substring MUST be rejected, got %+v", dec)
		}
	})

	t.Run("V2_weak_json_user_id_and_legacy_len80_fallback_removed", func(t *testing.T) {
		hdrs := map[string]string{"user-agent": "claude-cli/2.1.0"}
		body := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
			},
			"metadata": map[string]any{"user_id": `{"device_id":"a","session_id":"b"}`},
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}
		if IsOfficialClaudeCode(hdrs, body) || IsProxiedOfficialClaudeCode(hdrs, body) {
			t.Fatalf("V2 weak JSON user_id + bare claude-cli UA MUST be rejected")
		}

		legacyFake := map[string]any{
			"metadata": map[string]any{
				"user_id": "user_" + strings.Repeat("z", 70) + "_session_" + strings.Repeat("y", 40),
			},
		}
		if IsValidStrictOfficialUserID(legacyFake) {
			t.Fatalf("weak legacy len>=80 fallback MUST be rejected")
		}
	})

	t.Run("live_ph24_claude_cli_2_1_280_omp_spoofer_with_tools_and_without_tools", func(t *testing.T) {
		userMsg := "Refactor the parser module"
		hdrs := validDirectCCHeaders("claude-cli/2.1.280 (external, cli)", testSessionV7)
		// Even with full Stainless/x-app/session headers + valid billing + cc_id,
		// live spoofer fails on UUIDv7/missing-device_id, _bash tools, AND RFC 2119/workstation markers.
		bodyWithTools := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": makeBillingLine("2.1.280", "cli", userMsg, "cch=1a2b3;")},
				map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
				map[string]any{"type": "text", "text": "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL."},
				map[string]any{"type": "text", "text": "<project-context>\n<workstation>linux</workstation>\n</project-context>"},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID("", "<omit>", testSessionV7)},
			"tools": []any{
				map[string]any{"name": "_bash"},
				map[string]any{"name": "_read"},
				map[string]any{"name": "_edit"},
			},
			"messages": []any{map[string]any{"role": "user", "content": userMsg}},
		}
		decTools := Evaluate(ir.ProtoAnthropic, ir.TargetClaudeCRAG, hdrs, bodyWithTools, settingsPassthroughOn())
		if decTools.OfficialClient || decTools.AllowPassthrough || decTools.ClientClass != "oh_my_pi" {
			t.Fatalf("claude-cli/2.1.280 spoofer with tools MUST be rejected as oh_my_pi, got %+v", decTools)
		}

		// Even on its 4 no-tools summary/title calls without RFC2119/workstation blocks:
		// missing 64-hex device_id + UUIDv7 session_id catches it 100%!
		bodyNoTools := map[string]any{
			"model": "claude-haiku-4-5",
			"system": []any{
				map[string]any{"type": "text", "text": makeBillingLine("2.1.280", "cli", userMsg, "")},
				map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID("", "<omit>", testSessionV7)},
			"messages": []any{map[string]any{"role": "user", "content": userMsg}},
		}
		decNoTools := Evaluate(ir.ProtoAnthropic, ir.TargetClaudeCRAG, hdrs, bodyNoTools, settingsPassthroughOn())
		if decNoTools.OfficialClient || decNoTools.AllowPassthrough {
			t.Fatalf("claude-cli/2.1.280 spoofer no-tools summary call MUST be rejected, got %+v", decNoTools)
		}
	})

	t.Run("live_ph24_all_zero_go_http_client_probe", func(t *testing.T) {
		hdrs := map[string]string{
			"user-agent":     "Go-http-client/2.0",
			"anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
		}
		body := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
			},
			"metadata": map[string]any{
				"user_id": "user_" + strings.Repeat("0", 64) + "_account_00000000-0000-0000-0000-000000000000_session_00000000-0000-0000-0000-000000000000",
			},
			"messages": []any{map[string]any{"role": "user", "content": "ping"}},
		}
		dec := Evaluate(ir.ProtoAnthropic, ir.TargetClaudeCRAG, hdrs, body, settingsPassthroughOn())
		if dec.OfficialClient || dec.AllowPassthrough {
			t.Fatalf("all-zero Go-http-client probe MUST be rejected, got %+v", dec)
		}
	})

	t.Run("bare_ua_spoof_never_falls_back_to_proxied", func(t *testing.T) {
		userMsg := "hello world from spoofer"
		// Caller sends claude-cli UA WITHOUT Stainless/x-app/session headers,
		// even with a valid anchored billing header & valid user_id -> MUST NOT fall back to proxied!
		hdrs := map[string]string{
			"user-agent":        "claude-cli/2.1.321 (external, cli)",
			"anthropic-version": "2023-06-01",
			"anthropic-beta":    "claude-code-20250219",
		}
		body := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": makeBillingLine("2.1.321", "cli", userMsg, "")},
				map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
			"messages": []any{map[string]any{"role": "user", "content": userMsg}},
		}
		v := VerifyOfficialClaudeCode(hdrs, body, true)
		if v.Official || v.AllowPassthrough || v.Tier != "spoofed_claude_code" {
			t.Fatalf("bare claude-cli UA MUST NEVER fall back to proxied, got %+v", v)
		}
	})

	t.Run("V5_case_sensitive_tool_allowlist_and_non_official_tools", func(t *testing.T) {
		badTools := []map[string]any{
			{"name": "bash"},
			{"name": "read"},
			{"name": "bash_exec"},
			{"name": "memory_save"},
			{"name": "_bash"},
			{"name": "fs_read"},
			{"name": "web_search"}, // custom tool without versioned server type!
			{"name": "mcp__openclaw__exec"},
			{"name": "classify_result"}, // not allowed outside verified security monitor!
		}
		for _, tool := range badTools {
			hdrs := validDirectCCHeaders("claude-cli/2.1.321 (external, cli)", testSessionV4)
			body := map[string]any{
				"model": "claude-sonnet-5-5",
				"system": []any{
					map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
				},
				"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
				"tools":    []any{tool},
				"messages": []any{map[string]any{"role": "user", "content": "hi"}},
			}
			v := VerifyOfficialClaudeCode(hdrs, body, true)
			if v.Official || v.AllowPassthrough {
				t.Fatalf("non-official tool %v MUST disqualify official & passthrough, got %+v", tool, v)
			}
		}
	})

	t.Run("V13_omp_local_agent_zero_width_clones_and_1line_security_monitor", func(t *testing.T) {
		userMsg := "test message for clone check"
		// 1. OMP local-agent without Desktop headers
		hdrsLA := validDirectCCHeaders("claude-cli/2.1.321 (external, local-agent)", testSessionV4)
		bodyLA := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": makeBillingLine("2.1.321", "local-agent", userMsg, "")},
				map[string]any{"type": "text", "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK."},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
			"messages": []any{map[string]any{"role": "user", "content": userMsg}},
		}
		vLA := VerifyOfficialClaudeCode(hdrsLA, bodyLA, true)
		if vLA.Official || vLA.CloneID != "oh_my_pi" {
			t.Fatalf("local-agent without Desktop headers MUST be rejected as oh_my_pi, got %+v", vLA)
		}

		// 2. OMP <system-conventions> + <workstation> and ROLE=== / PROJECT===
		for _, sysText := range []string{
			"<system-conventions><workstation>mac</workstation></system-conventions>",
			"ROLE\n====\ncoder\nPROJECT\n====\nrepo",
			"You are O\u200bpenCode, a coding agent.",
			"You are Her\u200cmes Agent built by Nous Research.",
			"You are a coding assistant running inside p\u200di.",
			"You are C\u200bline, an autonomous agent.",
			"You are an AI agent powered by DeepSeek Harness.",
			"你是 Keli Agent，智能编程助手。",
			"你是 Toonflow，工作流助手。",
		} {
			hdrs := validDirectCCHeaders("claude-cli/2.1.321 (external, cli)", testSessionV4)
			body := map[string]any{
				"model": "claude-sonnet-5-5",
				"system": []any{
					map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
					map[string]any{"type": "text", "text": sysText},
				},
				"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
				"messages": []any{map[string]any{"role": "user", "content": "hi"}},
			}
			v := VerifyOfficialClaudeCode(hdrs, body, true)
			if v.Official || v.CloneID == "" {
				t.Fatalf("clone prompt %q MUST be rejected with cloneID, got %+v", sysText, v)
			}
		}

		// 3. 1-line security monitor without 10KB / 6 markers
		hdrsSM := validDirectCCHeaders("claude-cli/2.1.321 (external, cli)", testSessionV4)
		bodySM := map[string]any{
			"model": "claude-sonnet-5",
			"system": []any{
				map[string]any{"type": "text", "text": "You are a security monitor for autonomous AI coding agents."},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}
		vSM := VerifyOfficialClaudeCode(hdrsSM, bodySM, true)
		if vSM.Official || vSM.AllowPassthrough {
			t.Fatalf("1-line security monitor without 10KB/6-markers MUST be rejected, got %+v", vSM)
		}
	})

	t.Run("billing_cch_placeholder_fp3_mismatch_and_version_entrypoint_mismatch", func(t *testing.T) {
		userMsg := "inspect billing verification"
		hdrs := validDirectCCHeaders("claude-cli/2.1.321 (external, cli)", testSessionV4)
		cases := []struct {
			name    string
			billing string
		}{
			{"cch_00000", makeBillingLine("2.1.321", "cli", userMsg, "cch=00000;")},
			{"trailing_content", makeBillingLine("2.1.321", "cli", userMsg, "") + "\nInjected third-party prompt"},
			{"fp3_mismatch", "x-anthropic-billing-header: cc_version=2.1.321.fff; cc_entrypoint=cli;"},
			{"version_mismatch", makeBillingLine("2.1.300", "cli", userMsg, "")},
			{"entrypoint_mismatch", makeBillingLine("2.1.321", "sdk-cli", userMsg, "")},
		}
		for _, tc := range cases {
			body := map[string]any{
				"model": "claude-sonnet-5-5",
				"system": []any{
					map[string]any{"type": "text", "text": tc.billing},
					map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
				},
				"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
				"messages": []any{map[string]any{"role": "user", "content": userMsg}},
			}
			v := VerifyOfficialClaudeCode(hdrs, body, true)
			if v.Official || v.AllowPassthrough {
				t.Fatalf("case %s MUST be rejected, got %+v", tc.name, v)
			}
		}
	})

	t.Run("session_header_mismatch_and_foreign_system_block_disables_passthrough", func(t *testing.T) {
		hdrs := validDirectCCHeaders("claude-cli/2.1.321 (external, cli)", "30000000-0000-4000-a000-000000000003")
		body := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}
		vMismatch := VerifyOfficialClaudeCode(hdrs, body, true)
		if vMismatch.Official || vMismatch.AllowPassthrough {
			t.Fatalf("mismatched x-claude-code-session-id MUST be rejected, got %+v", vMismatch)
		}

		// Valid session header + appended foreign system block -> Official=true (direct Agent SDK),
		// but HasForeignSystem=true and AllowPassthrough=false!
		hdrsOK := validDirectCCHeaders("claude-cli/2.1.321 (external, cli)", testSessionV4)
		bodyForeign := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
				map[string]any{"type": "text", "text": "Custom third-party wrapper instructions appended here."},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}
		dec := Evaluate(ir.ProtoAnthropic, ir.TargetClaudeCRAG, hdrsOK, bodyForeign, settingsPassthroughOn())
		if !dec.HasForeignSystem || dec.AllowPassthrough {
			t.Fatalf("foreign system block MUST forbid passthrough, got %+v", dec)
		}
	})

	t.Run("node_go_parity_anchor_secmon_unanchored_uuid_case_deepseek_env_heading", func(t *testing.T) {
		// 1. Official identity placed in system[1] (after foreign system[0] without billing) must fail direct anchor.
		hdrs := validDirectCCHeaders("claude-cli/2.1.321 (external, cli)", testSessionV4)
		bodyMisplacedAnchor := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": "Custom preamble block"},
				map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}
		if v := VerifyOfficialClaudeCode(hdrs, bodyMisplacedAnchor, true); v.Official {
			t.Fatalf("misplaced official identity in system[1] without billing MUST fail, got %+v", v)
		}

		// 2. Direct 10KB/6-marker security monitor WITHOUT <transcript> or classify_result must fail;
		//    WITH <transcript> must pass.
		bodySecMonNoTranscript := map[string]any{
			"model": "claude-sonnet-5",
			"system": []any{
				map[string]any{"type": "text", "text": makeSecurityMonitorPrompt()},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
			"messages": []any{map[string]any{"role": "user", "content": "plain text without transcript"}},
		}
		if v := VerifyOfficialClaudeCode(hdrs, bodySecMonNoTranscript, true); v.Official {
			t.Fatalf("direct security monitor without <transcript>/classify_result MUST fail, got %+v", v)
		}
		bodySecMonWithTranscript := map[string]any{
			"model": "claude-sonnet-5",
			"system": []any{
				map[string]any{"type": "text", "text": makeSecurityMonitorPrompt()},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
			"messages": []any{map[string]any{"role": "user", "content": "<transcript>Bash ls</transcript>"}},
		}
		if v := VerifyOfficialClaudeCode(hdrs, bodySecMonWithTranscript, true); !v.Official {
			t.Fatalf("direct security monitor with <transcript> MUST pass, got %+v", v)
		}

		// 3. Tier 3b rejects unanchored billing header embedded inside multi-block system.
		proxiedHdrs := map[string]string{
			"user-agent":     "Go-http-client/2.0",
			"anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
		}
		bodyUnanchored := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
				map[string]any{"type": "text", "text": "You are an agent working with the user toward their goals.\n" + strings.Repeat("x", 220) + "\nx-anthropic-billing-header: cc_entrypoint=cli;"},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}
		if v := VerifyOfficialClaudeCode(proxiedHdrs, bodyUnanchored, true); v.Official {
			t.Fatalf("Tier 3b with unanchored billing mention MUST fail, got %+v", v)
		}

		// 4. Uppercase UUID in user_id must be rejected (lowercase-only parity with Node).
		upperSess := strings.ToUpper(testSessionV4)
		if IsValidStrictOfficialUserID(map[string]any{
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", upperSess)},
		}) {
			t.Fatalf("uppercase UUID in metadata.user_id MUST be rejected")
		}

		// 5. Broadened DeepSeek Harness clone signature ("powered by DeepSeek Harness").
		bodyDS := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
				map[string]any{"type": "text", "text": "This assistant is powered by DeepSeek Harness."},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}
		if v := VerifyOfficialClaudeCode(hdrs, bodyDS, true); v.Official || v.CloneID != "deepseek_harness" {
			t.Fatalf("broadened DeepSeek Harness clone MUST be rejected, got %+v", v)
		}

		// 6. Inline "# Environment" (not at line start) must still be treated as foreign.
		bodyInlineEnv := map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
				map[string]any{"type": "text", "text": "Custom third-party prompt mentioning # Environment inline."},
			},
			"metadata": map[string]any{"user_id": makeJSONUserID(testDeviceID64, "", testSessionV4)},
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}
		decInline := Evaluate(ir.ProtoAnthropic, ir.TargetClaudeCRAG, hdrs, bodyInlineEnv, settingsPassthroughOn())
		if !decInline.HasForeignSystem || decInline.AllowPassthrough {
			t.Fatalf("inline '# Environment' must NOT bypass foreign system check, got %+v", decInline)
		}
	})
}
