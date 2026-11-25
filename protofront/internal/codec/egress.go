package codec

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/dofastted/kin-gateway/protofront/internal/ir"
)

func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// TranscodeResponse converts an upstream SSE or JSON payload from upstreamProto
// back into the caller's inboundProto (fixing G1 Gemini cross-egress, G2 Codex reasoning ->
// Anthropic thinking_delta, G3 OpenAI API -> Anthropic, and G4 Codex -> text_completion SSE).
func TranscodeResponse(upstreamProto, inboundProto ir.Protocol, model string, stream bool, rawPayload string, restore ir.RestoreContext) (contentType string, out string, err error) {
	events, err := DecodeEvents(upstreamProto, rawPayload)
	if err != nil {
		return "", "", err
	}
	// Restore sanitized Gemini tool names if present.
	if len(restore.ToolNameMap) > 0 {
		for i := range events {
			if events[i].Name != "" {
				clean := StripGeminiToolPrefix(events[i].Name)
				if orig, ok := restore.ToolNameMap[events[i].Name]; ok {
					events[i].Name = orig
				} else if orig, ok := restore.ToolNameMap[clean]; ok {
					events[i].Name = orig
				} else {
					events[i].Name = clean
				}
			}
		}
	}
	if stream {
		return "text/event-stream; charset=utf-8", EncodeSSE(inboundProto, model, events), nil
	}
	body, err := EncodeJSON(inboundProto, model, events)
	if err != nil {
		return "", "", err
	}
	return "application/json", body, nil
}

