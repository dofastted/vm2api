package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dofastted/kin-gateway/protofront/internal/detect"
	"github.com/dofastted/kin-gateway/protofront/internal/ir"
)

func boolPtr(b bool) *bool { return &b }

func officialCCHeaders() map[string]string {
	return map[string]string{
		"user-agent":        "claude-cli/2.1.321 (external, sdk-cli)",
		"x-app":             "cli",
		"anthropic-version": "2023-06-01",
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-beta":              "claude-code-20250219,interleaved-thinking-2025-05-14",
		"x-stainless-lang":            "js",
		"x-stainless-os":              "Linux",
		"x-stainless-arch":            "x64",
		"x-stainless-runtime":         "node",
		"x-stainless-runtime-version": "v26.12.1",
		"x-stainless-package-version": "0.128.0",
		"x-stainless-retry-count":     "0",
		"x-stainless-timeout":         "600",
		"x-claude-code-session-id":    "20000000-0000-4000-a000-000000000002",
	}
}

func officialCCUserID() string {
	b, _ := json.Marshal(map[string]any{
		"device_id":    strings.Repeat("a", 64),
		"account_uuid": "10000000-0000-4000-a000-000000000001",
		"session_id":   "20000000-0000-4000-a000-000000000002",
	})
	return string(b)
}

func officialCCBillingLine(firstUserText string) string {
	fp3 := detect.ComputeClaudeCodeFingerprintUTF16(firstUserText, "2.1.321")
	return "x-anthropic-billing-header: cc_version=2.1.321." + fp3 + "; cc_entrypoint=sdk-cli;"
}

func officialCCBody() map[string]any {
	return map[string]any{
		"model":      "claude-sonnet-5-5",
		"max_tokens": 1024,
		"system": []any{
			map[string]any{"type": "text", "text": officialCCBillingLine("check status")},
			map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude.", "cache_control": map[string]any{"type": "ephemeral"}},
		},
		"metadata": map[string]any{"user_id": officialCCUserID()},
		"messages": []any{
			map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "check status"}}},
		},
	}
}

func TestDoubleGatePassthroughMatrix_ClaudeCRAG(t *testing.T) {
	// 1. Official CC + WebSetting ON -> passthrough
	var settingsOn detect.WebSettings
	settingsOn.Compatibility.OfficialCCPassthrough = true
	resp := Compile(CompileRequest{
		InboundProtocol: ir.ProtoAnthropic,
		TargetFamily:    ir.TargetClaudeCRAG,
		Headers:         officialCCHeaders(),
		Body:            officialCCBody(),
		Routing:         settingsOn,
	})
	if !resp.OK || !resp.Decision.AllowPassthrough || resp.Mode != "passthrough" {
		t.Fatalf("expected official CC passthrough ON, got ok=%v mode=%s decision=%+v", resp.OK, resp.Mode, resp.Decision)
	}

	// 2. Official CC + WebSetting OFF -> convert (strip billing + identity)
	var settingsOff detect.WebSettings
	settingsOff.Compatibility.OfficialCCPassthrough = false
	respOff := Compile(CompileRequest{
		InboundProtocol: ir.ProtoAnthropic,
		TargetFamily:    ir.TargetClaudeCRAG,
		Headers:         officialCCHeaders(),
		Body:            officialCCBody(),
		Routing:         settingsOff,
	})
	if !respOff.OK || respOff.Decision.AllowPassthrough || respOff.Mode != "convert" {
		t.Fatalf("expected convert when switch OFF, got mode=%s decision=%+v", respOff.Mode, respOff.Decision)
	}
	if _, hasMeta := respOff.OutboundBody["metadata"]; hasMeta {
		t.Fatalf("expected metadata stripped on non-passthrough CRAG body")
	}

	// 3. Spoofed oh-my-pi + WebSetting ON -> MUST NOT passthrough
	spoofHdrs := officialCCHeaders()
	spoofHdrs["user-agent"] = "claude-cli/2.1.321 (oh-my-pi)"
	respSpoof := Compile(CompileRequest{
		InboundProtocol: ir.ProtoAnthropic,
		TargetFamily:    ir.TargetClaudeCRAG,
		Headers:         spoofHdrs,
		Body:            officialCCBody(),
		Routing:         settingsOn,
	})
	if !respSpoof.OK || respSpoof.Decision.AllowPassthrough || respSpoof.Decision.ClientClass != "oh_my_pi" {
		t.Fatalf("spoofed oh-my-pi must never passthrough: %+v", respSpoof.Decision)
	}

	// 4. Cross-protocol Chat + Official CC headers + WebSetting ON -> MUST NOT passthrough
	respCross := Compile(CompileRequest{
		InboundProtocol: ir.ProtoChat,
		TargetFamily:    ir.TargetClaudeCRAG,
		Headers:         officialCCHeaders(),
		Body: map[string]any{
			"model":    "claude-sonnet-5-5",
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		},
		Routing: settingsOn,
	})
	if !respCross.OK || respCross.Decision.AllowPassthrough || respCross.Decision.Reason != "cross_protocol_forbids_passthrough" {
		t.Fatalf("cross-protocol must never passthrough: %+v", respCross.Decision)
	}

	// 5. Proxied official CC (stripped UA, valid billing block + user_id) + WebSetting ON -> passthrough
	respProxied := Compile(CompileRequest{
		InboundProtocol: ir.ProtoAnthropic,
		TargetFamily:    ir.TargetClaudeCRAG,
		Headers:         map[string]string{"user-agent": "Go-http-client/2.0"},
		Body:            officialCCBody(),
		Routing:         settingsOn,
	})
	if !respProxied.OK || !respProxied.Decision.AllowPassthrough {
		t.Fatalf("expected proxied official CC passthrough, got %+v", respProxied.Decision)
	}
}

