package slotgate

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

type initialCredential struct {
	Type         string   `json:"type"`
	AccessToken  string   `json:"access_token,omitempty"`
	RefreshToken string   `json:"refresh_token,omitempty"`
	APIKey       string   `json:"api_key,omitempty"`
	ExpiresAt    int64    `json:"expires_at,omitempty"`
	Scopes       []string `json:"scopes,omitempty"`
}
type initialPayload struct {
	Credential initialCredential `json:"credential"`
}

// No filename, path, settings, environment, executable, URL, uid or mode is
// accepted from the runtime controller. The only uploaded file is credentials.
func initialCredentialBytes(data []byte) ([]byte, error) {
	var payload initialPayload
	if len(data) == 0 || len(data) > initialPublishMax || strictJSON(data, &payload) != nil {
		return nil, ErrInvalidAuthority
	}
	c := payload.Credential
	if len(c.AccessToken) > 16<<10 || len(c.RefreshToken) > 16<<10 || len(c.APIKey) > 16<<10 || c.ExpiresAt < 0 || len(c.Scopes) > 32 {
		return nil, ErrInvalidAuthority
	}
	for _, scope := range c.Scopes {
		if len(scope) == 0 || len(scope) > 128 || strings.ContainsAny(scope, "\x00\r\n") {
			return nil, ErrInvalidAuthority
		}
	}
	var document map[string]any
	switch c.Type {
	case "apikey":
		if strings.TrimSpace(c.APIKey) == "" || c.AccessToken != "" || c.RefreshToken != "" || c.ExpiresAt != 0 || len(c.Scopes) != 0 {
			return nil, ErrInvalidAuthority
		}
		document = map[string]any{"type": "apikey", "authScheme": "x_api_key", "kinGeneration": 1, "anthropicApiKey": map[string]any{"apiKey": c.APIKey, "baseUrl": "https://api.anthropic.com"}}
	case "oauth", "setup-token", "official-setup-token":
		if strings.TrimSpace(c.AccessToken) == "" || c.APIKey != "" || (c.Type != "oauth" && c.RefreshToken != "") {
			return nil, ErrInvalidAuthority
		}
		oauth := map[string]any{"accessToken": c.AccessToken, "kinGeneration": 1}
		if c.RefreshToken != "" {
			oauth["refreshToken"] = c.RefreshToken
		}
		if c.ExpiresAt > 0 {
			oauth["expiresAt"] = c.ExpiresAt
		}
		if c.Type == "oauth" {
			if len(c.Scopes) > 0 {
				oauth["scopes"] = c.Scopes
			}
		} else {
			oauth["type"] = c.Type
			oauth["scopes"] = []string{"user:inference"}
		}
		document = map[string]any{"type": c.Type, "authScheme": "authorization_bearer", "kinGeneration": 1, "claudeAiOauth": oauth}
	default:
		return nil, ErrInvalidAuthority
	}
	return json.Marshal(document)
}

// DisallowUnknownFields alone accepts duplicate keys. Detect them before
// decoding so the controller and node cannot assign different input meanings.
func strictJSON(data []byte, value any) error {
	keys := json.NewDecoder(bytes.NewReader(data))
	var scan func() error
	scan = func() error {
		token, err := keys.Token()
		if err != nil {
			return err
		}
		if delim, ok := token.(json.Delim); ok {
			switch delim {
			case '{':
				seen := map[string]bool{}
				for keys.More() {
					key, err := keys.Token()
					if err != nil {
						return err
					}
					name, ok := key.(string)
					if !ok || seen[name] {
						return ErrInvalidAuthority
					}
					seen[name] = true
					if err = scan(); err != nil {
						return err
					}
				}
			case '[':
				for keys.More() {
					if err = scan(); err != nil {
						return err
					}
				}
			default:
				return ErrInvalidAuthority
			}
			_, err = keys.Token()
			if err != nil {
				return err
			}
		}
		return nil
	}
	if err := scan(); err != nil {
		return err
	}
	if _, err := keys.Token(); err != io.EOF {
		return ErrInvalidAuthority
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return ErrInvalidAuthority
	}
	return nil
}

