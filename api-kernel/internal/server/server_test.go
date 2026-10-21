package server

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/api-kernel/internal/pool"
)

func TestForwardCopiesUpstream(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			t.Fatalf("path %s", r.URL.Path)
		}
		if r.Header.Get("X-Api-Key") != "sk-test" {
			t.Fatalf("missing x-api-key")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_, _ = io.WriteString(w, "data: {\"type\":\"message_stop\"}\n\n")
	}))
	defer up.Close()

	h := (&Server{Token: "t", Pool: pool.NewManager()}).Handler()
	env, _ := json.Marshal(forwardEnv{
		Method:  "POST",
		URL:     up.URL + "/v1/messages?beta=true",
		Headers: map[string]string{"x-api-key": "sk-test"},
		Body:    `{"model":"x"}`,
	})
	req := httptest.NewRequest(http.MethodPost, "/internal/forward", strings.NewReader(string(env)))
	req.Header.Set("X-Kin-Internal-Token", "t")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "message_stop") {
		t.Fatalf("body %s", rec.Body.String())
	}
}

func TestForwardStreamsTextDeltasBeforeUpstreamCompletes(t *testing.T) {
	allowSecond := make(chan struct{}, 1)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		_, _ = io.WriteString(w, "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"first\"}}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-allowSecond:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"second\"}}\n\n")
		w.(http.Flusher).Flush()
	}))
	defer up.Close()

	gateway := httptest.NewServer((&Server{Token: "t", Pool: pool.NewManager()}).Handler())
	defer gateway.Close()
	defer close(allowSecond)
	env, _ := json.Marshal(forwardEnv{URL: up.URL, Body: `{}`})
	req, _ := http.NewRequest(http.MethodPost, gateway.URL+"/internal/forward", strings.NewReader(string(env)))
	req.Header.Set("X-Kin-Internal-Token", "t")
	client := gateway.Client()
	client.Timeout = 3 * time.Second
	type firstRead struct {
		response *http.Response
		reader   *bufio.Reader
		line     string
		err      error
	}
	first := make(chan firstRead, 1)
	go func() {
		resp, err := client.Do(req)
		if err != nil {
			first <- firstRead{err: err}
			return
		}
		reader := bufio.NewReader(resp.Body)
		line, err := reader.ReadString('\n')
		first <- firstRead{response: resp, reader: reader, line: line, err: err}
	}()

	var got firstRead
	select {
	case got = <-first:
		if got.response != nil {
			defer got.response.Body.Close()
		}
		if got.err != nil {
			t.Fatal(got.err)
		}
	case <-time.After(time.Second):
		t.Fatal("first nonempty text delta was buffered while the upstream awaited the second delta")
	}
	if got.response.StatusCode != http.StatusOK || !strings.Contains(got.line, `"text":"first"`) {
		t.Fatalf("unexpected first delta: status=%d line=%q", got.response.StatusCode, got.line)
	}
	allowSecond <- struct{}{}
	rest, err := io.ReadAll(got.reader)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(rest), `"text":"second"`) {
		t.Fatalf("missing second text delta: %q", rest)
	}
}
