package slotgate

import (
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func resetControllerConnection(t *testing.T, conn net.Conn) {
	t.Helper()
	secure, ok := conn.(*tls.Conn)
	if !ok {
		t.Fatal("expected TLS controller")
	}
	tcp, ok := secure.NetConn().(*net.TCPConn)
	if !ok {
		t.Fatal("expected TCP controller")
	}
	if err := tcp.SetLinger(0); err != nil {
		t.Fatal(err)
	}
	if err := tcp.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestNodeDrainsOriginalKernelAfterControllerDisconnect(t *testing.T) {
	for _, mode := range []string{"before-ok", "json", "sse"} {
		t.Run(mode, func(t *testing.T) {
			addr, root, server, state, _ := fencedGate(t)
			resume := make(chan struct{})
			var once sync.Once
			release := func() { once.Do(func() { close(resume) }) }
			defer release()
			finished := make(chan struct{})
			unixHTTP(t, filepath.Join(root, "vms", "v", "incarnations", state.Fence.Incarnation, "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(finished)
				if mode == "before-ok" {
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprint(w, normalClaudeJSON)
					return
				}
				if mode == "json" {
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprint(w, `{"id":"msg_detached","type":"message","role":"assistant","content":[{"type":"text","text":"`+strings.Repeat("x", 8192))
				} else {
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, strings.Split(normalClaudeSSE, "event: message_stop")[0]+":"+strings.Repeat("x", 8192)+"\n\n")
				}
				w.(http.Flusher).Flush()
				<-resume
				if mode == "json" {
					fmt.Fprint(w, `done"}],"stop_reason":"end_turn"}`)
				} else {
					fmt.Fprint(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
				}
			}))
			request := forwardRequest(t, addr, state, "disconnected-"+mode)
			if mode == "before-ok" {
				func() {
					server.authority.mu.Lock()
					defer server.authority.mu.Unlock()
					connection, _ := gate2Connect(t, addr, testToken, request, claudeWire(request.CommandID))
					resetControllerConnection(t, connection)
				}()
			} else {
				connection, reader := gate2Connect(t, addr, testToken, request, claudeWire(request.CommandID))
				if line, err := reader.ReadString('\n'); err != nil || line != "OK\n" {
					t.Fatalf("forward: %q %v", line, err)
				}
				response, err := http.ReadResponse(reader, nil)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = io.ReadFull(response.Body, make([]byte, 1)); err != nil {
					t.Fatal(err)
				}
				resetControllerConnection(t, connection)
				release()
			}
			select {
			case <-finished:
			case <-time.After(3 * time.Second):
				t.Fatal("kernel fixture did not finish")
			}
			waitCommandStatus(t, server.authority, request.CommandID, CommandCompleted)
		})
	}
}

func TestNodeDetachedDrainKeepsIncompleteOrErrorTerminalUnknown(t *testing.T) {
	for _, mode := range []string{"truncated", "trailing-error", "bad-trailer"} {
		t.Run(mode, func(t *testing.T) {
			addr, root, server, state, _ := fencedGate(t)
			resume := make(chan struct{})
			var once sync.Once
			release := func() { once.Do(func() { close(resume) }) }
			defer release()
			finished := make(chan struct{})
			unixHTTP(t, filepath.Join(root, "vms", "v", "incarnations", state.Fence.Incarnation, "run", "kernel.sock"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(finished)
				w.Header().Set("Content-Type", "text/event-stream")
				if mode == "bad-trailer" {
					w.Header().Set("Trailer", "X-Terminal-State")
				}
				fmt.Fprint(w, strings.Split(normalClaudeSSE, "event: message_stop")[0]+":"+strings.Repeat("x", 8192)+"\n\n")
				w.(http.Flusher).Flush()
				<-resume
				if mode != "truncated" {
					fmt.Fprint(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
				}
				if mode == "trailing-error" {
					fmt.Fprint(w, "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"provider_error\"}}\n\n")
				}
				if mode == "bad-trailer" {
					w.Header().Set("X-Terminal-State", "unknown")
				}
			}))
			request := forwardRequest(t, addr, state, "detached-unknown-"+mode)
			connection, reader := gate2Connect(t, addr, testToken, request, claudeWire(request.CommandID))
			if line, err := reader.ReadString('\n'); err != nil || line != "OK\n" {
				t.Fatalf("forward: %q %v", line, err)
			}
			response, err := http.ReadResponse(reader, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = io.ReadFull(response.Body, make([]byte, 1)); err != nil {
				t.Fatal(err)
			}
			resetControllerConnection(t, connection)
			release()
			select {
			case <-finished:
			case <-time.After(3 * time.Second):
				t.Fatal("kernel fixture did not finish")
			}
			until := time.Now().Add(time.Second)
			for time.Now().Before(until) {
				stored, _ := server.authority.State("v")
				if stored.Commands[request.CommandID].Status == CommandCompleted {
					t.Fatal("disconnected error/truncation was called completed")
				}
				time.Sleep(time.Millisecond)
			}
		})
	}
}

func TestNodeDetachedDeliveryBoundsStalledControllerWithoutEndingKernelRead(t *testing.T) {
	writer, reader := net.Pipe()
	defer writer.Close()
	defer reader.Close()
	sink := &detachedResponseWriter{connection: writer, writeTimeout: 5 * time.Millisecond}
	if n, err := sink.Write([]byte("first")); err != nil || n != 5 || !sink.detached {
		t.Fatalf("stalled delivery: %d %v %t", n, err, sink.detached)
	}
	if n, err := sink.Write([]byte("remaining kernel bytes")); err != nil || n != 22 {
		t.Fatalf("discarded delivery: %d %v", n, err)
	}
}