// DecodeEvents parses either SSE frames or a single JSON response from Anthropic, Responses, or Gemini into []ir.Event.
func DecodeEvents(proto ir.Protocol, raw string) ([]ir.Event, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, nil
	}
	if strings.HasPrefix(trimmed, "{") {
		return decodeSingleJSON(proto, []byte(trimmed))
	}
	frames := splitSSEFrames(raw)
	var events []ir.Event
	switch proto {
	case ir.ProtoAnthropic:
		curBlockType := map[int]string{}
		curToolID := map[int]string{}
		curToolName := map[int]string{}
		var finalUsage ir.Usage
		for _, f := range frames {
			var obj map[string]any
			if json.Unmarshal([]byte(f.data), &obj) != nil {
				continue
			}
			typ := asString(obj["type"])
			switch typ {
			case "message_start":
				if msg, ok := obj["message"].(map[string]any); ok {
					ev := ir.Event{Kind: ir.EvStart, ID: asString(msg["id"]), Model: asString(msg["model"])}
					if u, ok := msg["usage"].(map[string]any); ok {
						finalUsage.InputTokens, _ = asInt(u["input_tokens"])
						finalUsage.CacheReadInputTokens, _ = asInt(u["cache_read_input_tokens"])
						finalUsage.CacheCreationInputTokens, _ = asInt(u["cache_creation_input_tokens"])
					}
					events = append(events, ev)
				}
			case "content_block_start":
				idx, _ := asInt(obj["index"])
				if cb, ok := obj["content_block"].(map[string]any); ok {
					bt := asString(cb["type"])
					curBlockType[idx] = bt
					switch bt {
					case "text":
						if t := asString(cb["text"]); t != "" {
							events = append(events, ir.Event{Kind: ir.EvText, Index: idx, Text: t})
						}
					case "thinking":
						if t := asString(cb["thinking"]); t != "" {
							events = append(events, ir.Event{Kind: ir.EvThinking, Index: idx, Text: t})
						}
					case "tool_use":
						id := asString(cb["id"])
						name := asString(cb["name"])
						curToolID[idx] = id
						curToolName[idx] = name
						events = append(events, ir.Event{Kind: ir.EvToolCallStart, Index: idx, CallID: id, Name: name})
					}
				}
			case "content_block_delta":
				idx, _ := asInt(obj["index"])
				if d, ok := obj["delta"].(map[string]any); ok {
					switch asString(d["type"]) {
					case "text_delta":
						events = append(events, ir.Event{Kind: ir.EvText, Index: idx, Text: asString(d["text"])})
					case "thinking_delta":
						events = append(events, ir.Event{Kind: ir.EvThinking, Index: idx, Text: asString(d["thinking"])})
					case "signature_delta":
						events = append(events, ir.Event{Kind: ir.EvThinkingSignature, Index: idx, Signature: asString(d["signature"])})
					case "input_json_delta":
						events = append(events, ir.Event{
							Kind:      ir.EvToolCallDelta,
							Index:     idx,
							CallID:    curToolID[idx],
							Name:      curToolName[idx],
							ArgsDelta: asString(d["partial_json"]),
						})
					}
				}
			case "content_block_stop":
				idx, _ := asInt(obj["index"])
				if curBlockType[idx] == "tool_use" {
					events = append(events, ir.Event{Kind: ir.EvToolCallDone, Index: idx, CallID: curToolID[idx], Name: curToolName[idx]})
				}
			case "message_delta":
				if u, ok := obj["usage"].(map[string]any); ok {
					if ot, ok := asInt(u["output_tokens"]); ok {
						finalUsage.OutputTokens = ot
					}
					finalUsage.TotalTokens = finalUsage.InputTokens + finalUsage.OutputTokens
					uCopy := finalUsage
					events = append(events, ir.Event{Kind: ir.EvUsage, Usage: &uCopy})
				}
				if d, ok := obj["delta"].(map[string]any); ok {
					events = append(events, ir.Event{
						Kind:         ir.EvStop,
						StopReason:   asString(d["stop_reason"]),
						StopSequence: asString(d["stop_sequence"]),
					})
				}
			}
		}
	case ir.ProtoResponses:
		toolCallByItem := map[string]struct{ callID, name string }{}
		sawTool := false
		for _, f := range frames {
			if f.data == "[DONE]" {
				continue
			}
			var obj map[string]any
			if json.Unmarshal([]byte(f.data), &obj) != nil {
				continue
			}
			typ := asString(obj["type"])
			switch typ {
			case "response.created":
				if r, ok := obj["response"].(map[string]any); ok {
					events = append(events, ir.Event{Kind: ir.EvStart, ID: asString(r["id"]), Model: asString(r["model"])})
				}
			case "response.output_text.delta":
				events = append(events, ir.Event{Kind: ir.EvText, Text: asString(obj["delta"])})
			case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
				// Preserved as EvThinking so Anthropic clients get real thinking_delta (fixes G2!).
				events = append(events, ir.Event{Kind: ir.EvThinking, Text: asString(obj["delta"])})
			case "response.output_item.added":
				if item, ok := obj["item"].(map[string]any); ok && asString(item["type"]) == "function_call" {
					sawTool = true
					itemID := asString(item["id"])
					cid := asString(item["call_id"])
					if cid == "" {
						cid = itemID
					}
					name := asString(item["name"])
					toolCallByItem[itemID] = struct{ callID, name string }{cid, name}
					events = append(events, ir.Event{Kind: ir.EvToolCallStart, CallID: cid, Name: name})
				}
			case "response.function_call_arguments.delta":
				itemID := asString(obj["item_id"])
				info := toolCallByItem[itemID]
				events = append(events, ir.Event{Kind: ir.EvToolCallDelta, CallID: info.callID, Name: info.name, ArgsDelta: asString(obj["delta"])})
			case "response.output_item.done":
				if item, ok := obj["item"].(map[string]any); ok && asString(item["type"]) == "function_call" {
					cid := asString(item["call_id"])
					if cid == "" {
						cid = asString(item["id"])
					}
					events = append(events, ir.Event{
						Kind:   ir.EvToolCallDone,
						CallID: cid,
						Name:   asString(item["name"]),
						Args:   normalizeToolArgsJSON(item["arguments"]),
					})
				}
			case "response.completed":
				if r, ok := obj["response"].(map[string]any); ok {
					if u, ok := r["usage"].(map[string]any); ok {
						inT, _ := asInt(u["input_tokens"])
						outT, _ := asInt(u["output_tokens"])
						totT, _ := asInt(u["total_tokens"])
						if totT == 0 {
							totT = inT + outT
						}
						var rT int
						if det, ok := u["output_tokens_details"].(map[string]any); ok {
							rT, _ = asInt(det["reasoning_tokens"])
						}
						events = append(events, ir.Event{Kind: ir.EvUsage, Usage: &ir.Usage{InputTokens: inT, OutputTokens: outT, TotalTokens: totT, ReasoningTokens: rT}})
					}
					sr := "end_turn"
					if sawTool {
						sr = "tool_use"
					}
					events = append(events, ir.Event{Kind: ir.EvStop, StopReason: sr})
				}
			}
		}
	case ir.ProtoGemini:
		for _, f := range frames {
			var obj map[string]any
			if json.Unmarshal([]byte(f.data), &obj) != nil {
				continue
			}
			sub, _ := decodeSingleJSON(ir.ProtoGemini, []byte(f.data))
			events = append(events, sub...)
		}
	}
	return events, nil
}

