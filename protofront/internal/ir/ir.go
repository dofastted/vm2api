// Package ir defines the protocol-agnostic star-topology intermediate representation
// adapted from magpie/internal/gateway/ir.go and extended for vm2api's native CLI
// boundaries (CRAG cache breakpoints & extensions, CRAGGemini SHM RestoreContext,
// and Claude signed-thinking sealing across Responses clients).
package ir

import (
	"encoding/base64"
	"encoding/json"
	"strings"
)

// Protocol identifies one of the 4+1 inbound/outbound wire protocols.
type Protocol string

const (
	ProtoAnthropic   Protocol = "anthropic.messages"
	ProtoChat        Protocol = "openai.chat"
	ProtoCompletions Protocol = "openai.completions"
	ProtoResponses   Protocol = "openai.responses"
	ProtoGemini      Protocol = "google.gemini"
)

// Target identifies the downstream execution kernel or API backend.
type Target string

const (
	TargetClaudeCRAG        Target = "claude_crag"
	TargetClaudeCliNode     Target = "claude_cli_node"
	TargetGeminiAntigravity Target = "gemini_antigravity"
	TargetGeminiAPI         Target = "gemini_api"
	TargetCodexKernel       Target = "codex_kernel"
	TargetAPIAnthropic      Target = "api_anthropic"
	TargetAPIOpenAI         Target = "api_openai"
	TargetAPIGemini         Target = "api_gemini"
)

// TargetWireProtocol returns the canonical wire protocol spoken by a target.
func (t Target) WireProtocol() Protocol {
	switch t {
	case TargetClaudeCRAG, TargetClaudeCliNode, TargetAPIAnthropic:
		return ProtoAnthropic
	case TargetCodexKernel, TargetAPIOpenAI:
		return ProtoResponses
	case TargetGeminiAntigravity, TargetGeminiAPI, TargetAPIGemini:
		return ProtoGemini
	default:
		return ProtoAnthropic
	}
}

// CacheControl preserves Anthropic ephemeral cache breakpoint ownership and TTL.
// An omitted TTL (empty string) MUST stay omitted on official passthrough.
type CacheControl struct {
	Type  string `json:"type"`
	TTL   string `json:"ttl,omitempty"`
	Scope string `json:"scope,omitempty"`
}

// SystemBlock is a single system instruction segment with optional cache breakpoint.
type SystemBlock struct {
	Text         string        `json:"text"`
	CacheControl *CacheControl `json:"cache_control,omitempty"`
}

// PartKind classifies one content unit inside a Message.
type PartKind string

const (
	PartText             PartKind = "text"
	PartThinking         PartKind = "thinking"
	PartRedactedThinking PartKind = "redacted_thinking"
	PartImage            PartKind = "image"
	PartDocument         PartKind = "document"
	PartToolCall         PartKind = "tool_call"
	PartToolResult       PartKind = "tool_result"
	PartToolReference    PartKind = "tool_reference"
	PartProviderBlock    PartKind = "provider_block"
)

// Part is one content item in a conversation turn.
type Part struct {
	Kind         PartKind        `json:"kind"`
	Text         string          `json:"text,omitempty"`
	Signature    string          `json:"signature,omitempty"`
	Data         string          `json:"data,omitempty"`
	MediaType    string          `json:"media_type,omitempty"`
	URL          string          `json:"url,omitempty"`
	CallID       string          `json:"call_id,omitempty"`
	SignedCallID string          `json:"signed_call_id,omitempty"`
	Name         string          `json:"name,omitempty"`
	Args         json.RawMessage `json:"args,omitempty"`
	ResultText   string          `json:"result_text,omitempty"`
	ResultParts  []Part          `json:"result_parts,omitempty"`
	IsError      bool            `json:"is_error,omitempty"`
	ToolName     string          `json:"tool_name,omitempty"`
	Title        string          `json:"title,omitempty"`
	Context      string          `json:"context,omitempty"`
	Citations    json.RawMessage `json:"citations,omitempty"`
	Caller       json.RawMessage `json:"caller,omitempty"`
	CacheControl *CacheControl   `json:"cache_control,omitempty"`
	ProviderType string          `json:"provider_type,omitempty"`
	Raw          json.RawMessage `json:"raw,omitempty"`
}

