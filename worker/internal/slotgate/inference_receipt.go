package slotgate

import (
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strconv"
)

// This is observed protocol metadata, not a bill. Missing counts stay absent;
// the PG parent/attempt owns identity, pricing and any later reconciliation.
type inferenceReceipt struct {
	ID            string         `json:"id"`
	Model         string         `json:"model,omitempty"`
	UsageComplete bool           `json:"usage_complete"`
	Usage         inferenceUsage `json:"usage"`
	Speed         string         `json:"speed,omitempty"`
	ServiceTier   string         `json:"service_tier,omitempty"`
	StopReason    string         `json:"stop_reason,omitempty"`
}

type inferenceUsage struct {
	InputTokens         string                `json:"input_tokens,omitempty"`
	OutputTokens        string                `json:"output_tokens,omitempty"`
	CacheReadTokens     string                `json:"cache_read_input_tokens,omitempty"`
	CacheCreationTokens string                `json:"cache_creation_input_tokens,omitempty"`
	CacheCreation       *inferenceCacheUsage  `json:"cache_creation,omitempty"`
	ServerToolUse       *inferenceServerUsage `json:"server_tool_use,omitempty"`
}

type inferenceCacheUsage struct {
	FiveMinute string `json:"ephemeral_5m_input_tokens,omitempty"`
	OneHour    string `json:"ephemeral_1h_input_tokens,omitempty"`
}

type inferenceServerUsage struct {
	WebSearchRequests string `json:"web_search_requests,omitempty"`
}