func decodeSingleJSON(proto ir.Protocol, data []byte) ([]ir.Event, error) {
	var obj map[string]any
	if err := json.Unmarshal(data, &obj); err != nil {
		return nil, err
	}
	var events []ir.Event
	switch proto {
	case ir.ProtoGemini:
		if cands, ok := obj["candidates"].([]any); ok && len(cands) > 0 {
			if c0, ok := cands[0].(map[string]any); ok {
				if content, ok := c0["content"].(map[string]any); ok {
					if parts, ok := content["parts"].([]any); ok {
						for _, rp := range parts {
							pm, ok := rp.(map[string]any)
							if !ok {
								continue
							}
							sig := asString(pm["thoughtSignature"])
							if isT, _ := asBool(pm["thought"]); isT {
								events = append(events, ir.Event{Kind: ir.EvThinking, Text: asString(pm["text"]), Signature: sig})
							} else if txt := asString(pm["text"]); txt != "" {
								events = append(events, ir.Event{Kind: ir.EvText, Text: txt})
							} else if fc, ok := pm["functionCall"].(map[string]any); ok {
								cid := asString(fc["id"])
								if cid == "" {
									cid = "call_gem_1"
								}
								events = append(events, ir.Event{
									Kind:      ir.EvToolCallDone,
									CallID:    cid,
									Name:      asString(fc["name"]),
									Args:      mustRaw(fc["args"]),
									Signature: sig,
								})
							}
						}
					}
				}
				if fr := asString(c0["finishReason"]); fr != "" {
					sr := "end_turn"
					if fr == "MAX_TOKENS" {
						sr = "max_tokens"
					}
					events = append(events, ir.Event{Kind: ir.EvStop, StopReason: sr})
				}
			}
		}
		if um, ok := obj["usageMetadata"].(map[string]any); ok {
			inT, _ := asInt(um["promptTokenCount"])
			outT, _ := asInt(um["candidatesTokenCount"])
			totT, _ := asInt(um["totalTokenCount"])
			events = append(events, ir.Event{Kind: ir.EvUsage, Usage: &ir.Usage{InputTokens: inT, OutputTokens: outT, TotalTokens: totT}})
		}
	case ir.ProtoAnthropic:
		events = append(events, ir.Event{Kind: ir.EvStart, ID: asString(obj["id"]), Model: asString(obj["model"])})
		if content, ok := obj["content"].([]any); ok {
			for _, cb := range content {
				m, _ := cb.(map[string]any)
				switch asString(m["type"]) {
				case "text":
					events = append(events, ir.Event{Kind: ir.EvText, Text: asString(m["text"])})
				case "thinking":
					events = append(events, ir.Event{Kind: ir.EvThinking, Text: asString(m["thinking"]), Signature: asString(m["signature"])})
				case "tool_use":
					events = append(events, ir.Event{Kind: ir.EvToolCallDone, CallID: asString(m["id"]), Name: asString(m["name"]), Args: mustRaw(m["input"])})
				}
			}
		}
		if u, ok := obj["usage"].(map[string]any); ok {
			inT, _ := asInt(u["input_tokens"])
			outT, _ := asInt(u["output_tokens"])
			events = append(events, ir.Event{Kind: ir.EvUsage, Usage: &ir.Usage{InputTokens: inT, OutputTokens: outT, TotalTokens: inT + outT}})
		}
		events = append(events, ir.Event{Kind: ir.EvStop, StopReason: asString(obj["stop_reason"])})
	case ir.ProtoResponses:
		events = append(events, ir.Event{Kind: ir.EvStart, ID: asString(obj["id"]), Model: asString(obj["model"])})
		sawTool := false
		if output, ok := obj["output"].([]any); ok {
			for _, item := range output {
				im, _ := item.(map[string]any)
				switch asString(im["type"]) {
				case "reasoning":
					if sum, ok := im["summary"].([]any); ok {
						for _, s := range sum {
							if sm, ok := s.(map[string]any); ok {
								if t := asString(sm["text"]); t != "" {
									events = append(events, ir.Event{Kind: ir.EvThinking, Text: t})
								}
							}
						}
					}
				case "message":
					if content, ok := im["content"].([]any); ok {
						for _, c := range content {
							if cm, ok := c.(map[string]any); ok {
								if t := asString(cm["text"]); t != "" {
									events = append(events, ir.Event{Kind: ir.EvText, Text: t})
								}
							}
						}
					}
				case "function_call":
					sawTool = true
					cid := asString(im["call_id"])
					if cid == "" {
						cid = asString(im["id"])
					}
					events = append(events, ir.Event{
						Kind:   ir.EvToolCallDone,
						CallID: cid,
						Name:   asString(im["name"]),
						Args:   normalizeToolArgsJSON(im["arguments"]),
					})
				}
			}
		}
		if u, ok := obj["usage"].(map[string]any); ok {
			inT, _ := asInt(u["input_tokens"])
			outT, _ := asInt(u["output_tokens"])
			totT, _ := asInt(u["total_tokens"])
			if totT == 0 {
				totT = inT + outT
			}
			var rT int
			if det, ok := u["output_tokens_details"].(map[string]any); ok {
				rT, _ = asInt(det["reasoning_tokens"])
			}
			events = append(events, ir.Event{Kind: ir.EvUsage, Usage: &ir.Usage{InputTokens: inT, OutputTokens: outT, TotalTokens: totT, ReasoningTokens: rT}})
		}
		sr := "end_turn"
		if sawTool {
			sr = "tool_use"
		}
		events = append(events, ir.Event{Kind: ir.EvStop, StopReason: sr})
	}
	return events, nil
}

