package slotgate

// Authority is the durable node-side state machine for executor incarnations.
// It is intentionally not wired into KSG1: that protocol and unrestricted
// SSH/Docker/SFTP access must be removed before this can provide fencing.
// Callers here are trusted node adapters, not remote protocol clients.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	ErrAuthorityLocked      = errors.New("authority_locked")
	ErrAuthorityUnavailable = errors.New("authority_unavailable")
	ErrAuthorityPhase       = errors.New("authority_phase")
	ErrFenceMismatch        = errors.New("fence_mismatch")
	ErrCommandExists        = errors.New("command_exists")
	ErrCommandOwner         = errors.New("command_owner")
	ErrCommandDispatched    = errors.New("command_dispatched")
	ErrPendingMutation      = errors.New("pending_mutation")
	ErrInvalidAuthority     = errors.New("invalid_authority")
	ErrTerminationProof     = errors.New("termination_unconfirmed")
)

type AuthorityPhase string

const (
	PhaseVacant   AuthorityPhase = "vacant"
	PhaseActive   AuthorityPhase = "active"
	PhaseRevoking AuthorityPhase = "revoking"
)

type CommandKind string
type CommandStatus string

const (
	CommandForward    CommandKind   = "forward"
	CommandMutation   CommandKind   = "mutation"
	commandLaunch     CommandKind   = "launch"
	CommandPending    CommandStatus = "pending"
	CommandUnknown    CommandStatus = "unknown"
	CommandCompleted  CommandStatus = "completed"
	CommandTerminated CommandStatus = "terminated"
	CommandNotStarted CommandStatus = "not_started"
)

// ExecutorIdentity names an incarnation, never a reusable container name or
// PID alone. ProcessScope must identify a node-owned scope containing every
// descendant; a verifier must check the whole scope, not only its initial PID.
type ExecutorIdentity struct {
	Kind           string `json:"kind"`
	NodeBootID     string `json:"node_boot_id"`
	ContainerID    string `json:"container_id,omitempty"`
	DockerDaemonID string `json:"docker_daemon_id,omitempty"`
	StartedAt      string `json:"started_at,omitempty"`
	PID            int    `json:"pid,omitempty"`
	ProcessStart   uint64 `json:"process_start,omitempty"`
	ProcessScope   string `json:"process_scope,omitempty"`
}

// Fence is captured when work is created. A delayed operation must never be
// relabeled with a fresh State() value. Controllers share an active incarnation;
// generation is independent of each controller's admission owner ID.
type Fence struct {
	Generation  uint64           `json:"generation"`
	Incarnation string           `json:"incarnation"`
	Executor    ExecutorIdentity `json:"executor"`
}

type CommandRecord struct {
	ID              string              `json:"id"`
	Kind            CommandKind         `json:"kind"`
	Status          CommandStatus       `json:"status"`
	Fence           Fence               `json:"fence"`
	Runtime         string              `json:"runtime"`
	Token           string              `json:"token"`
	Dispatched      bool                `json:"dispatched"`
	TerminationID   string              `json:"termination_id,omitempty"`
	LaunchTarget    *DockerLaunchTarget `json:"launch_target,omitempty"`
	Management      *ManagementIntent   `json:"management,omitempty"`
	LaunchReceipt   *LaunchReceipt      `json:"launch_receipt,omitempty"`
	TerminalReceipt *inferenceReceipt   `json:"terminal_receipt,omitempty"`
}

// DockerLaunchTarget is recorded after create returns and before start. A
// missing StartedAt here is intentional: the container has not started yet.
type DockerLaunchTarget struct {
	ContainerID    string `json:"container_id"`
	DockerDaemonID string `json:"docker_daemon_id"`
	NodeBootID     string `json:"node_boot_id"`
	ImageID        string `json:"image_id"`
	Name           string `json:"name"`
}

type AuthorityState struct {
	Allocation      *AllocationReceipt       `json:"allocation,omitempty"`
	InitialManifest *initialManifest         `json:"initial_manifest,omitempty"`
	Credential      *nodeCredentialState     `json:"credential,omitempty"`
	Fence           Fence                    `json:"fence"`
	Phase           AuthorityPhase           `json:"phase"`
	Commands        map[string]CommandRecord `json:"commands"`
	LastTermination *TerminationProof        `json:"last_termination,omitempty"`
	Retired         []ExecutorIdentity       `json:"retired,omitempty"`
}

