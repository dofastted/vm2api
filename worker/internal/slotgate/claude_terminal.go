package slotgate

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strings"
)

const claudeTerminalJSONMax = 1 << 20
const claudeTerminalLineMax = 64 << 10
const claudeTerminalEventMax = 1 << 20

// claudeTerminal observes the existing Claude protocol without changing the
// forwarded bytes. It is intentionally stricter than the display assembler:
// stop_reason plus EOF without message_stop is not accepted for SSE. Errors,
// unknown frames and parser limits retain the command. No error text is used
// to turn an internal cancellation into a normal provider rejection.
type claudeTerminal struct {
	body      io.ReadCloser
	mode      string
	eligible  bool
	invalid   bool
	eof       bool
	read      int64
	jsonBody  []byte
	line      []byte
	data      []byte
	event     string
	started   bool
	stopped   bool
	blocks    map[int]bool
	nextBlock int
}

func observeClaudeTerminal(response *http.Response, request *http.Request, body []byte, commandID, kind string) *claudeTerminal {
	observer := &claudeTerminal{body: response.Body, blocks: map[int]bool{}}
	if kind != "kernel" || request.Method != http.MethodPost || request.URL.Path != "/internal/v1/messages" || request.URL.RawQuery != "" || response.StatusCode != http.StatusOK {
		return observer
	}
	var envelope struct {
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || envelope.RequestID != commandID {
		return observer
	}
	media, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || (media != "application/json" && media != "text/event-stream") {
		return observer
	}
	observer.mode = media
	observer.eligible = true
	return observer
}

func (o *claudeTerminal) Read(p []byte) (int, error) {
	n, err := o.body.Read(p)
	o.read += int64(n)
	if n > 0 && o.eligible && !o.invalid {
		o.observe(p[:n])
	}
	if err == io.EOF {
		o.eof = true
	} else if err != nil {
		o.reject()
	}
	return n, err
}

func (o *claudeTerminal) Close() error { return o.body.Close() }

func (o *claudeTerminal) reject() {
	o.invalid = true
	o.jsonBody = nil
	o.line = nil
	o.data = nil
	o.blocks = nil
}

func (o *claudeTerminal) observe(data []byte) {
	if o.mode == "application/json" {
		if len(o.jsonBody)+len(data) > claudeTerminalJSONMax {
			o.reject()
			return
		}
		o.jsonBody = append(o.jsonBody, data...)
		return
	}
	for _, b := range data {
		if b == '\n' {
			line := bytes.TrimSuffix(o.line, []byte{'\r'})
			o.observeLine(line)
			o.line = o.line[:0]
			if o.invalid {
				return
			}
		} else {
			if len(o.line) >= claudeTerminalLineMax {
				o.reject()
				return
			}
			o.line = append(o.line, b)
		}
	}
}

func (o *claudeTerminal) observeLine(line []byte) {
	if len(line) == 0 {
		if len(o.data) > 0 {
			o.observeEvent()
		} else if o.event != "" && o.event != "ping" {
			o.reject()
			return
		}
		o.data = o.data[:0]
		o.event = ""
		return
	}
	if line[0] == ':' {
		return
	}
	name, value, found := bytes.Cut(line, []byte{':'})
	if !found {
		o.reject()
		return
	}
	value = bytes.TrimPrefix(value, []byte{' '})
	switch string(name) {
	case "data":
		if len(o.data)+len(value)+1 > claudeTerminalEventMax {
			o.reject()
			return
		}
		if len(o.data) > 0 {
			o.data = append(o.data, '\n')
		}
		o.data = append(o.data, value...)
	case "event":
		o.event = string(value)
	case "id", "retry":
		// SSE transport metadata is not evidence of completion.
	default:
		o.reject()
	}
}

func normalClaudeStop(reason string) bool {
	switch reason {
	case "end_turn", "tool_use", "max_tokens", "stop_sequence":
		return true
	}
	return false
}

func presentJSON(raw json.RawMessage) bool {
	return len(raw) != 0 && !bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

type claudeMessage struct {
	ID         string          `json:"id"`
	Type       string          `json:"type"`
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	StopReason string          `json:"stop_reason"`
	Error      json.RawMessage `json:"error"`
	Response   struct {
		Error json.RawMessage `json:"error"`
	} `json:"response"`
}

func normalClaudeBlock(kind string) bool {
	switch kind {
	case "text", "thinking", "redacted_thinking", "tool_use", "server_tool_use":
		return true
	}
	return false
}

func assistantMessage(message *claudeMessage) bool {
	if message == nil || message.ID == "" || message.Type != "message" || message.Role != "assistant" || presentJSON(message.Error) || presentJSON(message.Response.Error) {
		return false
	}
	var content []json.RawMessage
	if err := json.Unmarshal(message.Content, &content); err != nil || content == nil {
		return false
	}
	for _, raw := range content {
		var block struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(raw, &block); err != nil || !normalClaudeBlock(block.Type) {
			return false
		}
	}
	return true
}

func (o *claudeTerminal) observeEvent() {
	var event struct {
		Type         string          `json:"type"`
		Message      *claudeMessage  `json:"message"`
		Index        *int            `json:"index"`
		Delta        json.RawMessage `json:"delta"`
		ContentBlock json.RawMessage `json:"content_block"`
		Error        json.RawMessage `json:"error"`
		Response     struct {
			Error json.RawMessage `json:"error"`
		} `json:"response"`
	}
	if err := json.Unmarshal(o.data, &event); err != nil || presentJSON(event.Error) || presentJSON(event.Response.Error) || (o.event != "" && o.event != event.Type) {
		o.reject()
		return
	}
	switch event.Type {
	case "message_start":
		if o.started || o.stopped || !assistantMessage(event.Message) {
			o.reject()
			return
		}
		o.started = true
	case "message_stop":
		if !o.started || o.stopped || len(o.blocks) != 0 {
			o.reject()
			return
		}
		o.stopped = true
	case "content_block_start":
		if !o.started || o.stopped || event.Index == nil || *event.Index != o.nextBlock || o.blocks[*event.Index] {
			o.reject()
			return
		}
		var block struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(event.ContentBlock, &block); err != nil || !normalClaudeBlock(block.Type) {
			o.reject()
			return
		}
		o.blocks[*event.Index] = true
		o.nextBlock++
	case "content_block_delta", "content_block_stop":
		if !o.started || o.stopped || event.Index == nil || !o.blocks[*event.Index] {
			o.reject()
			return
		}
		if event.Type == "content_block_stop" {
			delete(o.blocks, *event.Index)
		} else {
			var delta struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(event.Delta, &delta); err != nil {
				o.reject()
				return
			}
			switch delta.Type {
			case "text_delta", "thinking_delta", "input_json_delta", "signature_delta":
			default:
				o.reject()
				return
			}
		}
	case "message_delta":
		if !o.started || o.stopped || len(o.blocks) != 0 {
			o.reject()
			return
		}
		var delta struct {
			StopReason string `json:"stop_reason"`
		}
		if !bytes.HasPrefix(bytes.TrimSpace(event.Delta), []byte{'{'}) {
			o.reject()
			return
		}
		if err := json.Unmarshal(event.Delta, &delta); err != nil || (delta.StopReason != "" && !normalClaudeStop(delta.StopReason)) {
			o.reject()
			return
		}
	case "ping", "response_headers":
		// Kernel metadata may precede a message or follow message_stop. An
		// error/unknown event still invalidates even an earlier message_stop.
	default:
		o.reject()
	}
}

func (o *claudeTerminal) completed(response *http.Response) bool {
	if !o.eligible || o.invalid {
		return false
	}
	if response.ContentLength >= 0 {
		if o.read != response.ContentLength {
			return false
		}
	} else if !o.eof {
		return false
	}
	terminal, declared := response.Trailer[http.CanonicalHeaderKey("X-Terminal-State")]
	if declared && len(terminal) == 0 {
		return false
	}
	if !declared {
		terminal = response.Header.Values("X-Terminal-State")
	}
	for _, value := range terminal {
		if (declared && value == "") || (value != "" && value != "verified") {
			return false
		}
	}
	if o.mode == "application/json" {
		var message claudeMessage
		if err := json.Unmarshal(o.jsonBody, &message); err != nil {
			return false
		}
		return assistantMessage(&message) && normalClaudeStop(message.StopReason)
	}
	return o.eof && o.started && o.stopped && len(o.blocks) == 0 && len(o.line) == 0 && len(o.data) == 0 && strings.TrimSpace(o.event) == ""
}