type sseFrame struct {
	event string
	data  string
}

func splitSSEFrames(raw string) []sseFrame {
	norm := strings.ReplaceAll(raw, "\r\n", "\n")
	var out []sseFrame
	var ev string
	var dataLines []string
	flush := func() {
		if len(dataLines) > 0 {
			out = append(out, sseFrame{event: ev, data: strings.Join(dataLines, "\n")})
			dataLines = nil
		}
		ev = ""
	}
	for _, line := range strings.Split(norm, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, "event:") {
			if len(dataLines) > 0 {
				flush()
			}
			ev = strings.TrimSpace(line[6:])
			continue
		}
		if strings.HasPrefix(line, "data:") {
			payload := strings.TrimPrefix(line[5:], " ")
			// Support line-by-line relays that strip blank lines between single-line JSON data frames.
			if len(dataLines) > 0 {
				prev := strings.TrimSpace(strings.Join(dataLines, "\n"))
				if prev == "[DONE]" || json.Valid([]byte(prev)) {
					flush()
				}
			}
			dataLines = append(dataLines, payload)
		}
	}
	flush()
	return out
}

// EncodeSSE serializes normalized events to any of the 5 client SSE formats.
func EncodeSSE(proto ir.Protocol, model string, events []ir.Event) string {
	var sb strings.Builder
	writeEv := func(name string, payload any) {
		if name != "" {
			sb.WriteString("event: " + name + "\n")
		}
		switch p := payload.(type) {
		case string:
			sb.WriteString("data: " + p + "\n\n")
		default:
			b, _ := marshalNoEscape(p)
			sb.WriteString("data: " + string(b) + "\n\n")
		}
	}

	var usage ir.Usage
	stopReason := "end_turn"
	for _, ev := range events {
		if ev.Usage != nil {
			usage = *ev.Usage
		}
		if ev.StopReason != "" {
			stopReason = ev.StopReason
		}
	}

	switch proto {
	case ir.ProtoAnthropic:
		writeEv("message_start", map[string]any{
			"type": "message_start",
			"message": map[string]any{
				"id": "msg_proto_1", "type": "message", "role": "assistant", "model": model,
				"content": []any{}, "stop_reason": nil, "stop_sequence": nil,
				"usage": map[string]any{"input_tokens": usage.InputTokens, "output_tokens": 0},
			},
		})
		blockIdx := -1
		curKind := ""
		closeCur := func() {
			if curKind != "" {
				writeEv("content_block_stop", map[string]any{"type": "content_block_stop", "index": blockIdx})
				curKind = ""
			}
		}
		for _, ev := range events {
			switch ev.Kind {
			case ir.EvThinking:
				if curKind != "thinking" {
					closeCur()
					blockIdx++
					curKind = "thinking"
					writeEv("content_block_start", map[string]any{"type": "content_block_start", "index": blockIdx, "content_block": map[string]any{"type": "thinking", "thinking": ""}})
				}
				writeEv("content_block_delta", map[string]any{"type": "content_block_delta", "index": blockIdx, "delta": map[string]any{"type": "thinking_delta", "thinking": ev.Text}})
			case ir.EvThinkingSignature:
				if curKind == "thinking" {
					writeEv("content_block_delta", map[string]any{"type": "content_block_delta", "index": blockIdx, "delta": map[string]any{"type": "signature_delta", "signature": ev.Signature}})
				}
			case ir.EvText:
				if curKind != "text" {
					closeCur()
					blockIdx++
					curKind = "text"
					writeEv("content_block_start", map[string]any{"type": "content_block_start", "index": blockIdx, "content_block": map[string]any{"type": "text", "text": ""}})
				}
				writeEv("content_block_delta", map[string]any{"type": "content_block_delta", "index": blockIdx, "delta": map[string]any{"type": "text_delta", "text": ev.Text}})
			case ir.EvToolCallStart:
				closeCur()
				blockIdx++
				curKind = "tool_use"
				writeEv("content_block_start", map[string]any{"type": "content_block_start", "index": blockIdx, "content_block": map[string]any{"type": "tool_use", "id": ev.CallID, "name": ev.Name, "input": map[string]any{}}})
			case ir.EvToolCallDelta:
				if curKind == "tool_use" {
					writeEv("content_block_delta", map[string]any{"type": "content_block_delta", "index": blockIdx, "delta": map[string]any{"type": "input_json_delta", "partial_json": ev.ArgsDelta}})
				}
			case ir.EvToolCallDone:
				if curKind != "tool_use" {
					closeCur()
					blockIdx++
					curKind = "tool_use"
					writeEv("content_block_start", map[string]any{"type": "content_block_start", "index": blockIdx, "content_block": map[string]any{"type": "tool_use", "id": ev.CallID, "name": ev.Name, "input": map[string]any{}}})
					if len(ev.Args) > 0 {
						writeEv("content_block_delta", map[string]any{"type": "content_block_delta", "index": blockIdx, "delta": map[string]any{"type": "input_json_delta", "partial_json": string(ev.Args)}})
					}
				}
				closeCur()
			}
		}
		closeCur()
		writeEv("message_delta", map[string]any{
			"type":  "message_delta",
			"delta": map[string]any{"stop_reason": stopReason, "stop_sequence": nil},
			"usage": map[string]any{"output_tokens": usage.OutputTokens},
		})
		writeEv("message_stop", map[string]any{"type": "message_stop"})

	case ir.ProtoCompletions:
		// Fixes G4: emit true text_completion chunks for openai.completions!
		for _, ev := range events {
			if ev.Kind == ir.EvText && ev.Text != "" {
				writeEv("", map[string]any{
					"id": "cmpl_proto_1", "object": "text_completion", "model": model,
					"choices": []any{map[string]any{"index": 0, "text": ev.Text, "finish_reason": nil}},
				})
			}
		}
		writeEv("", map[string]any{
			"id": "cmpl_proto_1", "object": "text_completion", "model": model,
			"choices": []any{map[string]any{"index": 0, "text": "", "finish_reason": toOpenAIFinish(stopReason)}},
			"usage":   map[string]any{"prompt_tokens": usage.InputTokens, "completion_tokens": usage.OutputTokens, "total_tokens": usage.InputTokens + usage.OutputTokens},
		})
		writeEv("", "[DONE]")

	case ir.ProtoChat:
		writeEv("", map[string]any{
			"id": "chatcmpl_proto_1", "object": "chat.completion.chunk", "model": model,
			"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"role": "assistant"}, "finish_reason": nil}},
		})
		toolIdx := -1
		for _, ev := range events {
			switch ev.Kind {
			case ir.EvText:
				writeEv("", map[string]any{
					"id": "chatcmpl_proto_1", "object": "chat.completion.chunk", "model": model,
					"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": ev.Text}, "finish_reason": nil}},
				})
			case ir.EvToolCallStart:
				toolIdx++
				writeEv("", map[string]any{
					"id": "chatcmpl_proto_1", "object": "chat.completion.chunk", "model": model,
					"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": toolIdx, "id": ev.CallID, "type": "function", "function": map[string]any{"name": ev.Name, "arguments": ""}}}}, "finish_reason": nil}},
				})
			case ir.EvToolCallDelta:
				if toolIdx >= 0 {
					writeEv("", map[string]any{
						"id": "chatcmpl_proto_1", "object": "chat.completion.chunk", "model": model,
						"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": toolIdx, "function": map[string]any{"arguments": ev.ArgsDelta}}}}, "finish_reason": nil}},
					})
				}
			}
		}
		writeEv("", map[string]any{
			"id": "chatcmpl_proto_1", "object": "chat.completion.chunk", "model": model,
			"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": toOpenAIFinish(stopReason)}},
			"usage":   map[string]any{"prompt_tokens": usage.InputTokens, "completion_tokens": usage.OutputTokens, "total_tokens": usage.InputTokens + usage.OutputTokens},
		})
		writeEv("", "[DONE]")

	case ir.ProtoGemini:
		// Fixes G1: symmetric Gemini SSE framing for cross-protocol Claude/Codex -> Gemini!
		var textBuf strings.Builder
		var parts []any
		argAccum := map[string]*strings.Builder{}
		for _, ev := range events {
			switch ev.Kind {
			case ir.EvThinking:
				parts = append(parts, map[string]any{"thought": true, "text": ev.Text})
			case ir.EvText:
				textBuf.WriteString(ev.Text)
			case ir.EvToolCallStart:
				argAccum[ev.CallID] = &strings.Builder{}
			case ir.EvToolCallDelta:
				if b := argAccum[ev.CallID]; b != nil {
					b.WriteString(ev.ArgsDelta)
				}
			case ir.EvToolCallDone:
				rawArgs := ev.Args
				if len(rawArgs) == 0 {
					if b := argAccum[ev.CallID]; b != nil && b.Len() > 0 {
						rawArgs = normalizeToolArgsJSON(b.String())
					}
				}
				var args any = map[string]any{}
				if len(rawArgs) > 0 {
					_ = json.Unmarshal(rawArgs, &args)
				}
				parts = append(parts, map[string]any{"functionCall": map[string]any{"id": ev.CallID, "name": ev.Name, "args": args}})
			}
		}
		if textBuf.Len() > 0 {
			parts = append(parts, map[string]any{"text": textBuf.String()})
		}
		if len(parts) == 0 {
			parts = []any{map[string]any{"text": ""}}
		}
		writeEv("", map[string]any{
			"candidates":    []any{map[string]any{"index": 0, "content": map[string]any{"role": "model", "parts": parts}, "finishReason": toGeminiFinish(stopReason)}},
			"usageMetadata": map[string]any{"promptTokenCount": usage.InputTokens, "candidatesTokenCount": usage.OutputTokens, "totalTokenCount": usage.InputTokens + usage.OutputTokens},
			"modelVersion":  model,
		})

	case ir.ProtoResponses:
		writeEv("response.created", map[string]any{"type": "response.created", "response": map[string]any{"id": "resp_proto_1", "object": "response", "model": model, "status": "in_progress", "output": []any{}}})
		var fullText strings.Builder
		for _, ev := range events {
			if ev.Kind == ir.EvText {
				fullText.WriteString(ev.Text)
				writeEv("response.output_text.delta", map[string]any{"type": "response.output_text.delta", "item_id": "msg_proto_1", "output_index": 0, "content_index": 0, "delta": ev.Text})
			}
		}
		writeEv("response.completed", map[string]any{
			"type": "response.completed",
			"response": map[string]any{
				"id": "resp_proto_1", "object": "response", "model": model, "status": "completed",
				"output": []any{map[string]any{"type": "message", "id": "msg_proto_1", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": fullText.String()}}}},
				"usage":  map[string]any{"input_tokens": usage.InputTokens, "output_tokens": usage.OutputTokens, "total_tokens": usage.InputTokens + usage.OutputTokens},
			},
		})
	}
	return sb.String()
}