func TestClaudeCRAGAntiCollisionAndValidation(t *testing.T) {
	// Fail closed on unrepresentable n > 1
	respBadN := Compile(CompileRequest{
		InboundProtocol: ir.ProtoAnthropic,
		TargetFamily:    ir.TargetClaudeCRAG,
		Body: map[string]any{
			"model":    "claude-haiku-4-5",
			"n":        2,
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		},
	})
	if respBadN.OK || respBadN.Status != 400 || respBadN.Code != "invalid_kernel_request" {
		t.Fatalf("expected 400 invalid_kernel_request for n=2, got %+v", respBadN)
	}

	// Auto-repair 5m before 1h cache control order instead of violently returning 400
	var settingsOn detect.WebSettings
	settingsOn.Compatibility.OfficialCCPassthrough = true
	badTTL := officialCCBody()
	badTTL["system"] = []any{
		map[string]any{"type": "text", "text": officialCCBillingLine("tail")},
		map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude.", "cache_control": map[string]any{"type": "ephemeral", "ttl": "5m"}},
	}
	badTTL["messages"] = []any{
		map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "tail", "cache_control": map[string]any{"type": "ephemeral", "ttl": "1h"}}}},
	}
	respTTL := Compile(CompileRequest{
		InboundProtocol: ir.ProtoAnthropic,
		TargetFamily:    ir.TargetClaudeCRAG,
		Headers:         officialCCHeaders(),
		Body:            badTTL,
		Routing:         settingsOn,
	})
	if !respTTL.OK || respTTL.Mode != "passthrough" {
		t.Fatalf("expected auto-repaired passthrough on 5m before 1h, got %+v", respTTL)
	}
	msgs, _ := respTTL.OutboundBody["messages"].([]any)
	firstMsg, _ := msgs[0].(map[string]any)
	firstContent, _ := firstMsg["content"].([]any)
	tailBlk, _ := firstContent[0].(map[string]any)
	tailCC, _ := tailBlk["cache_control"].(map[string]any)
	if tailCC["ttl"] != "5m" {
		t.Fatalf("expected trailing 1h breakpoint downgraded to 5m, got %+v", tailCC)
	}

	// Auto-repair >4 breakpoints and thinking cache_control on non-passthrough without 400
	overBudget := map[string]any{
		"model": "claude-sonnet-5-5",
		"system": []any{
			map[string]any{"type": "text", "text": "s1", "cache_control": map[string]any{"type": "ephemeral", "ttl": "1h"}},
			map[string]any{"type": "text", "text": "s2", "cache_control": map[string]any{"type": "ephemeral", "ttl": "1h"}},
		},
		"messages": []any{
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "text", "text": "u1", "cache_control": map[string]any{"type": "ephemeral", "ttl": "1h"}},
				map[string]any{"type": "text", "text": "u2", "cache_control": map[string]any{"type": "ephemeral", "ttl": "1h"}},
				map[string]any{"type": "text", "text": "u3", "cache_control": map[string]any{"type": "ephemeral", "ttl": "1h"}},
			}},
		},
	}
	respBudget := Compile(CompileRequest{
		InboundProtocol: ir.ProtoAnthropic,
		TargetFamily:    ir.TargetClaudeCRAG,
		Body:            overBudget,
	})
	if !respBudget.OK {
		t.Fatalf("expected >4 breakpoints to auto-repair instead of 400, got %+v", respBudget)
	}

	// TargetAPIAnthropic passthrough and non-passthrough also auto-repair >4 breakpoints and 5m->1h
	apiBad := officialCCBody()
	apiBad["system"] = []any{
		map[string]any{"type": "text", "text": officialCCBillingLine("a1")},
		map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude.", "cache_control": map[string]any{"type": "ephemeral", "ttl": "5m"}},
	}
	apiBad["messages"] = []any{
		map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "text", "text": "a1", "cache_control": map[string]any{"type": "ephemeral", "ttl": "1h"}},
			map[string]any{"type": "text", "text": "a2", "cache_control": map[string]any{"type": "ephemeral", "ttl": "1h"}},
			map[string]any{"type": "text", "text": "a3", "cache_control": map[string]any{"type": "ephemeral", "ttl": "1h"}},
			map[string]any{"type": "text", "text": "a4", "cache_control": map[string]any{"type": "ephemeral", "ttl": "1h"}},
		}},
	}
	respAPIPass := Compile(CompileRequest{
		InboundProtocol: ir.ProtoAnthropic,
		TargetFamily:    ir.TargetAPIAnthropic,
		HandoffMode:     "canonical",
		Headers:         officialCCHeaders(),
		Body:            apiBad,
		Routing:         settingsOn,
	})
	if !respAPIPass.OK || respAPIPass.Mode != "passthrough" {
		t.Fatalf("expected TargetAPIAnthropic passthrough auto-repair, got %+v", respAPIPass)
	}
	apiMsgs, _ := respAPIPass.OutboundBody["messages"].([]any)
	apiFirst, _ := apiMsgs[0].(map[string]any)
	apiContent, _ := apiFirst["content"].([]any)
	liveCount := 0
	for _, item := range apiContent {
		blk, _ := item.(map[string]any)
		if cc, ok := blk["cache_control"].(map[string]any); ok {
			liveCount++
			if cc["ttl"] != "5m" {
				t.Fatalf("expected TargetAPIAnthropic trailing 1h downgraded to 5m, got %+v", cc)
			}
		}
	}
	if liveCount != 3 {
		t.Fatalf("expected 1 system + 3 message breakpoints (4 total), got %d message markers", liveCount)
	}

	respAPIConv := Compile(CompileRequest{
		InboundProtocol: ir.ProtoAnthropic,
		TargetFamily:    ir.TargetAPIAnthropic,
		Body:            overBudget,
	})
	if !respAPIConv.OK || respAPIConv.Mode != "convert" {
		t.Fatalf("expected TargetAPIAnthropic convert auto-repair, got %+v", respAPIConv)
	}

	// Non-passthrough strips unsigned/dummy thinking, billing header, volatile token budget, folds mid-history system
	respStrip := Compile(CompileRequest{
		InboundProtocol: ir.ProtoAnthropic,
		TargetFamily:    ir.TargetClaudeCRAG,
		Body: map[string]any{
			"model": "claude-sonnet-5-5",
			"system": []any{
				map[string]any{"type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.200; cch=abc;"},
				map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
				map[string]any{"type": "text", "text": "Project rule <total_tokens>194321 tokens left</total_tokens>"},
			},
			"messages": []any{
				map[string]any{"role": "user", "content": "turn 1"},
				map[string]any{
					"role": "assistant",
					"content": []any{
						map[string]any{"type": "thinking", "thinking": "draft", "signature": "skip_thought_signature_validator"},
						map[string]any{"type": "text", "text": "reply 1"},
					},
				},
				map[string]any{"role": "system", "content": "Timezone: Asia/Shanghai"},
				map[string]any{"role": "user", "content": "turn 2"},
			},
		},
	})
	if !respStrip.OK {
		t.Fatalf("expected strip compile OK, got %+v", respStrip)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(respStrip.OutboundBody)
	s := buf.String()
	if strings.Contains(s, "x-anthropic-billing-header") {
		t.Fatalf("leaked billing header: %s", s)
	}
	if strings.Contains(s, "skip_thought_signature_validator") {
		t.Fatalf("leaked dummy thinking block: %s", s)
	}
	if strings.Contains(s, "194321 tokens left") || !strings.Contains(s, "15000000 tokens left") {
		t.Fatalf("did not stabilize volatile budget counter: %s", s)
	}
	if !strings.Contains(s, "<system-reminder>") {
		t.Fatalf("did not fold mid-history system turn: %s", s)
	}
}

