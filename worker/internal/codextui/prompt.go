package codextui

import (
	"encoding/json"
	"fmt"
	"strings"
)

// envelope is the control-plane request body on
// /internal/v1/codex/responses (see go-worker-client / handle-codex.mjs).
type envelope struct {
	Body    json.RawMessage   `json:"body"`
	Headers map[string]string `json:"headers"`
	Stream  bool              `json:"stream"`
	Session struct {
		SessionID          string `json:"session_id"`
		PreviousResponseID string `json:"previous_response_id"`
	} `json:"session"`
	Options struct {
		UpstreamTransport string         `json:"upstream_transport"`
		UserAgent         string         `json:"user_agent"`
		ClientFeatures    map[string]any `json:"client_features"`
		Analytics         bool           `json:"analytics"`
		TelemetryRuntime  bool           `json:"telemetry_runtime"`
		InstallationID    string         `json:"installation_id"`
	} `json:"options"`
	RequestID string `json:"request_id"`
}

// reqBody is the subset of the Responses API payload the helper consumes.
type reqBody struct {
	Model        string            `json:"model"`
	Instructions string            `json:"instructions"`
	Input        json.RawMessage   `json:"input"`
	Store        *bool             `json:"store"`
	Reasoning    map[string]any    `json:"reasoning"`
	Include      []string          `json:"include"`
	Metadata     map[string]string `json:"metadata"`
}

func (b *reqBody) modelOr(fallback string) string {
	if b.Model != "" {
		return b.Model
	}
	return fallback
}

// composePrompt renders instructions + input items into the plain text that
// is bracketed-pasted into the TUI composer. History items are replayed as
// text since each helper turn is a fresh TUI session.
func composePrompt(b *reqBody) (string, error) {
	var sb strings.Builder
	if strings.TrimSpace(b.Instructions) != "" {
		sb.WriteString("[instructions]\n")
		sb.WriteString(b.Instructions)
		sb.WriteString("\n\n")
	}
	if len(b.Input) == 0 {
		return strings.TrimSpace(sb.String()), nil
	}
	var asString string
	if json.Unmarshal(b.Input, &asString) == nil {
		sb.WriteString(asString)
		return strings.TrimSpace(sb.String()), nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(b.Input, &items); err != nil {
		return "", fmt.Errorf("input is neither string nor array")
	}
	for _, raw := range items {
		line := renderItem(raw)
		if line != "" {
			sb.WriteString(line)
			sb.WriteString("\n")
		}
	}
	return strings.TrimSpace(sb.String()), nil
}

type inputItem struct {
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	Name    string          `json:"name"`
	CallID  string          `json:"call_id"`
	Output  json.RawMessage `json:"output"`
	Args    string          `json:"arguments"`
	ID      string          `json:"id"`
}

func renderItem(raw json.RawMessage) string {
	var it inputItem
	if json.Unmarshal(raw, &it) != nil {
		return ""
	}
	switch it.Type {
	case "message", "":
		return fmt.Sprintf("[%s] %s", roleOr(it.Role, "user"), contentText(it.Content))
	case "function_call":
		return fmt.Sprintf("[tool_call %s] %s(%s)", it.CallID, it.Name, it.Args)
	case "function_call_output":
		return fmt.Sprintf("[tool_output %s] %s", it.CallID, rawText(it.Output))
	case "reasoning", "item_reference":
		return ""
	default:
		return fmt.Sprintf("[%s] %s", it.Type, rawText(it.Content))
	}
}

func roleOr(r, fallback string) string {
	if r == "" {
		return fallback
	}
	return r
}

// contentText extracts text from a message content array/string.
func contentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return ""
	}
	var sb strings.Builder
	for _, p := range parts {
		if p.Type == "input_text" || p.Type == "output_text" || p.Type == "text" || p.Type == "refusal" {
			sb.WriteString(p.Text)
		}
	}
	return sb.String()
}

func rawText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var v any
	if json.Unmarshal(raw, &v) == nil {
		if buf, err := json.Marshal(v); err == nil {
			return string(buf)
		}
	}
	return string(raw)
}