// EncodeJSON renders collected IR events into a complete non-streaming JSON body for any protocol.
func EncodeJSON(proto ir.Protocol, model string, events []ir.Event) (string, error) {
	var textBuf, thinkBuf strings.Builder
	var thinkSig string
	var toolCalls []ir.Event
	argAccum := map[string]*strings.Builder{}
	var usage ir.Usage
	stopReason := "end_turn"
	for _, ev := range events {
		switch ev.Kind {
		case ir.EvText:
			textBuf.WriteString(ev.Text)
		case ir.EvThinking:
			thinkBuf.WriteString(ev.Text)
			if ev.Signature != "" {
				thinkSig = ev.Signature
			}
		case ir.EvThinkingSignature:
			thinkSig = ev.Signature
		case ir.EvToolCallStart:
			argAccum[ev.CallID] = &strings.Builder{}
		case ir.EvToolCallDelta:
			if b := argAccum[ev.CallID]; b != nil {
				b.WriteString(ev.ArgsDelta)
			}
		case ir.EvToolCallDone:
			if len(ev.Args) == 0 {
				if b := argAccum[ev.CallID]; b != nil && b.Len() > 0 {
					ev.Args = normalizeToolArgsJSON(b.String())
				} else {
					ev.Args = json.RawMessage(`{}`)
				}
			}
			toolCalls = append(toolCalls, ev)
		case ir.EvUsage:
			if ev.Usage != nil {
				usage = *ev.Usage
			}
		case ir.EvStop:
			if ev.StopReason != "" {
				stopReason = ev.StopReason
			}
		}
	}
	if len(toolCalls) > 0 && stopReason == "end_turn" {
		stopReason = "tool_use"
	}

	var doc any
	switch proto {
	case ir.ProtoAnthropic:
		var content []any
		if thinkBuf.Len() > 0 {
			tb := map[string]any{"type": "thinking", "thinking": thinkBuf.String()}
			if thinkSig != "" {
				tb["signature"] = thinkSig
			}
			content = append(content, tb)
		}
		if textBuf.Len() > 0 {
			content = append(content, map[string]any{"type": "text", "text": textBuf.String()})
		}
		for _, tc := range toolCalls {
			var inp any = map[string]any{}
			_ = json.Unmarshal(tc.Args, &inp)
			content = append(content, map[string]any{"type": "tool_use", "id": tc.CallID, "name": tc.Name, "input": inp})
		}
		doc = map[string]any{
			"id": "msg_proto_1", "type": "message", "role": "assistant", "model": model,
			"content": content, "stop_reason": stopReason, "stop_sequence": nil,
			"usage": map[string]any{"input_tokens": usage.InputTokens, "output_tokens": usage.OutputTokens},
		}
	case ir.ProtoGemini:
		var parts []any
		if thinkBuf.Len() > 0 {
			p := map[string]any{"thought": true, "text": thinkBuf.String()}
			if thinkSig != "" {
				p["thoughtSignature"] = thinkSig
			}
			parts = append(parts, p)
		}
		if textBuf.Len() > 0 {
			parts = append(parts, map[string]any{"text": textBuf.String()})
		}
		for _, tc := range toolCalls {
			var args any = map[string]any{}
			_ = json.Unmarshal(tc.Args, &args)
			parts = append(parts, map[string]any{"functionCall": map[string]any{"id": tc.CallID, "name": tc.Name, "args": args}})
		}
		if len(parts) == 0 {
			parts = []any{map[string]any{"text": ""}}
		}
		doc = map[string]any{
			"candidates":    []any{map[string]any{"index": 0, "content": map[string]any{"role": "model", "parts": parts}, "finishReason": toGeminiFinish(stopReason)}},
			"usageMetadata": map[string]any{"promptTokenCount": usage.InputTokens, "candidatesTokenCount": usage.OutputTokens, "totalTokenCount": usage.InputTokens + usage.OutputTokens},
			"modelVersion":  model,
		}
	case ir.ProtoChat:
		msg := map[string]any{"role": "assistant", "content": textBuf.String()}
		if len(toolCalls) > 0 {
			var tcs []any
			for _, tc := range toolCalls {
				tcs = append(tcs, map[string]any{"id": tc.CallID, "type": "function", "function": map[string]any{"name": tc.Name, "arguments": string(tc.Args)}})
			}
			msg["tool_calls"] = tcs
			if textBuf.Len() == 0 {
				msg["content"] = nil
			}
		}
		doc = map[string]any{
			"id": "chatcmpl_proto_1", "object": "chat.completion", "model": model,
			"choices": []any{map[string]any{"index": 0, "message": msg, "finish_reason": toOpenAIFinish(stopReason)}},
			"usage":   map[string]any{"prompt_tokens": usage.InputTokens, "completion_tokens": usage.OutputTokens, "total_tokens": usage.InputTokens + usage.OutputTokens},
		}
	case ir.ProtoCompletions:
		doc = map[string]any{
			"id": "cmpl_proto_1", "object": "text_completion", "model": model,
			"choices": []any{map[string]any{"index": 0, "text": textBuf.String(), "finish_reason": toOpenAIFinish(stopReason)}},
			"usage":   map[string]any{"prompt_tokens": usage.InputTokens, "completion_tokens": usage.OutputTokens, "total_tokens": usage.InputTokens + usage.OutputTokens},
		}
	case ir.ProtoResponses:
		var output []any
		if thinkBuf.Len() > 0 {
			rItem := map[string]any{"type": "reasoning", "id": "rs_proto_1", "summary": []any{map[string]any{"type": "summary_text", "text": thinkBuf.String()}}}
			if thinkSig != "" {
				block, _ := json.Marshal(map[string]any{"type": "thinking", "thinking": thinkBuf.String(), "signature": thinkSig})
				rItem["encrypted_content"] = ir.SealClaudeBlock(block)
			}
			output = append(output, rItem)
		}
		if textBuf.Len() > 0 {
			output = append(output, map[string]any{"type": "message", "id": "msg_proto_1", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": textBuf.String()}}})
		}
		for _, tc := range toolCalls {
			output = append(output, map[string]any{"type": "function_call", "id": "fc_" + tc.CallID, "call_id": tc.CallID, "name": tc.Name, "arguments": string(tc.Args)})
		}
		doc = map[string]any{
			"id": "resp_proto_1", "object": "response", "model": model, "status": "completed",
			"output": output, "output_text": textBuf.String(),
			"usage": map[string]any{"input_tokens": usage.InputTokens, "output_tokens": usage.OutputTokens, "total_tokens": usage.InputTokens + usage.OutputTokens},
		}
	default:
		return "", fmt.Errorf("unsupported encode protocol %q", proto)
	}
	b, err := marshalNoEscape(doc)
	return string(b), err
}

func toOpenAIFinish(stopReason string) string {
	switch stopReason {
	case "tool_use":
		return "tool_calls"
	case "max_tokens":
		return "length"
	default:
		return "stop"
	}
}

func toGeminiFinish(stopReason string) string {
	switch stopReason {
	case "max_tokens":
		return "MAX_TOKENS"
	case "refusal":
		return "SAFETY"
	default:
		return "STOP"
	}
}