type CommandHandle struct {
	VMID    string
	ID      string
	Fence   Fence
	runtime string
	token   string
}

// TerminationProof can only originate from the trusted node verifier. Neither
// a client-provided boolean, socket EOF, cancel ACK nor aggregate health is a
// proof. Container verifiers must also exclude restart of the revoked target.
type TerminationProof struct {
	ID         string           `json:"id"`
	Executor   ExecutorIdentity `json:"executor"`
	Scope      string           `json:"scope"`
	ObservedAt string           `json:"observed_at"`
}

type TerminationVerifier func(context.Context, ExecutorIdentity) (TerminationProof, error)

type authorityJournal struct {
	Version    int                       `json:"version"`
	Slots      map[string]AuthorityState `json:"slots"`
	Management *managementBinding        `json:"management,omitempty"`
}

type Authority struct {
	mu          sync.Mutex
	root        string
	lock        *os.File
	runtime     string
	verify      TerminationVerifier
	journal     authorityJournal
	unavailable bool
	closed      bool
}

const authorityMarker = "slotgate-authority-v1\n"

// OpenAuthority requires a private node-owned directory outside slot mounts.
// The process lock is held until Close; a second daemon cannot serve an older
// in-memory generation. Missing/corrupt existing state is never repaired here.
func OpenAuthority(root string, verify TerminationVerifier) (*Authority, error) {
	if !filepath.IsAbs(root) {
		return nil, ErrInvalidAuthority
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 {
		return nil, ErrInvalidAuthority
	}
	lock, err := lockAuthority(filepath.Join(root, "authority.lock"))
	if err != nil {
		return nil, err
	}
	runtime, err := randomAuthorityID()
	if err != nil {
		lock.Close()
		return nil, err
	}
	a := &Authority{root: root, lock: lock, runtime: runtime, verify: verify, journal: authorityJournal{Version: 1, Slots: map[string]AuthorityState{}}}
	fail := func(err error) (*Authority, error) { a.Close(); return nil, err }
	lockInfo, err := lock.Stat()
	if err != nil {
		return fail(err)
	}
	initialized := lockInfo.Size() != 0
	if initialized {
		marker := make([]byte, len(authorityMarker))
		if lockInfo.Size() != int64(len(marker)) {
			return fail(ErrInvalidAuthority)
		}
		if _, err = lock.ReadAt(marker, 0); err != nil {
			return fail(err)
		}
		if string(marker) != authorityMarker {
			return fail(ErrInvalidAuthority)
		}
	}
	file, err := openAuthorityFile(filepath.Join(root, "authority.json"), os.O_RDONLY, 0)
	if errors.Is(err, os.ErrNotExist) {
		if initialized {
			return fail(ErrInvalidAuthority)
		}
		if err = a.persist(a.journal); err != nil {
			return fail(err)
		}
		if err = a.markInitialized(); err != nil {
			return fail(err)
		}
		return a, nil
	}
	if err != nil {
		return fail(err)
	}
	decode := json.NewDecoder(file)
	decode.DisallowUnknownFields()
	err = decode.Decode(&a.journal)
	if err == nil {
		var extra any
		if trailing := decode.Decode(&extra); trailing != io.EOF {
			err = ErrInvalidAuthority
		}
	}
	closeErr := file.Close()
	if err != nil {
		return fail(fmt.Errorf("%w: %v", ErrInvalidAuthority, err))
	}
	if closeErr != nil {
		return fail(closeErr)
	}
	if err = validateJournal(a.journal); err != nil {
		return fail(err)
	}
	changed := false
	for vm, state := range a.journal.Slots {
		for id, command := range state.Commands {
			if command.Status == CommandPending || command.Status == CommandUnknown {
				command.Status = CommandUnknown
				state.Commands[id] = command
				state.Phase = PhaseRevoking
				changed = true
			}
		}
		a.journal.Slots[vm] = state
	}
	if changed {
		if err = a.persist(a.journal); err != nil {
			return fail(err)
		}
	}
	if !initialized {
		if err = a.markInitialized(); err != nil {
			return fail(err)
		}
	}
	return a, nil
}

func (a *Authority) markInitialized() error {
	if _, err := a.lock.WriteAt([]byte(authorityMarker), 0); err != nil {
		return err
	}
	return a.lock.Sync()
}

func (a *Authority) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return nil
	}
	a.closed = true
	return a.lock.Close()
}

