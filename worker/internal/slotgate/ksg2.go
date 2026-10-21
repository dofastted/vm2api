package slotgate

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

const gate2LineMax = 8192
const gate2RequestMax = 16 << 20

var errGateTicketInvalid = errors.New("ticket_invalid")

// KSG2 <token>\n followed by one bounded JSON command line. Only forward
// commands continue with one parsed HTTP/1 request and an HTTP response after
// OK\n. KSG1 raw splicing is never accepted when fenced mode is enabled.
type gate2Request struct {
	Op            string            `json:"op"`
	VMID          string            `json:"vm_id"`
	Fence         Fence             `json:"fence"`
	CommandID     string            `json:"command_id,omitempty"`
	Kind          string            `json:"kind,omitempty"`
	Ticket        string            `json:"ticket,omitempty"`
	AllocationID  string            `json:"allocation_id,omitempty"`
	OperationID   string            `json:"operation_id,omitempty"`
	OwnerID       string            `json:"owner_id,omitempty"`
	Management    *ManagementIntent `json:"management,omitempty"`
	ContentLength int               `json:"content_length,omitempty"`
}

type gate2State struct {
	Fence           Fence             `json:"fence"`
	Phase           AuthorityPhase    `json:"phase"`
	Pending         int               `json:"pending"`
	LastTermination *TerminationProof `json:"last_termination,omitempty"`
}

func publicGateState(state AuthorityState) gate2State {
	pending := 0
	for _, command := range state.Commands {
		if pendingCommand(command) {
			pending++
		}
	}
	// Do not disclose the command nonce or daemon runtime used to mint tickets.
	return gate2State{Fence: state.Fence, Phase: state.Phase, Pending: pending, LastTermination: state.LastTermination}
}

func gate2Line(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		part, err := reader.ReadSlice('\n')
		line = append(line, part...)
		if len(line) > gate2LineMax {
			return nil, ErrInvalidAuthority
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return line, err
	}
}

func gate2Code(err error) string {
	for _, known := range []error{ErrAuthorityUnavailable, ErrAuthorityPhase, ErrFenceMismatch, ErrCommandExists, ErrCommandOwner, ErrCommandDispatched, ErrPendingMutation, ErrInvalidAuthority, ErrTerminationProof, ErrManagementDenied, ErrManagementUnavailable, ErrAllocationConflict, errGateTicketInvalid} {
		if errors.Is(err, known) {
			return known.Error()
		}
	}
	return "execution_unknown"
}

