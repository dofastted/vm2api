package slotgate

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

const normalClaudeJSON = `{"id":"msg_normal","type":"message","role":"assistant","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}`
const normalClaudeSSE = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_normal\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"

func claudeWire(id string) string {
	body, _ := json.Marshal(map[string]any{"request_id": id, "body": map[string]any{"model": "synthetic-claude", "messages": []any{}}})
	return fmt.Sprintf("POST /internal/v1/messages HTTP/1.1\r\nHost: kernel\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s", len(body), body)
}

func waitCommandStatus(t *testing.T, a *Authority, id string, want CommandStatus) {
	t.Helper()
	until := time.Now().Add(time.Second)
	for {
		state, err := a.State("v")
		if err != nil {
			t.Fatal(err)
		}
		if state.Commands[id].Status == want {
			return
		}
		if time.Now().After(until) {
			t.Fatalf("command status=%s, want %s", state.Commands[id].Status, want)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestKSG2ClaudeNormalProtocolCompletionIsPersistedBeforeStatusAcknowledgement(t *testing.T) {
	for _, mode := range []string{"json", "sse"} {
		t.Run(mode, func(t *testing.T) {
			addr, root, server, state, _ := fencedGate(t)
			unixHTTP(t, filepath.Join(root, "vms", "v", "incarnations", state.Fence.Incarnation, "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if mode == "json" {
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprint(w, normalClaudeJSON)
				} else {
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, normalClaudeSSE)
				}
			}))
			req := forwardRequest(t, addr, state, "normal-"+mode)
			c, reader := gate2Connect(t, addr, testToken, req, claudeWire(req.CommandID))
			line, err := reader.ReadString('\n')
			if err != nil || line != "OK\n" {
				t.Fatalf("forward: %q %v", line, err)
			}
			response, err := http.ReadResponse(reader, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = io.Copy(io.Discard, response.Body); err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			c.Close()
			waitCommandStatus(t, server.authority, req.CommandID, CommandCompleted)
			req.Op = "command"
			c, reader = gate2Connect(t, addr, testToken, req, "")
			var reply struct {
				OK      bool `json:"ok"`
				Command struct {
					ID     string        `json:"id"`
					Status CommandStatus `json:"status"`
				} `json:"command"`
			}
			if err = json.NewDecoder(reader).Decode(&reply); err != nil {
				t.Fatal(err)
			}
			c.Close()
			if !reply.OK || reply.Command.ID != req.CommandID || reply.Command.Status != CommandCompleted {
				t.Fatalf("node status: %+v", reply)
			}
		})
	}
}

func TestKSG2ClaudeMessageStopWithoutHTTPCompletionRemainsPending(t *testing.T) {
	addr, root, server, state, _ := fencedGate(t)
	wrote, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	resume := func() { once.Do(func() { close(release) }) }
	defer resume()
	unixHTTP(t, filepath.Join(root, "vms", "v", "incarnations", state.Fence.Incarnation, "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, normalClaudeSSE)
		w.(http.Flusher).Flush()
		close(wrote)
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	req := forwardRequest(t, addr, state, "delayed-eof")
	c, reader := gate2Connect(t, addr, testToken, req, claudeWire(req.CommandID))
	defer c.Close()
	if line, err := reader.ReadString('\n'); err != nil || line != "OK\n" {
		t.Fatalf("forward: %q %v", line, err)
	}
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	<-wrote
	current, err := server.authority.State("v")
	if err != nil || current.Commands[req.CommandID].Status != CommandPending {
		t.Fatalf("message_stop alone completed: %+v %v", current, err)
	}
	resume()
	if _, err = io.Copy(io.Discard, response.Body); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	waitCommandStatus(t, server.authority, req.CommandID, CommandCompleted)
}

func TestKSG2ClaudeUnknownResponsesRemainPending(t *testing.T) {
	for _, tc := range []struct {
		name, contentType, body string
		status                  int
		truncate                bool
		trailer                 string
		requestID               string
	}{
		{"cancel-json", "application/json", `{"ok":false,"error":{"type":"worker_error","code":"provider_error","message":"provider error: client disconnected; 429 limit"}}`, 502, false, "", ""},
		{"generic-error", "application/json", `{"type":"error","error":{"type":"api_error","message":"provider error"}}`, 200, false, "", ""},
		{"verified-without-terminal", "application/json", `{"type":"message","role":"assistant","content":[]}`, 200, false, "", ""},
		{"truncated-json", "application/json", normalClaudeJSON, 200, true, "", ""},
		{"stop-no-http-end", "text/event-stream", normalClaudeSSE, 200, true, "", ""},
		{"missing-message-stop", "text/event-stream", "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n", 200, false, "", ""},
		{"error-after-stop", "text/event-stream", normalClaudeSSE + "data: {\"type\":\"error\",\"error\":{\"type\":\"worker_error\",\"message\":\"client disconnected\"}}\n\n", 200, false, "", ""},
		{"incomplete-trailer", "text/event-stream", normalClaudeSSE, 200, false, "incomplete", ""},
		{"wrong-job-id", "application/json", normalClaudeJSON, 200, false, "", "other-request"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			addr, root, server, state, _ := fencedGate(t)
			finished := make(chan struct{})
			unixHTTP(t, filepath.Join(root, "vms", "v", "incarnations", state.Fence.Incarnation, "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(finished)
				w.Header().Set("Content-Type", tc.contentType)
				w.Header().Set("X-Terminal-State", "verified")
				if tc.truncate {
					w.Header().Set("Content-Length", fmt.Sprint(len(tc.body)+20))
				}
				if tc.trailer != "" {
					w.Header().Set("Trailer", "X-Terminal-State")
				}
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
				if tc.trailer != "" {
					w.Header().Set("X-Terminal-State", tc.trailer)
				}
			}))
			req := forwardRequest(t, addr, state, tc.name)
			id := req.CommandID
			if tc.requestID != "" {
				id = tc.requestID
			}
			c, reader := gate2Connect(t, addr, testToken, req, claudeWire(id))
			if line, err := reader.ReadString('\n'); err != nil || line != "OK\n" {
				t.Fatalf("forward: %q %v", line, err)
			}
			response, err := http.ReadResponse(reader, nil)
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
			c.Close()
			<-finished
			time.Sleep(10 * time.Millisecond)
			current, err := server.authority.State("v")
			if err != nil || current.Commands[req.CommandID].Status != CommandPending {
				t.Fatalf("unknown response released: %+v %v", current, err)
			}
		})
	}
}