func (a *Authority) State(vm string) (AuthorityState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.available(); err != nil {
		return AuthorityState{}, err
	}
	state, exists := a.journal.Slots[vm]
	if !exists {
		return AuthorityState{}, ErrInvalidAuthority
	}
	return cloneState(state), nil
}

// CreateSlot only allocates a vacant generation. It does not discover or adopt
// an existing executor, which would require separate bootstrap proof.
func (a *Authority) CreateSlot(vm string) (AuthorityState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.available(); err != nil {
		return AuthorityState{}, err
	}
	if !vmIDRe.MatchString(vm) {
		return AuthorityState{}, ErrInvalidAuthority
	}
	if _, exists := a.journal.Slots[vm]; exists {
		return AuthorityState{}, ErrFenceMismatch
	}
	incarnation, err := randomAuthorityID()
	if err != nil {
		return AuthorityState{}, err
	}
	state := AuthorityState{Fence: Fence{Generation: 1, Incarnation: incarnation}, Phase: PhaseVacant, Commands: map[string]CommandRecord{}}
	return a.commit(vm, state)
}

func (a *Authority) BeginLaunch(vm string, expected Fence, commandID string) (CommandHandle, error) {
	return a.begin(vm, expected, commandID, commandLaunch, PhaseVacant)
}

// StartLaunch records dispatch without holding the Authority lock over Docker
// I/O. The pending launch blocks all generation advancement until a trusted
// binding completes; a crash or lost create response is never retried here.
func (a *Authority) StartLaunch(handle CommandHandle) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	state, command, err := a.command(handle)
	if err != nil {
		return err
	}
	if state.Phase != PhaseVacant || command.Kind != commandLaunch || command.Status != CommandPending {
		return ErrAuthorityPhase
	}
	if command.Dispatched {
		return ErrCommandDispatched
	}
	command.Dispatched = true
	state.Commands[handle.ID] = command
	_, err = a.commit(handle.VMID, state)
	return err
}

func (a *Authority) RecordLaunchTarget(handle CommandHandle, target DockerLaunchTarget) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := validateLaunchTarget(target); err != nil {
		return err
	}
	state, command, err := a.command(handle)
	if err != nil {
		return err
	}
	// Revocation can win while create is in progress. Still retain the exact
	// returned target, but the launcher must not start or bind it afterward.
	if command.Kind != commandLaunch || command.Status != CommandPending || !command.Dispatched {
		return ErrAuthorityPhase
	}
	if command.LaunchTarget != nil && *command.LaunchTarget != target {
		return ErrFenceMismatch
	}
	command.LaunchTarget = &target
	state.Commands[handle.ID] = command
	_, err = a.commit(handle.VMID, state)
	return err
}

func (a *Authority) checkLaunch(handle CommandHandle) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	state, command, err := a.command(handle)
	if err != nil {
		return err
	}
	if state.Phase != PhaseVacant || command.Kind != commandLaunch || command.Status != CommandPending || !command.Dispatched {
		return ErrAuthorityPhase
	}
	return nil
}

// BeginCommand must commit before any bytes or mutation are sent. Command IDs
// remain tombstoned across generations, preventing retry by relabeling an ID.
func (a *Authority) BeginCommand(vm string, expected Fence, commandID string, kind CommandKind) (CommandHandle, error) {
	if kind != CommandForward && kind != CommandMutation {
		return CommandHandle{}, ErrInvalidAuthority
	}
	return a.begin(vm, expected, commandID, kind, PhaseActive)
}

// DispatchCommand checks the captured incarnation at the actual send boundary.
// dispatch must synchronously start the operation against the supplied exact
// executor; it must not enqueue later work or resolve a reusable slot path.
// The lock covers this initial send, not the job's execution or response. It
// must return before calling any other Authority method. A send error leaves a
// durable pending command and cannot be retried with this command ID.
func (a *Authority) DispatchCommand(handle CommandHandle, dispatch func(ExecutorIdentity) error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	state, command, err := a.command(handle)
	if err != nil {
		return err
	}
	phase := PhaseActive
	if command.Kind == commandLaunch {
		phase = PhaseVacant
	}
	if state.Phase != phase || command.Status != CommandPending {
		return ErrAuthorityPhase
	}
	if command.Dispatched {
		return ErrCommandDispatched
	}
	if dispatch == nil {
		return ErrInvalidAuthority
	}
	command.Dispatched = true
	state.Commands[handle.ID] = command
	if _, err = a.commit(handle.VMID, state); err != nil {
		return err
	}
	return dispatch(handle.Fence.Executor)
}