func TestG1_GeminiCrossProtocolToClaudeAndCodex(t *testing.T) {
	gemBody := map[string]any{
		"systemInstruction": map[string]any{"parts": []any{map[string]any{"text": "FORMAT_RULE_8"}}},
		"contents":          []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": "hello cross"}}}},
		"generationConfig":  map[string]any{"maxOutputTokens": 256, "temperature": 0.2},
	}

	// G1: Gemini -> Claude CRAG
	respClaude := Compile(CompileRequest{
		InboundProtocol: ir.ProtoGemini,
		TargetFamily:    ir.TargetClaudeCRAG,
		RouteModel:      "claude-haiku-4-5",
		RouteStream:     boolPtr(false),
		Body:            gemBody,
	})
	if !respClaude.OK || respClaude.OutboundBody["model"] != "claude-haiku-4-5" {
		t.Fatalf("G1 Gemini->Claude failed: %+v", respClaude)
	}

	// G1: Gemini -> Codex Kernel
	respCodex := Compile(CompileRequest{
		InboundProtocol:   ir.ProtoGemini,
		TargetFamily:      ir.TargetCodexKernel,
		RouteModel:        "gpt-5.4",
		RouteStream:       boolPtr(false),
		OutboundSessionID: "sess-g1-codex",
		Body:              gemBody,
	})
	if !respCodex.OK || respCodex.OutboundBody["model"] != "gpt-5.4" || respCodex.OutboundBody["prompt_cache_key"] != "sess-g1-codex" {
		t.Fatalf("G1 Gemini->Codex failed: %+v", respCodex)
	}
}