var inferencePublicValue = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`)

func validInferenceCount(value string) bool {
	number, err := strconv.ParseUint(value, 10, 63)
	return err == nil && strconv.FormatUint(number, 10) == value
}

func completeInferenceUsage(receipt inferenceReceipt) bool {
	u := receipt.Usage
	return receipt.Model != "" && u.InputTokens != "" && u.OutputTokens != "" && u.CacheReadTokens != "" && u.CacheCreationTokens != ""
}

func validInferenceReceipt(receipt inferenceReceipt) bool {
	id, err := hex.DecodeString(receipt.ID)
	if err != nil || len(id) != 16 || hex.EncodeToString(id) != receipt.ID ||
		(receipt.Model != "" && !inferencePublicValue.MatchString(receipt.Model)) ||
		(receipt.Speed != "" && (len(receipt.Speed) > 64 || !inferencePublicValue.MatchString(receipt.Speed))) ||
		(receipt.ServiceTier != "" && (len(receipt.ServiceTier) > 64 || !inferencePublicValue.MatchString(receipt.ServiceTier))) ||
		(receipt.StopReason != "" && !normalClaudeStop(receipt.StopReason)) ||
		(receipt.UsageComplete && !completeInferenceUsage(receipt)) {
		return false
	}
	u := receipt.Usage
	counts := []string{u.InputTokens, u.OutputTokens, u.CacheReadTokens, u.CacheCreationTokens}
	if u.CacheCreation != nil {
		if u.CacheCreation.FiveMinute == "" && u.CacheCreation.OneHour == "" {
			return false
		}
		counts = append(counts, u.CacheCreation.FiveMinute, u.CacheCreation.OneHour)
	}
	if u.ServerToolUse != nil {
		if u.ServerToolUse.WebSearchRequests == "" {
			return false
		}
		counts = append(counts, u.ServerToolUse.WebSearchRequests)
	}
	for _, count := range counts {
		if count != "" && !validInferenceCount(count) {
			return false
		}
	}
	return true
}

func cloneInferenceReceipt(receipt *inferenceReceipt) *inferenceReceipt {
	if receipt == nil {
		return nil
	}
	copy := *receipt
	if receipt.Usage.CacheCreation != nil {
		detail := *receipt.Usage.CacheCreation
		copy.Usage.CacheCreation = &detail
	}
	if receipt.Usage.ServerToolUse != nil {
		detail := *receipt.Usage.ServerToolUse
		copy.Usage.ServerToolUse = &detail
	}
	return &copy
}

// Only the node's original response observer calls this after normal terminal
// and complete body/trailer verification. No RPC accepts a client receipt.
func (a *Authority) completeInference(handle CommandHandle, receipt inferenceReceipt) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	state, command, err := a.command(handle)
	if err != nil {
		return err
	}
	if command.Status == CommandCompleted {
		return nil
	}
	if command.Kind != CommandForward || command.Status != CommandPending || !command.Dispatched {
		return ErrCommandOwner
	}
	receipt.ID, err = randomAuthorityID()
	if err != nil {
		return err
	}
	if !validInferenceReceipt(receipt) {
		return ErrInvalidAuthority
	}
	command.Status = CommandCompleted
	command.TerminalReceipt = cloneInferenceReceipt(&receipt)
	state.Commands[handle.ID] = command
	_, err = a.commit(handle.VMID, state)
	return err
}

type inferenceReceiptBuilder struct {
	receipt     inferenceReceipt
	invalid     bool
	finalOutput bool
}

func (b *inferenceReceiptBuilder) publicValue(raw json.RawMessage, target *string, limit int) {
	if len(raw) == 0 {
		return
	}
	var value string
	if json.Unmarshal(raw, &value) != nil || len(value) > limit || !inferencePublicValue.MatchString(value) {
		b.invalid = true
		return
	}
	*target = value
}

func (b *inferenceReceiptBuilder) count(source map[string]json.RawMessage, key string, target *string) bool {
	raw, exists := source[key]
	if !exists {
		return false
	}
	value := string(raw)
	if !validInferenceCount(value) {
		*target = ""
		b.invalid = true
		return false
	}
	*target = value
	return true
}

func (b *inferenceReceiptBuilder) metadata(source map[string]json.RawMessage) {
	b.publicValue(source["speed"], &b.receipt.Speed, 64)
	b.publicValue(source["service_tier"], &b.receipt.ServiceTier, 64)
}

func (b *inferenceReceiptBuilder) usage(raw json.RawMessage, final bool) {
	if len(raw) == 0 {
		if final {
			b.finalOutput = false
		}
		return
	}
	var source map[string]json.RawMessage
	if strictJSON(raw, &source) != nil || source == nil {
		b.invalid = true
		if final {
			b.finalOutput = false
		}
		return
	}
	u := &b.receipt.Usage
	b.count(source, "input_tokens", &u.InputTokens)
	output := b.count(source, "output_tokens", &u.OutputTokens)
	if final {
		b.finalOutput = output
	}
	b.count(source, "cache_read_input_tokens", &u.CacheReadTokens)
	b.count(source, "cache_creation_input_tokens", &u.CacheCreationTokens)
	if raw, exists := source["cache_creation"]; exists {
		var detail map[string]json.RawMessage
		if strictJSON(raw, &detail) != nil || detail == nil {
			b.invalid = true
		} else {
			if u.CacheCreation == nil {
				u.CacheCreation = &inferenceCacheUsage{}
			}
			b.count(detail, "ephemeral_5m_input_tokens", &u.CacheCreation.FiveMinute)
			b.count(detail, "ephemeral_1h_input_tokens", &u.CacheCreation.OneHour)
			if *u.CacheCreation == (inferenceCacheUsage{}) {
				u.CacheCreation = nil
			}
		}
	}
	if raw, exists := source["server_tool_use"]; exists {
		var detail map[string]json.RawMessage
		if strictJSON(raw, &detail) != nil || detail == nil {
			b.invalid = true
		} else {
			if u.ServerToolUse == nil {
				u.ServerToolUse = &inferenceServerUsage{}
			}
			b.count(detail, "web_search_requests", &u.ServerToolUse.WebSearchRequests)
			if u.ServerToolUse.WebSearchRequests == "" {
				u.ServerToolUse = nil
			}
		}
	} else if _, exists := source["web_search_requests"]; exists {
		if u.ServerToolUse == nil {
			u.ServerToolUse = &inferenceServerUsage{}
		}
		b.count(source, "web_search_requests", &u.ServerToolUse.WebSearchRequests)
		if u.ServerToolUse.WebSearchRequests == "" {
			u.ServerToolUse = nil
		}
	}
	b.metadata(source)
}

func (b *inferenceReceiptBuilder) message(raw json.RawMessage) {
	var source map[string]json.RawMessage
	if strictJSON(raw, &source) != nil || source == nil {
		b.invalid = true
		return
	}
	b.publicValue(source["model"], &b.receipt.Model, 256)
	b.metadata(source)
	if raw := source["stop_reason"]; presentJSON(raw) {
		var reason string
		if json.Unmarshal(raw, &reason) == nil && normalClaudeStop(reason) {
			b.receipt.StopReason = reason
		}
	}
	b.usage(source["usage"], false)
}

func (b *inferenceReceiptBuilder) sse(raw json.RawMessage, start bool) {
	var source map[string]json.RawMessage
	if strictJSON(raw, &source) != nil {
		b.invalid = true
		return
	}
	if start {
		b.message(source["message"])
		return
	}
	b.metadata(source)
	var delta struct {
		StopReason string `json:"stop_reason"`
	}
	if json.Unmarshal(source["delta"], &delta) == nil && normalClaudeStop(delta.StopReason) {
		b.receipt.StopReason = delta.StopReason
	}
	b.usage(source["usage"], true)
}

func (o *claudeTerminal) inferenceReceipt() inferenceReceipt {
	if o.mode == "application/json" {
		o.receipt.message(o.jsonBody)
	}
	receipt := o.receipt.receipt
	receipt.UsageComplete = !o.receipt.invalid && completeInferenceUsage(receipt) && (o.mode == "application/json" || o.receipt.finalOutput)
	return receipt
}