func (a *Authority) begin(vm string, expected Fence, id string, kind CommandKind, phase AuthorityPhase) (CommandHandle, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	state, err := a.match(vm, expected)
	if err != nil {
		return CommandHandle{}, err
	}
	if state.Phase != phase {
		return CommandHandle{}, ErrAuthorityPhase
	}
	if !validAuthorityID(id) {
		return CommandHandle{}, ErrInvalidAuthority
	}
	if _, exists := state.Commands[id]; exists {
		return CommandHandle{}, ErrCommandExists
	}
	if kind == commandLaunch && hasPendingMutation(state) {
		return CommandHandle{}, ErrPendingMutation
	}
	token, err := randomAuthorityID()
	if err != nil {
		return CommandHandle{}, err
	}
	state.Commands[id] = CommandRecord{ID: id, Kind: kind, Status: CommandPending, Fence: expected, Runtime: a.runtime, Token: token}
	if _, err = a.commit(vm, state); err != nil {
		return CommandHandle{}, err
	}
	return CommandHandle{VMID: vm, ID: id, Fence: expected, runtime: a.runtime, token: token}, nil
}

// BindExecutor records the exact identity observed after this daemon's launch.
// A launch from an earlier daemon is unknown and cannot be adopted implicitly.
func (a *Authority) BindExecutor(handle CommandHandle, executor ExecutorIdentity) (AuthorityState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := validateExecutor(executor); err != nil {
		return AuthorityState{}, err
	}
	state, command, err := a.command(handle)
	if err != nil {
		return AuthorityState{}, err
	}
	if state.Phase != PhaseVacant || command.Kind != commandLaunch || command.Status != CommandPending || !command.Dispatched {
		return AuthorityState{}, ErrAuthorityPhase
	}
	if target := command.LaunchTarget; target != nil && (target.ContainerID != executor.ContainerID || target.DockerDaemonID != executor.DockerDaemonID || target.NodeBootID != executor.NodeBootID) {
		return AuthorityState{}, ErrFenceMismatch
	}
	for _, retired := range state.Retired {
		if executor == retired {
			return AuthorityState{}, ErrFenceMismatch
		}
	}
	command.Status = CommandCompleted
	state.Fence.Executor = executor
	state.Phase = PhaseActive
	if intent := command.Management; intent != nil {
		if state.InitialManifest == nil || intent.Action != "launch" || state.InitialManifest.Receipt.ManifestDigest != intent.ManifestDigest {
			return AuthorityState{}, ErrInvalidAuthority
		}
		command.LaunchReceipt = &LaunchReceipt{Intent: *intent, IntentDigest: intent.digest(), ManifestRevision: "1", ManifestDigest: intent.ManifestDigest, Fence: state.Fence}
	}
	state.Commands[handle.ID] = command
	return a.commit(handle.VMID, state)
}

// CompleteCommand is for a trusted node adapter's confirmed completion only.
// A timeout or lost connection must leave the command pending.
func (a *Authority) CompleteCommand(handle CommandHandle) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	state, command, err := a.command(handle)
	if err != nil {
		return err
	}
	if command.Status == CommandCompleted {
		return nil
	}
	if command.Status != CommandPending {
		return ErrCommandOwner
	}
	if command.Kind == commandPublish || (command.Kind == commandLaunch && command.Dispatched) {
		return ErrAuthorityPhase
	}
	command.Status = CommandCompleted
	state.Commands[handle.ID] = command
	_, err = a.commit(handle.VMID, state)
	return err
}

func (a *Authority) Revoke(vm string, expected Fence) (AuthorityState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	state, err := a.match(vm, expected)
	if err != nil {
		return AuthorityState{}, err
	}
	if state.Phase == PhaseRevoking {
		return state, nil
	}
	state.Phase = PhaseRevoking
	return a.commit(vm, state)
}

