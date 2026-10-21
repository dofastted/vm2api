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

// KSG2 <token>\n followed by one bounded JSON command line. Only forward
// commands continue with one parsed HTTP/1 request and an HTTP response after
// OK\n. KSG1 raw splicing is never accepted when fenced mode is enabled.
type gate2Request struct {
	Op        string `json:"op"`
	VMID      string `json:"vm_id"`
	Fence     Fence  `json:"fence"`
	CommandID string `json:"command_id,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Ticket    string `json:"ticket,omitempty"`
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
	for _, known := range []error{ErrAuthorityUnavailable, ErrAuthorityPhase, ErrFenceMismatch, ErrCommandExists, ErrCommandOwner, ErrCommandDispatched, ErrPendingMutation, ErrInvalidAuthority, ErrTerminationProof} {
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
	decoder := json.NewDecoder(bytes.NewReader(lineBytes))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&request); err != nil {
		io.WriteString(conn, "ERR bad_request\n")
		return
	}
	if err = decoder.Decode(new(any)); err != io.EOF {
		io.WriteString(conn, "ERR bad_request\n")
		return
	}
	if !vmIDRe.MatchString(request.VMID) {
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
	case "state":
		state, err = s.authority.State(request.VMID)
	case "prepare":
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
		state, err = s.authority.Revoke(request.VMID, request.Fence)
	case "advance":
		state, err = s.authority.Advance(ctx, request.VMID, request.Fence)
	case "launch":
		if s.launcher == nil || request.Kind != "" || request.Ticket != "" {
			err = ErrInvalidAuthority
			break
		}
		state, err = s.launcher.Launch(ctx, request.VMID, request.Fence, request.CommandID)
	default:
		err = ErrInvalidAuthority
	}
	if err != nil {
		reply["error"] = gate2Code(err)
	} else {
		reply["ok"] = true
		if request.Op != "prepare" {
			reply["state"] = publicGateState(state)
		}
	}
	json.NewEncoder(conn).Encode(reply)
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
		return CommandHandle{}, errors.New("ticket_invalid")
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
		return CommandHandle{}, errors.New("ticket_invalid")
	}
	wanted := gate2Ticket(command.Token, request)
	if !hmac.Equal([]byte(wanted), []byte(request.Ticket)) {
		return CommandHandle{}, errors.New("ticket_invalid")
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
	response.Write(conn)
	// Even a full HTTP response remains pending in this batch. Classifying a
	// kernel's normal terminal response is a separate trusted protocol adapter.
}