func initialKernelBytes(vm, token string) ([]byte, error) {
	return json.Marshal(map[string]any{
		"vm_id": vm, "socket_path": "/run/kin/kernel.sock", "credential_path": "/home/kincli/.claude/credentials.json",
		"internal_token": token, "provider": "local_cli", "dataplane": "wrap", "claude_bin": "/opt/kin/cli-node",
		"proxy_url": "", "proxy_required": false, "runtime_kind": "docker", "delivery_mode": "realtime",
		"refresh_skew_seconds": 300, "request_timeout_seconds": 0, "first_byte_timeout_seconds": 600, "idle_timeout_seconds": 180,
		"max_request_bytes": 16 << 20, "max_response_bytes": 64 << 20, "max_event_bytes": 32 << 20, "slots_per_worker": 1,
		"timezone": "UTC", "test_endpoints": false,
	})
}

type initialPublisher struct {
	authority *Authority
	root      string
	nodeID    string
	policy    DockerLaunchPolicy
	authorize CommandAuthorizer
	// Fault injection stays node-local; it is never part of Config or RPC.
	fault func(string) error
}

func (p *initialPublisher) Publish(ctx context.Context, intent ManagementIntent, length int, source io.Reader) (PublicationReceipt, error) {
	if p.authorize == nil || intent.NodeID != p.nodeID {
		return PublicationReceipt{}, ErrManagementDenied
	}
	if !validManagementIntent(intent) || intent.Action != "publish-initial" || intent.PolicyDigest != p.policy.digest() || length <= 0 || length > initialPublishMax {
		return PublicationReceipt{}, ErrInvalidAuthority
	}
	var handle CommandHandle
	var receipt *PublicationReceipt
	err := p.authorize(ctx, intent, func() error {
		var err error
		handle, receipt, err = p.authority.beginInitialPublish(intent)
		return err
	})
	if err != nil {
		return PublicationReceipt{}, err
	}
	if receipt != nil {
		return *receipt, nil
	}
	if ctx.Err() != nil {
		return PublicationReceipt{}, ctx.Err()
	}
	data := make([]byte, length)
	if _, err = io.ReadFull(source, data); err != nil {
		return PublicationReceipt{}, err
	}
	if ctx.Err() != nil {
		return PublicationReceipt{}, ctx.Err()
	}
	if hashBytes(data) != intent.PayloadDigest {
		return PublicationReceipt{}, ErrInvalidAuthority
	}
	credential, err := initialCredentialBytes(data)
	if err != nil {
		return PublicationReceipt{}, err
	}
	var secret [32]byte
	if _, err = rand.Read(secret[:]); err != nil {
		return PublicationReceipt{}, err
	}
	token := hex.EncodeToString(secret[:])
	kernel, err := initialKernelBytes(intent.VMID, token)
	if err != nil {
		return PublicationReceipt{}, err
	}
	manifest := initialManifest{Receipt: PublicationReceipt{Intent: intent, IntentDigest: intent.digest(), ManifestRevision: "1"}, KernelDigest: hashBytes(kernel), TokenDigest: hashText(token + "\n"), CredentialDigest: hashBytes(credential)}
	manifest.Receipt.ManifestDigest = manifest.digest()
	tree, err := stageInitialFiles(p.root, intent, p.policy, kernel, []byte(token+"\n"), credential, p.fault)
	if err != nil {
		return PublicationReceipt{}, err
	}
	defer tree.Close()
	if ctx.Err() != nil {
		return PublicationReceipt{}, ctx.Err()
	}
	err = p.authorize(ctx, intent, func() error {
		return p.authority.completeInitialPublish(handle, intent, manifest, func() error { return tree.Publish(manifest, p.fault) })
	})
	if err != nil {
		return PublicationReceipt{}, err
	}
	return manifest.Receipt, nil
}

func (a *Authority) beginInitialPublish(intent ManagementIntent) (CommandHandle, *PublicationReceipt, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !validManagementIntent(intent) || intent.Action != "publish-initial" {
		return CommandHandle{}, nil, ErrInvalidAuthority
	}
	state, err := a.match(intent.VMID, intent.Fence)
	if err != nil {
		return CommandHandle{}, nil, err
	}
	if state.Phase != PhaseVacant || state.Allocation == nil || state.Allocation.AllocationID != intent.AllocationID || state.Allocation.NodeID != intent.NodeID || state.Allocation.Fence != intent.Fence {
		return CommandHandle{}, nil, ErrAuthorityPhase
	}
	if old, ok := state.Commands[intent.CommandID]; ok {
		if old.Kind == commandPublish && old.Management != nil && *old.Management == intent && old.Status == CommandCompleted && state.InitialManifest != nil {
			receipt := state.InitialManifest.Receipt
			return CommandHandle{}, &receipt, nil
		}
		return CommandHandle{}, nil, ErrCommandExists
	}
	if state.InitialManifest != nil || hasPendingMutation(state) {
		return CommandHandle{}, nil, ErrPendingMutation
	}
	token, err := randomAuthorityID()
	if err != nil {
		return CommandHandle{}, nil, err
	}
	copy := intent
	state.Commands[intent.CommandID] = CommandRecord{ID: intent.CommandID, Kind: commandPublish, Status: CommandPending, Fence: intent.Fence, Runtime: a.runtime, Token: token, Dispatched: true, Management: &copy}
	if _, err = a.commit(intent.VMID, state); err != nil {
		return CommandHandle{}, nil, err
	}
	return CommandHandle{VMID: intent.VMID, ID: intent.CommandID, Fence: intent.Fence, runtime: a.runtime, token: token}, nil, nil
}

