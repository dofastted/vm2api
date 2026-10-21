package slotgate

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const receiptClaudeJSON = `{"id":"msg_receipt","type":"message","role":"assistant","model":"claude-synthetic-actual","content":[{"type":"text","text":"private response body"}],"stop_reason":"end_turn","usage":{"input_tokens":9007199254740993,"output_tokens":7,"cache_read_input_tokens":11,"cache_creation_input_tokens":5,"cache_creation":{"ephemeral_5m_input_tokens":2,"ephemeral_1h_input_tokens":3},"server_tool_use":{"web_search_requests":1}},"speed":"fast","service_tier":"priority","headers":{"authorization":"synthetic-secret"}}`

func receiptRecoveryReply(t *testing.T, addr string, request gate2Request) map[string]any {
	t.Helper()
	request.Op = "recovery-status"
	request.Ticket, request.Kind = "", ""
	c, reader := gate2Connect(t, addr, testToken, request, "")
	defer c.Close()
	var reply map[string]any
	if err := json.NewDecoder(reader).Decode(&reply); err != nil {
		t.Fatal(err)
	}
	return reply
}

func receiptForward(t *testing.T, media, body string, detached bool) (string, *Server, gate2Request) {
	t.Helper()
	addr, root, server, state, _ := fencedGate(t)
	resume := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(resume) }) }
	defer release()
	unixHTTP(t, filepath.Join(root, "vms", "v", "incarnations", state.Fence.Incarnation, "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", media)
		if detached {
			fmt.Fprint(w, body[:1])
			w.(http.Flusher).Flush()
			<-resume
			fmt.Fprint(w, body[1:])
		} else {
			fmt.Fprint(w, body)
		}
	}))
	request := forwardRequest(t, addr, state, "receipt-job")
	c, reader := gate2Connect(t, addr, testToken, request, claudeWire(request.CommandID))
	if line, err := reader.ReadString('\n'); err != nil || line != "OK\n" {
		t.Fatalf("forward: %q %v", line, err)
	}
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	if detached {
		if _, err = io.ReadFull(response.Body, make([]byte, 1)); err != nil {
			t.Fatal(err)
		}
		resetControllerConnection(t, c)
		release()
	} else {
		if _, err = io.Copy(io.Discard, response.Body); err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		c.Close()
	}
	waitCommandStatus(t, server.authority, request.CommandID, CommandCompleted)
	return addr, server, request
}

func requireInferenceReceipt(t *testing.T, reply map[string]any) map[string]any {
	t.Helper()
	receipt, ok := reply["receipt"].(map[string]any)
	if reply["ok"] != true || reply["found"] != true || !ok || receipt["id"] == nil || receipt["id"] == "" {
		t.Fatalf("completed command has no durable receipt: %+v", reply)
	}
	return receipt
}

func TestNodeInferenceReceiptPersistsExactPublicUsageWithOriginalCommand(t *testing.T) {
	addr, server, request := receiptForward(t, "application/json", receiptClaudeJSON, false)
	receipt := requireInferenceReceipt(t, receiptRecoveryReply(t, addr, request))
	usage, ok := receipt["usage"].(map[string]any)
	if !ok || receipt["usage_complete"] != true || receipt["model"] != "claude-synthetic-actual" || receipt["stop_reason"] != "end_turn" || receipt["service_tier"] != "priority" || receipt["speed"] != "fast" || usage["input_tokens"] != "9007199254740993" || usage["output_tokens"] != "7" {
		t.Fatalf("receipt lost exact observed values: %+v", receipt)
	}
	if detail, ok := usage["cache_creation"].(map[string]any); !ok || detail["ephemeral_5m_input_tokens"] != "2" || detail["ephemeral_1h_input_tokens"] != "3" {
		t.Fatalf("cache detail unavailable: %+v", usage)
	}
	encoded, _ := json.Marshal(receipt)
	for _, forbidden := range []string{"private response body", "synthetic-secret", "authorization", "headers", "USD", "request_id"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("receipt retained forbidden data %s", forbidden)
		}
	}
	if err := server.authority.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := authorityForTest(t, server.cfg.AuthorityDir, terminatedExecutor)
	state, err := reopened.State("v")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(state.Commands[request.CommandID])
	var command map[string]any
	json.Unmarshal(data, &command)
	persisted, ok := command["terminal_receipt"].(map[string]any)
	if !ok || persisted["id"] != receipt["id"] || command["status"] != string(CommandCompleted) {
		t.Fatalf("receipt not committed with original command: %+v", command)
	}
}

func TestNodeInferenceReceiptMergesCumulativeSSEWithoutSumming(t *testing.T) {
	body := "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_sse\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sse-actual\",\"usage\":{\"input_tokens\":8,\"output_tokens\":0,\"cache_read_input_tokens\":3,\"cache_creation_input_tokens\":2}}}\n\n" +
		"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{},\"usage\":{\"output_tokens\":4}}\n\n" +
		"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":9,\"cache_creation\":{\"ephemeral_5m_input_tokens\":2,\"ephemeral_1h_input_tokens\":0}},\"service_tier\":\"standard\"}\n\n" +
		"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	addr, _, request := receiptForward(t, "text/event-stream", body, false)
	receipt := requireInferenceReceipt(t, receiptRecoveryReply(t, addr, request))
	usage, ok := receipt["usage"].(map[string]any)
	if !ok || receipt["usage_complete"] != true || receipt["model"] != "claude-sse-actual" || usage["input_tokens"] != "8" || usage["output_tokens"] != "9" || usage["cache_read_input_tokens"] != "3" || receipt["service_tier"] != "standard" {
		t.Fatalf("SSE cumulative usage was lost or summed: %+v", receipt)
	}
}

func TestNodeInferenceReceiptMissingOrInvalidUsageDoesNotInventZeroOrHoldEndedExecution(t *testing.T) {
	for _, usage := range []string{"", `,"usage":{"input_tokens":1,"output_tokens":-1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}`, `,"usage":{"input_tokens":1,"output_tokens":1e3,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}`, `,"usage":{"input_tokens":1,"input_tokens":2,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}`} {
		t.Run(fmt.Sprintf("case-%d", len(usage)), func(t *testing.T) {
			body := `{"id":"msg_incomplete","type":"message","role":"assistant","content":[],"model":"claude-actual","stop_reason":"end_turn"` + usage + `}`
			addr, _, request := receiptForward(t, "application/json", body, false)
			receipt := requireInferenceReceipt(t, receiptRecoveryReply(t, addr, request))
			if receipt["usage_complete"] != false {
				t.Fatalf("invalid or missing usage was marked billable: %+v", receipt)
			}
			observed, ok := receipt["usage"].(map[string]any)
			if !ok {
				t.Fatal("missing usage object")
			}
			if _, exists := observed["output_tokens"]; exists {
				t.Fatalf("missing/invalid count was substituted: %+v", observed)
			}
		})
	}
}

func TestNodeInferenceReceiptSurvivesControllerDisconnect(t *testing.T) {
	addr, _, request := receiptForward(t, "application/json", receiptClaudeJSON, true)
	receipt := requireInferenceReceipt(t, receiptRecoveryReply(t, addr, request))
	if receipt["usage_complete"] != true {
		t.Fatalf("detached consumption lost usage: %+v", receipt)
	}
}
