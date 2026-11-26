// Package server implements the stateless Unix-domain-socket HTTP server for kin-proto-front.
// It exposes:
//   - GET  /internal/health       — readiness probe
//   - POST /internal/v1/detect    — official client + Web Settings passthrough verdict
//   - POST /internal/v1/compile   — inbound 4+1 parse, double-gate passthrough, anti-collision strip, target build
//   - POST /internal/v1/transcode — symmetric SSE/JSON egress transcoding across all 4+1 protocols
package server

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/dofastted/kin-gateway/protofront/internal/codec"
	"github.com/dofastted/kin-gateway/protofront/internal/detect"
	"github.com/dofastted/kin-gateway/protofront/internal/ir"
	"github.com/dofastted/kin-gateway/protofront/internal/strip"
)

const (
	Version      = "1.0.0"
	maxBodyBytes = 64 * 1024 * 1024
)

// Server holds stateless configuration for kin-proto-front.
type Server struct {
	Token string
}

// CompileRequest is the JSON input for POST /internal/v1/compile and /internal/v1/detect.
type CompileRequest struct {
	InboundProtocol   ir.Protocol        `json:"inbound_protocol"`
	TargetFamily      ir.Target          `json:"target_family"`
	HandoffMode       string             `json:"handoff_mode,omitempty"` // standalone (default) | canonical
	Path              string             `json:"path,omitempty"`
	Headers           map[string]string  `json:"headers,omitempty"`
	Body              map[string]any     `json:"body"`
	Routing           detect.WebSettings `json:"routing,omitempty"`
	SlotCapabilities  []string           `json:"slot_capabilities,omitempty"`
	OutboundSessionID string             `json:"outbound_session_id,omitempty"`
	RouteModel        string             `json:"route_model,omitempty"`
	RouteStream       *bool              `json:"route_stream,omitempty"`
}

// IRMeta exposes lightweight metadata extracted from the parsed IR for logging & scheduling.
type IRMeta struct {
	Model           string `json:"model,omitempty"`
	Stream          bool   `json:"stream"`
	HasTools        bool   `json:"has_tools"`
	ReasoningEffort string `json:"reasoning_effort,omitempty"`
	MessageCount    int    `json:"message_count"`
}

// CompileResponse is the JSON output for POST /internal/v1/compile.
type CompileResponse struct {
	OK              bool              `json:"ok"`
	Mode            string            `json:"mode,omitempty"` // passthrough | convert
	Decision        detect.Decision   `json:"decision"`
	OutboundBody    map[string]any    `json:"outbound_body,omitempty"`
	OutboundHeaders map[string]string `json:"outbound_headers,omitempty"`
	RestoreContext  ir.RestoreContext `json:"restore_context,omitempty"`
	StrippedFields  []string          `json:"stripped_fields,omitempty"`
	IRMeta          *IRMeta           `json:"ir_meta,omitempty"`
	Status          int               `json:"status,omitempty"`
	Code            string            `json:"code,omitempty"`
	ErrorBody       map[string]any    `json:"error_body,omitempty"`
}

// TranscodeRequest is the JSON input for POST /internal/v1/transcode.
type TranscodeRequest struct {
	UpstreamProtocol ir.Protocol       `json:"upstream_protocol"`
	InboundProtocol  ir.Protocol       `json:"inbound_protocol"`
	Model            string            `json:"model"`
	Stream           bool              `json:"stream"`
	Payload          string            `json:"payload"`
	RestoreContext   ir.RestoreContext `json:"restore_context,omitempty"`
}

// TranscodeResponse is the JSON output for POST /internal/v1/transcode.
type TranscodeResponse struct {
	OK          bool   `json:"ok"`
	ContentType string `json:"content_type,omitempty"`
	Body        string `json:"body,omitempty"`
	Error       string `json:"error,omitempty"`
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/health", s.handleHealth)
	mux.HandleFunc("/internal/v1/detect", s.handleDetect)
	mux.HandleFunc("/internal/v1/compile", s.handleCompile)
	mux.HandleFunc("/internal/v1/transcode", s.handleTranscode)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) authorized(r *http.Request) bool {
	if s.Token == "" {
		return true
	}
	got := strings.TrimSpace(r.Header.Get("X-Kin-Internal-Token"))
	if got == "" {
		got = strings.TrimSpace(r.Header.Get("X-Internal-Token"))
	}
	if len(got) != len(s.Token) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.Token)) == 1
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"service": "kin-proto-front",
		"version": Version,
	})
}