// Advance verifies termination outside the journal lock so unrelated VMs keep
// serving. It rechecks the captured fence after verification. Unknown mutations
// block advancement even if the old executor is gone: a delayed daemon action
// could otherwise restart it. No automatic repair for those actions is exposed.
func (a *Authority) Advance(ctx context.Context, vm string, expected Fence) (AuthorityState, error) {
	a.mu.Lock()
	_, err := a.canAdvance(vm, expected)
	a.mu.Unlock()
	if err != nil {
		return AuthorityState{}, err
	}
	if a.verify == nil {
		return AuthorityState{}, ErrTerminationProof
	}
	proof, err := a.verify(ctx, expected.Executor)
	if err != nil {
		return AuthorityState{}, err
	}
	if err = ctx.Err(); err != nil {
		return AuthorityState{}, err
	}
	if err = validateProof(proof, expected.Executor); err != nil {
		return AuthorityState{}, err
	}
	incarnation, err := randomAuthorityID()
	if err != nil {
		return AuthorityState{}, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	state, err := a.canAdvance(vm, expected)
	if err != nil {
		return AuthorityState{}, err
	}
	if expected.Generation == ^uint64(0) {
		return AuthorityState{}, ErrInvalidAuthority
	}
	for id, command := range state.Commands {
		if pendingCommand(command) {
			command.Status = CommandTerminated
			command.TerminationID = proof.ID
			state.Commands[id] = command
		}
	}
	state.Fence = Fence{Generation: expected.Generation + 1, Incarnation: incarnation}
	state.Retired = append(state.Retired, expected.Executor)
	state.Phase = PhaseVacant
	state.LastTermination = &proof
	return a.commit(vm, state)
}

func (a *Authority) canAdvance(vm string, expected Fence) (AuthorityState, error) {
	state, err := a.match(vm, expected)
	if err != nil {
		return AuthorityState{}, err
	}
	if state.Phase != PhaseRevoking {
		return AuthorityState{}, ErrAuthorityPhase
	}
	if hasPendingMutation(state) {
		return AuthorityState{}, ErrPendingMutation
	}
	if err = validateExecutor(state.Fence.Executor); err != nil {
		return AuthorityState{}, ErrTerminationProof
	}
	return state, nil
}

func (a *Authority) command(handle CommandHandle) (AuthorityState, CommandRecord, error) {
	if err := a.available(); err != nil {
		return AuthorityState{}, CommandRecord{}, err
	}
	if handle.runtime != a.runtime {
		return AuthorityState{}, CommandRecord{}, ErrCommandOwner
	}
	state, err := a.match(handle.VMID, handle.Fence)
	if err != nil {
		return AuthorityState{}, CommandRecord{}, err
	}
	command, exists := state.Commands[handle.ID]
	if !exists || command.Runtime != a.runtime || command.Token != handle.token || command.Fence != handle.Fence {
		return AuthorityState{}, CommandRecord{}, ErrCommandOwner
	}
	return state, command, nil
}

func (a *Authority) match(vm string, expected Fence) (AuthorityState, error) {
	if err := a.available(); err != nil {
		return AuthorityState{}, err
	}
	state, exists := a.journal.Slots[vm]
	if !exists || state.Fence != expected {
		return AuthorityState{}, ErrFenceMismatch
	}
	return cloneState(state), nil
}

func (a *Authority) available() error {
	if a.closed || a.unavailable {
		return ErrAuthorityUnavailable
	}
	return nil
}

func (a *Authority) commit(vm string, state AuthorityState) (AuthorityState, error) {
	next := authorityJournal{Version: 1, Slots: make(map[string]AuthorityState, len(a.journal.Slots)+1), Management: a.journal.Management}
	for key, value := range a.journal.Slots {
		next.Slots[key] = value
	}
	next.Slots[vm] = state
	if err := a.persist(next); err != nil {
		return AuthorityState{}, err
	}
	a.journal = next
	return cloneState(state), nil
}

// fsync the temporary file, atomically replace the journal, then fsync its
// directory. Any persistence error poisons this daemon, including an uncertain
// post-rename outcome. It must reopen and validate disk before authorizing work.
func (a *Authority) persist(next authorityJournal) error {
	data, err := json.Marshal(next)
	if err != nil {
		a.unavailable = true
		return err
	}
	file, err := os.CreateTemp(a.root, ".authority-*")
	if err != nil {
		a.unavailable = true
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(append(data, '\n')); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(file.Name(), filepath.Join(a.root, "authority.json"))
	}
	if err == nil {
		var dir *os.File
		dir, err = os.Open(a.root)
		if err == nil {
			err = dir.Sync()
			if closeErr := dir.Close(); err == nil {
				err = closeErr
			}
		}
	}
	if err != nil {
		a.unavailable = true
	}
	return err
}

func cloneState(state AuthorityState) AuthorityState {
	if state.InitialManifest != nil {
		manifest := *state.InitialManifest
		state.InitialManifest = &manifest
	}
	if state.Allocation != nil {
		receipt := *state.Allocation
		state.Allocation = &receipt
	}
	commands := make(map[string]CommandRecord, len(state.Commands))
	for id, command := range state.Commands {
		command.TerminalReceipt = cloneInferenceReceipt(command.TerminalReceipt)
		if command.Management != nil {
			intent := *command.Management
			command.Management = &intent
		}
		if command.LaunchReceipt != nil {
			receipt := *command.LaunchReceipt
			command.LaunchReceipt = &receipt
		}
		if command.LaunchTarget != nil {
			target := *command.LaunchTarget
			command.LaunchTarget = &target
		}
		commands[id] = command
	}
	state.Commands = commands
	state.Retired = append([]ExecutorIdentity(nil), state.Retired...)
	if state.LastTermination != nil {
		proof := *state.LastTermination
		state.LastTermination = &proof
	}
	return state
}

func pendingCommand(command CommandRecord) bool {
	return command.Status == CommandPending || command.Status == CommandUnknown
}

func hasPendingMutation(state AuthorityState) bool {
	for _, command := range state.Commands {
		if pendingCommand(command) && command.Kind != CommandForward {
			return true
		}
	}
	return false
}

func validAuthorityID(id string) bool {
	return strings.TrimSpace(id) == id && id != "" && len(id) <= 256
}

func randomAuthorityID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes[:]), nil
}