func (s *Server) handleFenced(ctx context.Context, conn net.Conn, reader *bufio.Reader, line string) {
	fields := strings.Fields(line)
	if len(fields) != 2 || fields[0] != "KSG2" {
		io.WriteString(conn, "ERR protocol\n")
		return
	}
	token := sha256.Sum256([]byte(fields[1]))
	if subtle.ConstantTimeCompare(token[:], s.token[:]) != 1 {
		io.WriteString(conn, "ERR auth\n")
		return
	}
	lineBytes, err := gate2Line(reader)
	if err != nil {
		io.WriteString(conn, "ERR bad_request\n")
		return
	}
	var request gate2Request
	if err = strictJSON(lineBytes, &request); err != nil {
		io.WriteString(conn, "ERR bad_request\n")
		return
	}
	if !vmIDRe.MatchString(request.VMID) {
		io.WriteString(conn, "ERR bad_request\n")
		return
	}
	if request.Op != "publish-initial" && request.Op != "launch" && (request.Management != nil || request.ContentLength != 0) {
		io.WriteString(conn, "ERR bad_request\n")
		return
	}
	if request.Op == "forward" {
		s.forwardFenced(ctx, conn, reader, request)
		return
	}
	// No network mutation runs under the handshake/header deadline. Engine
	// operations have their own bounded timeout and retain state on any error.
	conn.SetDeadline(time.Now().Add(35 * time.Second))
	reply := map[string]any{"ok": false}
	var state AuthorityState
	switch request.Op {
	case "allocate":
		if s.allocator == nil || request.Fence != (Fence{}) || request.CommandID != "" || request.Kind != "" || request.Ticket != "" {
			err = ErrManagementDenied
			break
		}
		var receipt AllocationReceipt
		receipt, err = s.allocator.Allocate(ctx, AllocationIntent{NodeID: s.allocator.nodeID, VMID: request.VMID, AllocationID: request.AllocationID, OperationID: request.OperationID, OwnerID: request.OwnerID})
		if err == nil {
			reply["allocation"] = receipt
		}
	case "state":
		state, err = s.authority.State(request.VMID)
	case "prepare":
		if managed, e := s.authority.State(request.VMID); e == nil && managed.Allocation != nil && (managed.InitialManifest == nil || request.Kind != "kernel") {
			err = ErrManagementDenied
			break
		}
		if _, ok := kinds[request.Kind]; !ok {
			err = ErrInvalidAuthority
			break
		}
		var handle CommandHandle
		handle, err = s.authority.BeginCommand(request.VMID, request.Fence, request.CommandID, CommandForward)
		if err == nil {
			reply["ticket"] = gate2Ticket(handle.token, request)
		}
	case "revoke":
		if s.authorizeManagement == nil {
			err = ErrManagementDenied
			break
		}
		err = s.authorizeManagement(ctx, request, func() error { var e error; state, e = s.authority.Revoke(request.VMID, request.Fence); return e })
	case "advance":
		if s.authorizeManagement == nil {
			err = ErrManagementDenied
			break
		}
		err = s.authorizeManagement(ctx, request, func() error { var e error; state, e = s.authority.Advance(ctx, request.VMID, request.Fence); return e })
	case "launch":
		if s.authorizeCommand == nil || s.managementNodeID == "" {
			err = ErrManagementDenied
			break
		}
		if s.launcher == nil || !s.validManagementRequest(request) || request.ContentLength != 0 {
			err = ErrInvalidAuthority
			break
		}
		var receipt LaunchReceipt
		receipt, err = s.launcher.LaunchManifest(ctx, *request.Management, s.authorizeCommand)
		if err == nil {
			reply["launch"] = receipt
		}
	case "publish-initial":
		if s.authorizeCommand == nil || s.managementNodeID == "" {
			err = ErrManagementDenied
			break
		}
		if s.publisher == nil || !s.validManagementRequest(request) {
			err = ErrInvalidAuthority
			break
		}
		publisher := *s.publisher
		publisher.nodeID = s.managementNodeID
		publisher.authorize = s.authorizeCommand
		var receipt PublicationReceipt
		receipt, err = publisher.Publish(ctx, *request.Management, request.ContentLength, reader)
		if err == nil {
			reply["publication"] = receipt
		}
	case "command":
		var handle CommandHandle
		handle, err = s.forwardHandle(request)
		if err != nil {
			break
		}
		state, err = s.authority.State(handle.VMID)
		if err == nil {
			command, exists := state.Commands[handle.ID]
			if !exists || state.Fence != request.Fence || command.Fence != request.Fence {
				err = ErrFenceMismatch
				break
			}
			reply["command"] = struct {
				ID         string        `json:"id"`
				Fence      Fence         `json:"fence"`
				Status     CommandStatus `json:"status"`
				Dispatched bool          `json:"dispatched"`
			}{command.ID, command.Fence, command.Status, command.Dispatched}
		}
	default:
		err = ErrInvalidAuthority
	}
	if err != nil {
		reply["error"] = gate2Code(err)
	} else {
		reply["ok"] = true
		if request.Op != "prepare" && request.Op != "command" && request.Op != "allocate" && request.Op != "publish-initial" && request.Op != "launch" {
			reply["state"] = publicGateState(state)
		}
	}
	json.NewEncoder(conn).Encode(reply)
}

func (s *Server) validManagementRequest(request gate2Request) bool {
	return request.Management != nil && request.Management.Action == request.Op && request.Management.VMID == request.VMID && request.Management.NodeID == s.managementNodeID &&
		request.Fence == (Fence{}) && request.CommandID == "" && request.Kind == "" && request.Ticket == "" && request.AllocationID == "" && request.OperationID == "" && request.OwnerID == "" && validManagementIntent(*request.Management)
}

func gate2Ticket(nonce string, request gate2Request) string {
	mac := hmac.New(sha256.New, []byte(nonce))
	// The opcode/ticket are excluded so prepare and forward share one grant.
	data, _ := json.Marshal(struct {
		VM    string
		Fence Fence
		ID    string
		Kind  string
	}{request.VMID, request.Fence, request.CommandID, request.Kind})
	mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Server) forwardHandle(request gate2Request) (CommandHandle, error) {
	if _, ok := kinds[request.Kind]; !ok {
		return CommandHandle{}, errGateTicketInvalid
	}
	state, err := s.authority.State(request.VMID)
	if err != nil {
		return CommandHandle{}, err
	}
	if state.Fence != request.Fence {
		return CommandHandle{}, ErrFenceMismatch
	}
	command, exists := state.Commands[request.CommandID]
	if !exists || command.Kind != CommandForward || command.Fence != request.Fence {
		return CommandHandle{}, errGateTicketInvalid
	}
	wanted := gate2Ticket(command.Token, request)
	if !hmac.Equal([]byte(wanted), []byte(request.Ticket)) {
		return CommandHandle{}, errGateTicketInvalid
	}
	return CommandHandle{VMID: request.VMID, ID: request.CommandID, Fence: request.Fence, runtime: command.Runtime, token: command.Token}, nil
}