func (s *Server) handleDetect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}
	var req CompileRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	decision := detect.Evaluate(req.InboundProtocol, req.TargetFamily, req.Headers, req.Body, req.Routing)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"decision": decision,
	})
}

func (s *Server) handleCompile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}
	var req CompileRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	resp := Compile(req)
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleTranscode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}
	var req TranscodeRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, TranscodeResponse{OK: false, Error: err.Error()})
		return
	}
	ct, body, err := codec.TranscodeResponse(
		req.UpstreamProtocol,
		req.InboundProtocol,
		req.Model,
		req.Stream,
		req.Payload,
		req.RestoreContext,
	)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, TranscodeResponse{OK: false, Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, TranscodeResponse{
		OK:          true,
		ContentType: ct,
		Body:        body,
	})
}

// Compile executes the end-to-end inbound pipeline:
//  1. Evaluate strict double-gate passthrough (Web Settings AND Official Request Body).
//  2. Parse into star-topology IR (for validation, metadata, and conversion).
//  3. Apply target-specific anti-collision fingerprint stripping.
//  4. Build minimal target wire body (or preserve official body on verified passthrough).
func Compile(req CompileRequest) CompileResponse {
	if req.Body == nil {
		return protocolErrResp(req.InboundProtocol, detect.Decision{}, &ir.ProtocolError{
			Status:  400,
			Code:    "invalid_request",
			Type:    "invalid_request_error",
			Param:   "body",
			Message: "body must be a JSON object",
		})
	}
	decision := detect.Evaluate(req.InboundProtocol, req.TargetFamily, req.Headers, req.Body, req.Routing)

	irReq, err := codec.Parse(req.InboundProtocol, req.Body, codec.ParseOptions{
		RouteModel:  req.RouteModel,
		RouteStream: req.RouteStream,
	})
	if err != nil {
		return protocolErrResp(req.InboundProtocol, decision, err)
	}

	meta := &IRMeta{
		Model:        irReq.Model,
		Stream:       irReq.Stream,
		HasTools:     len(irReq.Tools) > 0,
		MessageCount: len(irReq.Messages),
	}
	if irReq.Reasoning != nil {
		meta.ReasoningEffort = irReq.Reasoning.Effort
	}

	canonicalHandoff := strings.EqualFold(strings.TrimSpace(req.HandoffMode), "canonical")

	switch req.TargetFamily {
	case ir.TargetClaudeCRAG, ir.TargetClaudeCliNode:
		if !canonicalHandoff {
			if err := strip.ApplyClaudeCRAG(irReq, decision, req.Routing); err != nil {
				return protocolErrResp(req.InboundProtocol, decision, err)
			}
		}
		if decision.AllowPassthrough {
			// Verified official Claude Code passthrough with Web Setting ON:
			// preserve caller's exact official body structure and auto-repair invalid cache controls.
			cloned := cloneMap(req.Body)
			strip.RepairAnthropicMapCacheBreakpoints(cloned)
			if canonicalHandoff {
				cloned["stream"] = true
			}
			return CompileResponse{
				OK:             true,
				Mode:           "passthrough",
				Decision:       decision,
				OutboundBody:   cloned,
				StrippedFields: irReq.StrippedFields,
				IRMeta:         meta,
			}
		}
		built, err := codec.Build(irReq, codec.BuildOptions{
			Target:            req.TargetFamily,
			Decision:          decision,
			Settings:          req.Routing,
			SlotCapabilities:  req.SlotCapabilities,
			OutboundSessionID: req.OutboundSessionID,
			CanonicalHandoff:  canonicalHandoff,
		})
		if err != nil {
			return protocolErrResp(req.InboundProtocol, decision, err)
		}
		return CompileResponse{
			OK:             true,
			Mode:           "convert",
			Decision:       decision,
			OutboundBody:   built.Body,
			StrippedFields: built.StrippedFields,
			IRMeta:         meta,
		}

	case ir.TargetCodexKernel:
		var outBody map[string]any
		var stripped []string
		mode := "convert"
		if decision.AllowPassthrough {
			// Official Codex CLI passthrough with Web Setting ON:
			// preserve official Responses fields while ALWAYS stripping caller identity & claudeseal.
			mode = "passthrough"
			outBody = cloneMap(req.Body)
			outBody["stream"] = true
		} else {
			built, err := codec.Build(irReq, codec.BuildOptions{
				Target:            ir.TargetCodexKernel,
				Decision:          decision,
				Settings:          req.Routing,
				SlotCapabilities:  req.SlotCapabilities,
				OutboundSessionID: req.OutboundSessionID,
				CanonicalHandoff:  canonicalHandoff,
			})
			if err != nil {
				return protocolErrResp(req.InboundProtocol, decision, err)
			}
			outBody = built.Body
			stripped = append(stripped, built.StrippedFields...)
		}
		sanitized, s2 := strip.SanitizeCodexBody(outBody, req.Routing, req.OutboundSessionID)
		stripped = append(stripped, s2...)
		outHeaders := strip.FilterCodexHeaders(req.Headers, sanitized, req.OutboundSessionID)
		return CompileResponse{
			OK:              true,
			Mode:            mode,
			Decision:        decision,
			OutboundBody:    sanitized,
			OutboundHeaders: outHeaders,
			StrippedFields:  stripped,
			IRMeta:          meta,
		}

	case ir.TargetGeminiAntigravity, ir.TargetGeminiAPI:
		// Even when AllowPassthrough is true for official Gemini, Antigravity SHM requires
		// minimal 8-key projection and configured prompt normalization at the native CLI boundary.
		strip.ApplyGeminiAntigravity(irReq, req.Routing)
		built, err := codec.Build(irReq, codec.BuildOptions{
			Target:            req.TargetFamily,
			Decision:          decision,
			Settings:          req.Routing,
			SlotCapabilities:  req.SlotCapabilities,
			OutboundSessionID: req.OutboundSessionID,
		})
		if err != nil {
			return protocolErrResp(req.InboundProtocol, decision, err)
		}
		mode := "convert"
		if decision.AllowPassthrough {
			mode = "passthrough"
		}
		return CompileResponse{
			OK:             true,
			Mode:           mode,
			Decision:       decision,
			OutboundBody:   built.Body,
			RestoreContext: built.RestoreContext,
			StrippedFields: built.StrippedFields,
			IRMeta:         meta,
		}

	case ir.TargetAPIAnthropic:
		if decision.AllowPassthrough {
			cloned := cloneMap(req.Body)
			strip.RepairAnthropicMapCacheBreakpoints(cloned)
			if canonicalHandoff {
				cloned["stream"] = true
			}
			return CompileResponse{
				OK:           true,
				Mode:         "passthrough",
				Decision:     decision,
				OutboundBody: cloned,
				IRMeta:       meta,
			}
		}
		if !canonicalHandoff {
			strip.RepairAnthropicCacheBreakpoints(irReq)
		}
		built, err := codec.Build(irReq, codec.BuildOptions{
			Target:           ir.TargetAPIAnthropic,
			Decision:         decision,
			Settings:         req.Routing,
			CanonicalHandoff: canonicalHandoff,
		})
		if err != nil {
			return protocolErrResp(req.InboundProtocol, decision, err)
		}
		return CompileResponse{
			OK:             true,
			Mode:           "convert",
			Decision:       decision,
			OutboundBody:   built.Body,
			StrippedFields: built.StrippedFields,
			IRMeta:         meta,
		}

	case ir.TargetAPIOpenAI:
		if decision.AllowPassthrough || req.InboundProtocol == ir.ProtoResponses {
			cleaned, stripped := strip.SanitizeOpenAIAPIBody(req.Body)
			return CompileResponse{
				OK:             true,
				Mode:           map[bool]string{true: "passthrough", false: "convert"}[decision.AllowPassthrough],
				Decision:       decision,
				OutboundBody:   cleaned,
				StrippedFields: stripped,
				IRMeta:         meta,
			}
		}
		built, err := codec.Build(irReq, codec.BuildOptions{
			Target:   ir.TargetAPIOpenAI,
			Decision: decision,
			Settings: req.Routing,
		})
		if err != nil {
			return protocolErrResp(req.InboundProtocol, decision, err)
		}
		cleaned, s2 := strip.SanitizeOpenAIAPIBody(built.Body)
		return CompileResponse{
			OK:             true,
			Mode:           "convert",
			Decision:       decision,
			OutboundBody:   cleaned,
			StrippedFields: append(built.StrippedFields, s2...),
			IRMeta:         meta,
		}

	case ir.TargetAPIGemini:
		if decision.AllowPassthrough {
			return CompileResponse{
				OK:           true,
				Mode:         "passthrough",
				Decision:     decision,
				OutboundBody: cloneMap(req.Body),
				IRMeta:       meta,
			}
		}
		built, err := codec.Build(irReq, codec.BuildOptions{
			Target:   ir.TargetAPIGemini,
			Decision: decision,
			Settings: req.Routing,
		})
		if err != nil {
			return protocolErrResp(req.InboundProtocol, decision, err)
		}
		return CompileResponse{
			OK:             true,
			Mode:           "convert",
			Decision:       decision,
			OutboundBody:   built.Body,
			RestoreContext: built.RestoreContext,
			StrippedFields: built.StrippedFields,
			IRMeta:         meta,
		}

	default:
		return protocolErrResp(req.InboundProtocol, decision, &ir.ProtocolError{
			Status:  400,
			Code:    "unsupported_target",
			Type:    "invalid_request_error",
			Param:   "target_family",
			Message: "unsupported target_family",
		})
	}
}