func TestG2_G3_G4_AndClaudeSealStrip(t *testing.T) {
	// G2: Anthropic -> Codex preserves thinking/effort & transcodes reasoning SSE -> thinking_delta
	respG2 := Compile(CompileRequest{
		InboundProtocol: ir.ProtoAnthropic,
		TargetFamily:    ir.TargetCodexKernel,
		Body: map[string]any{
			"model":         "gpt-5.4",
			"max_tokens":    1024,
			"stream":        true,
			"thinking":      map[string]any{"type": "enabled", "budget_tokens": 2048},
			"output_config": map[string]any{"effort": "high"},
			"messages":      []any{map[string]any{"role": "user", "content": "think hard"}},
		},
	})
	if !respG2.OK {
		t.Fatalf("G2 compile failed: %+v", respG2)
	}
	reasoning, _ := respG2.OutboundBody["reasoning"].(map[string]any)
	if reasoning["effort"] != "high" {
		t.Fatalf("G2 expected reasoning.effort=high, got %+v", respG2.OutboundBody["reasoning"])
	}

	// G3: Anthropic -> API OpenAI preserves image as input_image + thinking as reasoning
	respG3 := Compile(CompileRequest{
		InboundProtocol: ir.ProtoAnthropic,
		TargetFamily:    ir.TargetAPIOpenAI,
		Body: map[string]any{
			"model":      "api-gpt-5.4",
			"max_tokens": 512,
			"thinking":   map[string]any{"type": "enabled", "budget_tokens": 1024},
			"messages": []any{
				map[string]any{
					"role": "user",
					"content": []any{
						map[string]any{"type": "text", "text": "inspect image"},
						map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": "AAAA"}},
					},
				},
			},
		},
	})
	if !respG3.OK {
		t.Fatalf("G3 compile failed: %+v", respG3)
	}
	bG3, _ := json.Marshal(respG3.OutboundBody)
	if !strings.Contains(string(bG3), `"input_image"`) || !strings.Contains(string(bG3), `"reasoning"`) {
		t.Fatalf("G3 expected input_image and reasoning, got %s", string(bG3))
	}

	// strip_claudeseal: Codex drops magpie-claude1: reasoning items even on official passthrough
	respSeal := Compile(CompileRequest{
		InboundProtocol: ir.ProtoResponses,
		TargetFamily:    ir.TargetCodexKernel,
		Headers:         map[string]string{"user-agent": "codex_cli_rs/0.170.0", "originator": "codex_cli_rs"},
		Body: map[string]any{
			"model":    "gpt-5.4",
			"base_url": "https://caller.internal",
			"input": []any{
				map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "prev"}}},
				map[string]any{"type": "reasoning", "encrypted_content": "magpie-claude1:eyJ0eXBlIjoidGhpbmtpbmcifQ==", "summary": []any{}},
				map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_text", "text": "next"}}},
			},
		},
		OutboundSessionID: "rebuilt-sess-1",
	})
	if !respSeal.OK || !respSeal.Decision.AllowPassthrough {
		t.Fatalf("expected official codex passthrough, got %+v", respSeal.Decision)
	}
	bSeal, _ := json.Marshal(respSeal.OutboundBody)
	if strings.Contains(string(bSeal), "magpie-claude1:") || strings.Contains(string(bSeal), "caller.internal") {
		t.Fatalf("Codex leaked claudeseal or base_url: %s", string(bSeal))
	}

	// G4 + G2 egress transcode via HTTP handler
	srv := &Server{Token: "test-tok"}
	h := srv.Handler()
	codexSSE := strings.Join([]string{
		`event: response.created`,
		`data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.4","status":"in_progress"}}`,
		``,
		`event: response.reasoning_summary_text.delta`,
		`data: {"type":"response.reasoning_summary_text.delta","delta":"checking row 7"}`,
		``,
		`event: response.output_text.delta`,
		`data: {"type":"response.output_text.delta","delta":"answer 7"}`,
		``,
		`event: response.completed`,
		`data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}`,
		``,
	}, "\n")

	// G2 SSE -> Anthropic must include thinking_delta
	payloadG2, _ := json.Marshal(TranscodeRequest{
		UpstreamProtocol: ir.ProtoResponses,
		InboundProtocol:  ir.ProtoAnthropic,
		Model:            "gpt-5.4",
		Stream:           true,
		Payload:          codexSSE,
	})
	req := httptest.NewRequest(http.MethodPost, "/internal/v1/transcode", bytes.NewReader(payloadG2))
	req.Header.Set("X-Kin-Internal-Token", "test-tok")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "thinking_delta") {
		t.Fatalf("G2 transcode expected thinking_delta, code=%d body=%s", rec.Code, rec.Body.String())
	}

	// G4 SSE -> Completions must emit text_completion
	payloadG4, _ := json.Marshal(TranscodeRequest{
		UpstreamProtocol: ir.ProtoResponses,
		InboundProtocol:  ir.ProtoCompletions,
		Model:            "gpt-5.4",
		Stream:           true,
		Payload:          codexSSE,
	})
	req4 := httptest.NewRequest(http.MethodPost, "/internal/v1/transcode", bytes.NewReader(payloadG4))
	req4.Header.Set("X-Kin-Internal-Token", "test-tok")
	rec4 := httptest.NewRecorder()
	h.ServeHTTP(rec4, req4)
	if rec4.Code != 200 || !strings.Contains(rec4.Body.String(), "text_completion") {
		t.Fatalf("G4 transcode expected text_completion, code=%d body=%s", rec4.Code, rec4.Body.String())
	}

	// Verify line-by-line SSE stream without blank lines between frames still decodes thinking_delta
	compactSSE := strings.ReplaceAll(codexSSE, "\n\n", "\n")
	payloadCompact, _ := json.Marshal(TranscodeRequest{
		UpstreamProtocol: ir.ProtoResponses,
		InboundProtocol:  ir.ProtoAnthropic,
		Model:            "gpt-5.4",
		Stream:           true,
		Payload:          compactSSE,
	})
	reqC := httptest.NewRequest(http.MethodPost, "/internal/v1/transcode", bytes.NewReader(payloadCompact))
	reqC.Header.Set("X-Kin-Internal-Token", "test-tok")
	recC := httptest.NewRecorder()
	h.ServeHTTP(recC, reqC)
	if recC.Code != 200 || !strings.Contains(recC.Body.String(), "thinking_delta") {
		t.Fatalf("compact SSE transcode expected thinking_delta, code=%d body=%s", recC.Code, recC.Body.String())
	}
}