func validateExecutor(e ExecutorIdentity) error {
	if !validAuthorityID(e.NodeBootID) {
		return ErrInvalidAuthority
	}
	switch e.Kind {
	case "container":
		id, err := hex.DecodeString(e.ContainerID)
		if err != nil || len(id) != 32 || e.PID != 0 || e.ProcessStart != 0 || e.ProcessScope != "" {
			return ErrInvalidAuthority
		}
		if _, err = time.Parse(time.RFC3339Nano, e.StartedAt); err != nil {
			return ErrInvalidAuthority
		}
	case "process":
		if e.PID <= 0 || e.ProcessStart == 0 || !validAuthorityID(e.ProcessScope) || e.ContainerID != "" || e.DockerDaemonID != "" || e.StartedAt != "" {
			return ErrInvalidAuthority
		}
	default:
		return ErrInvalidAuthority
	}
	return nil
}

func validateProof(proof TerminationProof, expected ExecutorIdentity) error {
	if proof.Executor != expected || !validAuthorityID(proof.ID) {
		return ErrTerminationProof
	}
	if _, err := time.Parse(time.RFC3339Nano, proof.ObservedAt); err != nil {
		return ErrTerminationProof
	}
	if expected.Kind == "container" && (proof.Scope == "container_removed" || proof.Scope == "container_stopped") {
		return nil
	}
	if expected.Kind == "process" && proof.Scope == "process_scope_empty" {
		return nil
	}
	return ErrTerminationProof
}