func protocolErrResp(proto ir.Protocol, decision detect.Decision, err error) CompileResponse {
	var pe *ir.ProtocolError
	if !errors.As(err, &pe) {
		pe = &ir.ProtocolError{
			Status:  400,
			Code:    "invalid_request",
			Type:    "invalid_request_error",
			Message: err.Error(),
		}
	}
	if pe.Status == 0 {
		pe.Status = 400
	}
	var errBody map[string]any
	switch proto {
	case ir.ProtoGemini:
		grpcStatus := "INVALID_ARGUMENT"
		if pe.Status == 403 {
			grpcStatus = "PERMISSION_DENIED"
		}
		errBody = map[string]any{
			"error": map[string]any{
				"code":    pe.Status,
				"status":  grpcStatus,
				"message": pe.Message,
				"details": []any{
					map[string]any{
						"@type":  "type.googleapis.com/google.rpc.ErrorInfo",
						"reason": pe.Code,
					},
				},
			},
		}
	case ir.ProtoAnthropic:
		eObj := map[string]any{
			"type":    pe.Type,
			"code":    pe.Code,
			"message": pe.Message,
		}
		if pe.Param != "" {
			eObj["param"] = pe.Param
		}
		errBody = map[string]any{
			"type":  "error",
			"error": eObj,
		}
	default:
		eObj := map[string]any{
			"type":    pe.Type,
			"code":    pe.Code,
			"message": pe.Message,
		}
		if pe.Param != "" {
			eObj["param"] = pe.Param
		}
		errBody = map[string]any{"error": eObj}
	}
	return CompileResponse{
		OK:        false,
		Decision:  decision,
		Status:    pe.Status,
		Code:      pe.Code,
		ErrorBody: errBody,
	}
}

func cloneMap(src map[string]any) map[string]any {
	b, err := json.Marshal(src)
	if err != nil {
		out := make(map[string]any, len(src))
		for k, v := range src {
			out[k] = v
		}
		return out
	}
	var dst map[string]any
	if err := json.Unmarshal(b, &dst); err != nil {
		return map[string]any{}
	}
	return dst
}

func decodeJSONBody(r *http.Request, dst any) error {
	defer r.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > maxBodyBytes {
		return errors.New("request body exceeds 64MiB limit")
	}
	return json.Unmarshal(raw, dst)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}