func TestGeminiAntigravityAntiCollision(t *testing.T) {
	var settings detect.WebSettings
	settings.Compatibility.CragGeminiPromptNormalization = "strict"
	settings.Compatibility.CragGeminiSystemPrompt = "GLOBAL_POLICY"
	resp := Compile(CompileRequest{
		InboundProtocol: ir.ProtoAnthropic,
		TargetFamily:    ir.TargetGeminiAntigravity,
		Routing:         settings,
		Body: map[string]any{
			"model": "gemini-4-neon-xhigh",
			"system": []any{
				map[string]any{"type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.321; cch=00000;"},
				map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude.\nDual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context.\n```md\nYou are Claude Code inside code.\n```"},
			},
			"tools": []any{
				map[string]any{"name": "123run-tool", "description": "numeric tool", "input_schema": map[string]any{"type": "object", "properties": map[string]any{}}},
			},
			"messages": []any{
				map[string]any{"role": "user", "content": "/plan inspect <antigravity>"},
			},
		},
	})
	if !resp.OK {
		t.Fatalf("gemini compile failed: %+v", resp)
	}
	var gemBuf bytes.Buffer
	gemEnc := json.NewEncoder(&gemBuf)
	gemEnc.SetEscapeHTML(false)
	_ = gemEnc.Encode(resp.OutboundBody)
	s := gemBuf.String()
	if strings.Contains(s, "x-anthropic-billing-header") || strings.Contains(s, "C2 frameworks") {
		t.Fatalf("Gemini failed to strip 429 triggers: %s", s)
	}
	if !strings.Contains(s, "You are Claude Code inside code.") {
		t.Fatalf("Gemini corrupted fenced code block: %s", s)
	}
	if !strings.Contains(s, `\u200b/plan`) && !strings.Contains(s, "\u200b/plan") {
		t.Fatalf("Gemini failed to escape leading slash: %s", s)
	}
	if strings.Contains(s, "<antigravity>") {
		t.Fatalf("Gemini failed to deconflict host XML tag: %s", s)
	}
	if resp.RestoreContext.ToolNameMap["_x_123run-tool"] != "123run-tool" {
		t.Fatalf("Gemini failed to record _x_ restore mapping: %+v", resp.RestoreContext.ToolNameMap)
	}
}