func validateJournal(journal authorityJournal) error {
	if journal.Version != 1 || journal.Slots == nil {
		return ErrInvalidAuthority
	}
	if binding := journal.Management; binding != nil && (binding.ProtocolVersion != 1 || !vmIDRe.MatchString(binding.NodeID) || !authoritySchemaRE.MatchString(binding.AuthoritySchema)) {
		return ErrInvalidAuthority
	}
	for vm, state := range journal.Slots {
		if err := validateInitialManifest(vm, state); err != nil {
			return err
		}
		if receipt := state.Allocation; receipt != nil {
			if journal.Management != nil && receipt.NodeID != journal.Management.NodeID {
				return ErrInvalidAuthority
			}
			if !validAllocation(receipt.AllocationIntent, receipt.Epoch) || receipt.VMID != vm || receipt.IntentDigest != receipt.AllocationIntent.digest() || receipt.Fence.Generation != 1 || !validAuthorityID(receipt.Fence.Incarnation) || receipt.Fence.Executor != (ExecutorIdentity{}) || (state.Fence.Generation == 1 && state.Fence.Incarnation != receipt.Fence.Incarnation) {
				return ErrInvalidAuthority
			}
		}
		if !vmIDRe.MatchString(vm) || state.Fence.Generation == 0 || !validAuthorityID(state.Fence.Incarnation) || state.Commands == nil {
			return ErrInvalidAuthority
		}
		if state.Phase != PhaseActive && state.Phase != PhaseVacant && state.Phase != PhaseRevoking {
			return ErrInvalidAuthority
		}
		if state.Phase == PhaseActive || state.Fence.Executor.Kind != "" {
			if err := validateExecutor(state.Fence.Executor); err != nil {
				return err
			}
		} else if state.Fence.Executor != (ExecutorIdentity{}) {
			return ErrInvalidAuthority
		}
		if state.Phase == PhaseVacant && state.Fence.Executor != (ExecutorIdentity{}) {
			return ErrInvalidAuthority
		}
		for id, command := range state.Commands {
			if command.Status == CommandNotStarted && (command.Kind != CommandForward || command.Dispatched || command.TerminationID != "" || command.TerminalReceipt != nil || validateExecutor(command.Fence.Executor) != nil) {
				return ErrInvalidAuthority
			}
			if receipt := command.TerminalReceipt; receipt != nil && (command.Kind != CommandForward || command.Status != CommandCompleted || !command.Dispatched || !validInferenceReceipt(*receipt)) {
				return ErrInvalidAuthority
			}
			if id != command.ID || !validAuthorityID(id) || !validAuthorityID(command.Runtime) || !validAuthorityID(command.Token) || command.Fence.Generation == 0 || command.Fence.Generation > state.Fence.Generation || !validAuthorityID(command.Fence.Incarnation) {
				return ErrInvalidAuthority
			}
			if command.Kind != CommandForward && command.Kind != CommandMutation && command.Kind != commandLaunch && command.Kind != commandPublish {
				return ErrInvalidAuthority
			}
			if command.Kind == commandPublish && command.Management == nil {
				return ErrInvalidAuthority
			}
			if command.Kind == commandPublish && command.Status == CommandCompleted && state.InitialManifest == nil {
				return ErrInvalidAuthority
			}
			if intent := command.Management; intent != nil {
				if !validManagementIntent(*intent) || intent.VMID != vm || intent.CommandID != id || intent.Fence != command.Fence ||
					(command.Kind == commandPublish && intent.Action != "publish-initial") ||
					(command.Kind == commandLaunch && intent.Action != "launch") ||
					(command.Kind != commandPublish && command.Kind != commandLaunch) {
					return ErrInvalidAuthority
				}
			}
			if receipt := command.LaunchReceipt; receipt != nil {
				if command.Management == nil || receipt.Intent != *command.Management || receipt.IntentDigest != receipt.Intent.digest() ||
					receipt.ManifestRevision != "1" || receipt.ManifestDigest != receipt.Intent.ManifestDigest || command.Kind != commandLaunch ||
					command.Status != CommandCompleted || receipt.Fence.Generation != command.Fence.Generation || receipt.Fence.Incarnation != command.Fence.Incarnation || validateExecutor(receipt.Fence.Executor) != nil {
					return ErrInvalidAuthority
				}
			}
			if command.Status != CommandPending && command.Status != CommandUnknown && command.Status != CommandCompleted && command.Status != CommandTerminated && command.Status != CommandNotStarted {
				return ErrInvalidAuthority
			}
			if pendingCommand(command) && command.Fence != state.Fence {
				return ErrInvalidAuthority
			}
			if command.LaunchTarget != nil {
				if command.Kind != commandLaunch || !command.Dispatched {
					return ErrInvalidAuthority
				}
				if err := validateLaunchTarget(*command.LaunchTarget); err != nil {
					return err
				}
			}
		}
		if state.LastTermination != nil {
			if err := validateExecutor(state.LastTermination.Executor); err != nil {
				return err
			}
			if err := validateProof(*state.LastTermination, state.LastTermination.Executor); err != nil {
				return err
			}
		}
		for _, retired := range state.Retired {
			if err := validateExecutor(retired); err != nil {
				return err
			}
			if state.Fence.Executor == retired {
				return ErrInvalidAuthority
			}
		}
	}
	return nil
}
