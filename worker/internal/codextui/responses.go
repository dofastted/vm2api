package codextui

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// sseWriter emits upstream-shaped `response.*` SSE frames. The control plane
// parses this vocabulary verbatim (see go-worker-client.mjs parseSseLines).
type sseWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
}

func newSSEWriter(w http.ResponseWriter) *sseWriter {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	fl, _ := w.(http.Flusher)
	return &sseWriter{w: w, flusher: fl}
}

func (s *sseWriter) event(name string, payload any) {
	buf, _ := json.Marshal(payload)
	fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", name, buf)
	if s.flusher != nil {
		s.flusher.Flush()
	}
}

// translate is the rollout→Responses-SSE reducer. It tracks the response id,
// item indices and final usage while items stream.
type translate struct {
	responseID string
	model      string
	output     []any
	itemSeq    int
	lastUsage  map[string]any
	err        string
	done       bool
	failed     bool
}

func newTranslate(sessionID, model string) *translate {
	return &translate{responseID: sessionID, model: model, output: []any{}}
}

// feed handles one rollout line; returns false when the turn reached a
// terminal state (complete/failed) and the caller should stop tailing.
func (t *translate) feed(l rolloutLine, emit func(event string, payload any)) bool {
	switch l.Type {
	case "response_item":
		t.onItem(l.Payload, emit)
	case "event_msg":
		return t.onEvent(l.Payload, emit)
	case "token_usage":
		t.onUsage(l.Payload)
	}
	return !t.done
}

type responseItem struct {
	Type      string          `json:"type"`
	Role      string          `json:"role"`
	Content   json.RawMessage `json:"content"`
	Name      string          `json:"name"`
	CallID    string          `json:"call_id"`
	Arguments string          `json:"arguments"`
	Status    string          `json:"status"`
	ID        string          `json:"id"`
}

func (t *translate) onItem(raw json.RawMessage, emit func(string, any)) {
	var it responseItem
	if json.Unmarshal(raw, &it) != nil {
		return
	}
	idx := t.itemSeq
	t.itemSeq++
	item := map[string]any{"type": it.Type}
	if it.ID != "" {
		item["id"] = it.ID
	}
	emit("response.output_item.added", map[string]any{
		"output_index": idx, "item": item,
	})
	switch it.Type {
	case "message":
		text := contentText(it.Content)
		emit("response.output_text.delta", map[string]any{
			"output_index": idx, "content_index": 0, "delta": text,
		})
		emit("response.output_text.done", map[string]any{
			"output_index": idx, "content_index": 0, "text": text,
		})
		item["role"] = it.Role
		item["content"] = []any{map[string]any{"type": "output_text", "text": text}}
		item["status"] = "completed"
	case "reasoning":
		item["summary"] = reasoningSummary(it.Content)
	}
	emit("response.output_item.done", map[string]any{
		"output_index": idx, "item": item,
	})
	t.output = append(t.output, item)
}

func reasoningSummary(raw json.RawMessage) []any {
	text := rawText(raw)
	return []any{map[string]any{"type": "summary_text", "text": text}}
}

type eventMsg struct {
	Type    string `json:"type"`
	Message string `json:"message"`
	Error   string `json:"error"`
}

func (t *translate) onEvent(raw json.RawMessage, emit func(string, any)) bool {
	var ev eventMsg
	if json.Unmarshal(raw, &ev) != nil {
		return true
	}
	switch ev.Type {
	case "task_complete", "turn_complete":
		t.done = true
		emit("response.completed", map[string]any{
			"response": t.finalResponse("completed"),
		})
	case "error", "turn_aborted":
		t.done, t.failed = true, true
		msg := ev.Error
		if msg == "" {
			msg = ev.Message
		}
		emit("response.failed", map[string]any{
			"response": t.finalResponse("failed"),
			"error":    map[string]any{"type": "server_error", "message": msg},
		})
	}
	return !t.done
}

func (t *translate) onUsage(raw json.RawMessage) {
	var u struct {
		Payload struct {
			InputTokens       int `json:"input_tokens"`
			CachedInputTokens int `json:"cached_input_tokens"`
			OutputTokens      int `json:"output_tokens"`
			ReasoningTokens   int `json:"reasoning_output_tokens"`
			TotalTokens       int `json:"total_tokens"`
		} `json:"payload"`
	}
	if json.Unmarshal(raw, &u) != nil {
		return
	}
	t.lastUsage = map[string]any{
		"input_tokens":          u.Payload.InputTokens,
		"output_tokens":         u.Payload.OutputTokens,
		"total_tokens":          u.Payload.TotalTokens,
		"input_tokens_details":  map[string]any{"cached_tokens": u.Payload.CachedInputTokens},
		"output_tokens_details": map[string]any{"reasoning_tokens": u.Payload.ReasoningTokens},
	}
}

func (t *translate) finalResponse(status string) map[string]any {
	resp := map[string]any{
		"id":     t.responseID,
		"object": "response",
		"status": status,
		"model":  t.model,
		"output": t.output,
	}
	if t.lastUsage != nil {
		resp["usage"] = t.lastUsage
	}
	return resp
}