// Message is one turn in a conversation.
type Message struct {
	Role         string          `json:"role"` // user | assistant | system
	Parts        []Part          `json:"parts"`
	OutputConfig json.RawMessage `json:"output_config,omitempty"`
	ClearAt      json.RawMessage `json:"clear_at,omitempty"`
}

// Tool describes a callable tool (custom function, provider-managed, advisor, or Google built-in).
type Tool struct {
	Kind                string          `json:"kind"` // custom | provider | advisor | google_search | code_execution
	Type                string          `json:"type,omitempty"`
	Name                string          `json:"name,omitempty"`
	Description         string          `json:"description,omitempty"`
	Schema              json.RawMessage `json:"schema,omitempty"`
	Strict              *bool           `json:"strict,omitempty"`
	EagerInputStreaming *bool           `json:"eager_input_streaming,omitempty"`
	DeferLoading        *bool           `json:"defer_loading,omitempty"`
	CacheControl        *CacheControl   `json:"cache_control,omitempty"`
	Raw                 json.RawMessage `json:"raw,omitempty"`
}

// ToolChoice controls tool invocation policy.
type ToolChoice struct {
	Mode                   string          `json:"mode,omitempty"` // auto | none | any | required | tool | allowed_tools
	Name                   string          `json:"name,omitempty"`
	DisableParallelToolUse *bool           `json:"disable_parallel_tool_use,omitempty"`
	AllowedNames           []string        `json:"allowed_names,omitempty"`
	Raw                    json.RawMessage `json:"raw,omitempty"`
}

// Reasoning holds normalized thinking / reasoning controls.
type Reasoning struct {
	Mode            string `json:"mode,omitempty"`   // enabled | adaptive | disabled | between_tools
	Effort          string `json:"effort,omitempty"` // none | minimal | low | medium | high | xhigh | max
	Budget          *int   `json:"budget,omitempty"`
	Display         string `json:"display,omitempty"`
	IncludeThoughts *bool  `json:"include_thoughts,omitempty"`
}

// OutputFormat holds structured output constraints.
type OutputFormat struct {
	Type        string          `json:"type,omitempty"` // text | json_object | json_schema
	Name        string          `json:"name,omitempty"`
	Description string          `json:"description,omitempty"`
	Strict      *bool           `json:"strict,omitempty"`
	Schema      json.RawMessage `json:"schema,omitempty"`
}

// RestoreContext carries state needed to restore minimal-SHM egress (e.g. CRAGGemini)
// losslessly back into the caller's original protocol.
type RestoreContext struct {
	ToolNameMap     map[string]string `json:"toolNameMap,omitempty"`
	StopSequences   []string          `json:"stopSequences,omitempty"`
	MaxOutputTokens *int              `json:"maxOutputTokens,omitempty"`
	ResponseFormat  *OutputFormat     `json:"responseFormat,omitempty"`
	LegacyFunctions bool              `json:"legacyFunctions,omitempty"`
}

// Request is the canonical protocol-independent IR for all 4+1 inbound protocols.
type Request struct {
	InboundProtocol Protocol `json:"inbound_protocol"`
	Model           string   `json:"model"`
	Stream          bool     `json:"stream"`

	System   []SystemBlock `json:"system,omitempty"`
	Messages []Message     `json:"messages"`
	Tools    []Tool        `json:"tools,omitempty"`

	ToolChoice        *ToolChoice   `json:"tool_choice,omitempty"`
	ParallelToolCalls *bool         `json:"parallel_tool_calls,omitempty"`
	MaxTokens         *int          `json:"max_tokens,omitempty"`
	Temperature       *float64      `json:"temperature,omitempty"`
	TopP              *float64      `json:"top_p,omitempty"`
	TopK              *int          `json:"top_k,omitempty"`
	Stop              []string      `json:"stop,omitempty"`
	Reasoning         *Reasoning    `json:"reasoning,omitempty"`
	Format            *OutputFormat `json:"format,omitempty"`

	// Explicit Anthropic/CRAG extensions preserved end-to-end when target supports them.
	OutputConfig          json.RawMessage `json:"output_config,omitempty"`
	ContextManagement     json.RawMessage `json:"context_management,omitempty"`
	Safeguards            json.RawMessage `json:"safeguards,omitempty"`
	Speed                 string          `json:"speed,omitempty"`
	ServiceTier           string          `json:"service_tier,omitempty"`
	Thread                json.RawMessage `json:"thread,omitempty"`
	AutomaticCacheControl *CacheControl   `json:"automatic_cache_control,omitempty"`

	// Session / metadata hints (stripped before native CLIs unless explicitly allowed).
	ConversationID string         `json:"conversation_id,omitempty"`
	PromptCacheKey string         `json:"prompt_cache_key,omitempty"`
	Metadata       map[string]any `json:"metadata,omitempty"`
	Store          *bool          `json:"store,omitempty"`
	Include        []string       `json:"include,omitempty"`
	RawExtra       map[string]any `json:"-"`

	// Unrepresentable / capability tracking (for fail-closed validation on native CLIs).
	CandidateCount    *int           `json:"candidate_count,omitempty"`
	Unrepresentable   []string       `json:"unrepresentable,omitempty"`
	UnsupportedFields []string       `json:"unsupported_fields,omitempty"`
	RequiredCaps      []string       `json:"required_capabilities,omitempty"`
	RestoreContext    RestoreContext `json:"restore_context,omitempty"`
	StrippedFields    []string       `json:"stripped_fields,omitempty"`
}