func (s *Server) forwardFenced(ctx context.Context, conn net.Conn, reader *bufio.Reader, request gate2Request) {
	handle, err := s.forwardHandle(request)
	if err != nil {
		code := gate2Code(err)
		if err.Error() == "ticket_invalid" {
			code = "ticket_invalid"
		}
		fmt.Fprintf(conn, "ERR %s\n", code)
		return
	}
	// Parse and reserialize exactly one request. Never raw-splice client bytes:
	// keep-alive, pipelined requests and delayed extra bytes cannot share a grant.
	limited := &io.LimitedReader{R: reader, N: gate2RequestMax + 1}
	req, err := http.ReadRequest(bufio.NewReader(limited))
	if err != nil {
		io.WriteString(conn, "ERR http_request\n")
		return
	}
	defer req.Body.Close()
	if req.ProtoMajor != 1 || req.Method == http.MethodConnect || req.Header.Get("Upgrade") != "" {
		io.WriteString(conn, "ERR http_request\n")
		return
	}
	body, err := io.ReadAll(req.Body)
	if err != nil || limited.N <= 0 {
		io.WriteString(conn, "ERR http_request\n")
		return
	}
	state, err := s.authority.State(request.VMID)
	if err != nil || state.Fence != request.Fence {
		fmt.Fprint(conn, "ERR fence_mismatch\n")
		return
	}
	if state.Allocation != nil {
		var envelope map[string]json.RawMessage
		var id string
		if state.InitialManifest == nil || s.launcher == nil || request.Kind != "kernel" || req.Method != http.MethodPost || req.URL.Path != "/internal/v1/messages" || req.URL.RawQuery != "" ||
			strictJSON(body, &envelope) != nil || json.Unmarshal(envelope["request_id"], &id) != nil || id != request.CommandID {
			fmt.Fprint(conn, "ERR management_denied\n")
			return
		}
	}
	req.Body = io.NopCloser(bytes.NewReader(body))
	req.ContentLength = int64(len(body))
	req.TransferEncoding = nil
	req.Trailer = nil
	req.Close = true
	for _, header := range []string{"Connection", "Keep-Alive", "Proxy-Connection", "TE", "Trailer", "Upgrade"} {
		req.Header.Del(header)
	}
	conn.SetDeadline(time.Time{})
	var target net.Conn
	err = s.authority.DispatchCommand(handle, func(ExecutorIdentity) error {
		if state.Allocation != nil {
			token, e := readPublishedInitial(s.cfg.Root, request.VMID, request.Fence, s.launcher.policy, *state.InitialManifest, false)
			if e != nil {
				return e
			}
			req.Header.Set("x-kin-internal-token", token)
			req.Header.Set("x-internal-token", token)
		}
		var dialErr error
		// The incarnation has a private socket namespace. No fallback to run/.
		socket := filepath.Join(s.cfg.Root, "vms", request.VMID, "incarnations", request.Fence.Incarnation, "run", kinds[request.Kind])
		target, dialErr = dialSlotSocket(socket)
		if dialErr != nil {
			return errors.New("no_socket")
		}
		target.SetWriteDeadline(time.Now().Add(prefaceTimeout))
		if err := req.Write(target); err != nil {
			return err
		}
		return target.SetWriteDeadline(time.Time{})
	})
	if target != nil {
		defer target.Close()
	}
	if err != nil {
		code := gate2Code(err)
		if err.Error() == "no_socket" {
			code = "no_socket"
		}
		fmt.Fprintf(conn, "ERR %s\n", code)
		return
	}
	stop := context.AfterFunc(ctx, func() { target.Close() })
	defer stop()
	if _, err = io.WriteString(conn, "OK\n"); err != nil {
		return
	}
	response, err := http.ReadResponse(bufio.NewReader(target), req)
	if err != nil {
		return
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusSwitchingProtocols {
		return
	}
	response.Close = true
	terminal := observeClaudeTerminal(response, req, body, request.CommandID, request.Kind)
	response.Body = terminal
	if err = response.Write(conn); err != nil {
		return
	}
	if terminal.completed(response) {
		// The HTTP body is not a durable acknowledgement. A KSG2 client must
		// read the authenticated command status before releasing its PG job.
		// If this commit fails the Authority poisons itself and cannot report
		// completed; no new execution or retry is issued here.
		if err = s.authority.CompleteCommand(handle); err != nil {
			return
		}
	}
}