func (a *Authority) completeInitialPublish(handle CommandHandle, intent ManagementIntent, manifest initialManifest, publish func() error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	state, command, err := a.command(handle)
	if err != nil {
		return err
	}
	if state.Phase != PhaseVacant || state.InitialManifest != nil || command.Kind != commandPublish || command.Status != CommandPending || command.Management == nil || *command.Management != intent || manifest.Receipt.Intent != intent {
		return ErrAuthorityPhase
	}
	if err = publish(); err != nil {
		return err
	}
	command.Status = CommandCompleted
	state.Commands[handle.ID] = command
	state.InitialManifest = &manifest
	_, err = a.commit(handle.VMID, state)
	return err
}

func validateInitialManifest(vm string, state AuthorityState) error {
	m := state.InitialManifest
	if m == nil {
		return nil
	}
	i := m.Receipt.Intent
	if state.Allocation == nil || !validManagementIntent(i) || i.Action != "publish-initial" || i.VMID != vm || i.AllocationID != state.Allocation.AllocationID || i.NodeID != state.Allocation.NodeID || i.Fence != state.Allocation.Fence ||
		m.Receipt.IntentDigest != i.digest() || m.Receipt.ManifestRevision != "1" || !validDigest(m.KernelDigest) || !validDigest(m.TokenDigest) || !validDigest(m.CredentialDigest) || m.Receipt.ManifestDigest != m.digest() {
		return ErrInvalidAuthority
	}
	command, ok := state.Commands[i.CommandID]
	if !ok || command.Kind != commandPublish || command.Status != CommandCompleted || command.Management == nil || *command.Management != i {
		return ErrInvalidAuthority
	}
	return nil
}

func checkInitialManifest(state AuthorityState, policy DockerLaunchPolicy) error {
	if state.Allocation == nil || state.InitialManifest == nil || validateInitialManifest(state.Allocation.VMID, state) != nil || state.InitialManifest.Receipt.Intent.PolicyDigest != policy.digest() {
		return ErrInvalidAuthority
	}
	if state.InitialManifest.Receipt.Intent.Fence != state.Fence {
		return ErrFenceMismatch
	}
	return nil
}

func publishFault(fault func(string) error, point string) error {
	if fault != nil {
		return fault(point)
	}
	return nil
}

var errPublishUnsupported = errors.New("initial_publish_unsupported")

func (a *Authority) beginManifestLaunch(intent ManagementIntent) (CommandHandle, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !validManagementIntent(intent) || intent.Action != "launch" {
		return CommandHandle{}, ErrInvalidAuthority
	}
	state, err := a.match(intent.VMID, intent.Fence)
	if err != nil {
		return CommandHandle{}, err
	}
	if state.Phase != PhaseVacant || state.InitialManifest == nil || state.Allocation == nil || state.Allocation.AllocationID != intent.AllocationID || state.Allocation.NodeID != intent.NodeID ||
		state.InitialManifest.Receipt.ManifestDigest != intent.ManifestDigest || state.InitialManifest.Receipt.Intent.PolicyDigest != intent.PolicyDigest || hasPendingMutation(state) {
		return CommandHandle{}, ErrAuthorityPhase
	}
	if _, ok := state.Commands[intent.CommandID]; ok {
		return CommandHandle{}, ErrCommandExists
	}
	token, err := randomAuthorityID()
	if err != nil {
		return CommandHandle{}, err
	}
	copy := intent
	state.Commands[intent.CommandID] = CommandRecord{ID: intent.CommandID, Kind: commandLaunch, Status: CommandPending, Fence: intent.Fence, Runtime: a.runtime, Token: token, Management: &copy}
	if _, err = a.commit(intent.VMID, state); err != nil {
		return CommandHandle{}, err
	}
	return CommandHandle{VMID: intent.VMID, ID: intent.CommandID, Fence: intent.Fence, runtime: a.runtime, token: token}, nil
}