// Usage tracks token usage across all protocols.
type Usage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	TotalTokens              int `json:"total_tokens,omitempty"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens,omitempty"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens,omitempty"`
	ReasoningTokens          int `json:"reasoning_tokens,omitempty"`
}

// EventKind identifies a normalized streaming/turn event (from magpie ir.go).
type EventKind string

const (
	EvStart             EventKind = "start"
	EvText              EventKind = "text"
	EvThinking          EventKind = "thinking"
	EvThinkingSignature EventKind = "thinking_signature"
	EvRedactedThinking  EventKind = "redacted_thinking"
	EvToolCallStart     EventKind = "tool_call_start"
	EvToolCallDelta     EventKind = "tool_call_delta"
	EvToolCallDone      EventKind = "tool_call_done"
	EvUsage             EventKind = "usage"
	EvStop              EventKind = "stop"
	EvError             EventKind = "error"
)

// Event is one protocol-independent streaming event.
type Event struct {
	Kind         EventKind       `json:"kind"`
	ID           string          `json:"id,omitempty"`
	Model        string          `json:"model,omitempty"`
	Index        int             `json:"index,omitempty"`
	Text         string          `json:"text,omitempty"`
	Signature    string          `json:"signature,omitempty"`
	Data         string          `json:"data,omitempty"`
	CallID       string          `json:"call_id,omitempty"`
	Name         string          `json:"name,omitempty"`
	ArgsDelta    string          `json:"args_delta,omitempty"`
	Args         json.RawMessage `json:"args,omitempty"`
	Usage        *Usage          `json:"usage,omitempty"`
	StopReason   string          `json:"stop_reason,omitempty"` // end_turn | tool_use | max_tokens | stop_sequence | refusal
	StopSequence string          `json:"stop_sequence,omitempty"`
	ErrorType    string          `json:"error_type,omitempty"`
	ErrorCode    string          `json:"error_code,omitempty"`
	ErrorMessage string          `json:"error_message,omitempty"`
}

// ProtocolError carries a protocol-aware HTTP error returned before upstream dispatch.
type ProtocolError struct {
	Status  int
	Code    string
	Type    string
	Param   string
	Message string
}

func (e *ProtocolError) Error() string { return e.Message }

// --- ClaudeSeal (borrowed directly from magpie/internal/claudeseal/claudeseal.go) ---

const (
	ClaudeSealMark          = "magpie-claude1:"
	AnthropicThinkingV1Mark = "anthropic-thinking-v1:"
)

func SealClaudeBlock(block []byte) string {
	return ClaudeSealMark + base64.StdEncoding.EncodeToString(block)
}

func OpenClaudeSeal(encrypted string) (block json.RawMessage, ours bool) {
	b64, ok := strings.CutPrefix(encrypted, ClaudeSealMark)
	if !ok {
		b64, ok = strings.CutPrefix(encrypted, AnthropicThinkingV1Mark)
	}
	if !ok {
		return nil, false
	}
	b, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || !json.Valid(b) {
		return nil, true
	}
	return b, true
}

func IsClaudeSeal(encrypted string) bool {
	return strings.HasPrefix(encrypted, ClaudeSealMark) || strings.HasPrefix(encrypted, AnthropicThinkingV1Mark)
}
