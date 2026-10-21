package slotgate

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/credential"
)

const nodeHealthMax = 32 << 10

func publicHealthString(value string) bool {
	if len(value) > 512 {
		return false
	}
	for _, c := range value {
		if c < 0x20 || c == 0x7f {
			return false
		}
	}
	return true
}

// The caller holds the Authority lock. No state is changed and no latest Fence
// is substituted for the request's original identity.
func (a *Authority) healthStateLocked(request gate2Request) (AuthorityState, error) {
	state, err := a.match(request.VMID, request.Fence)
	if err != nil {
		return AuthorityState{}, err
	}
	if state.Phase != PhaseActive || state.Allocation == nil || state.InitialManifest == nil || hasPendingMutation(state) {
		return AuthorityState{}, ErrAuthorityPhase
	}
	manifest := state.InitialManifest
	if validateInitialManifest(request.VMID, state) != nil || request.ManifestRevision != "1" || request.ManifestRevision != manifest.Receipt.ManifestRevision || request.ManifestDigest != manifest.Receipt.ManifestDigest ||
		request.Fence.Generation != manifest.Receipt.Intent.Fence.Generation || request.Fence.Incarnation != manifest.Receipt.Intent.Fence.Incarnation {
		return AuthorityState{}, ErrFenceMismatch
	}
	return state, nil
}

func (a *Authority) withHealthState(request gate2Request, read func(AuthorityState) error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	state, err := a.healthStateLocked(request)
	if err != nil {
		return err
	}
	return read(state)
}

func (s *Server) readHealth(ctx context.Context, request gate2Request) (map[string]any, error) {
	if s.launcher == nil || request.CommandID != "" || request.Kind != "" || request.Ticket != "" || request.AllocationID != "" || request.OperationID != "" || request.OwnerID != "" || request.Management != nil || request.ContentLength != 0 || !validDigest(request.ManifestDigest) {
		return nil, ErrManagementDenied
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var snapshot AuthorityState
	if err := s.authority.withHealthState(request, func(state AuthorityState) error { snapshot = state; return nil }); err != nil {
		return nil, err
	}
	if snapshot.InitialManifest.Receipt.Intent.PolicyDigest != s.launcher.policy.digest() {
		return nil, ErrManagementDenied
	}
	token, err := readPublishedInitial(s.cfg.Root, request.VMID, request.Fence, s.launcher.policy, *snapshot.InitialManifest, false)
	if err != nil {
		return nil, err
	}
	before, err := readPublishedCredential(s.cfg.Root, request.VMID, request.Fence, s.launcher.policy)
	if err != nil {
		return nil, err
	}
	if snapshot.InitialManifest.CredentialAuthority == nodePrivateCredentialAuthority {
		before, err = s.authority.readCanonicalCredential(s.cfg.Root, request.VMID, request.Fence, s.launcher.policy, snapshot)
		if err != nil {
			return nil, err
		}
	}
	summary, identity, err := nodeCredentialSummary(before, snapshot.InitialManifest.Identity)
	if err != nil {
		return nil, err
	}
	socket := filepath.Join(s.cfg.Root, "vms", request.VMID, "incarnations", request.Fence.Incarnation, "run", "kernel.sock")
	connection, err := dialSlotSocketContext(ctx, socket)
	if err != nil {
		return nil, err
	}
	defer connection.Close()
	deadline, _ := ctx.Deadline()
	if err = connection.SetDeadline(deadline); err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { connection.Close() })
	defer stop()
	read, _ := http.NewRequest(http.MethodGet, "http://kernel/internal/health", nil)
	read.Close = true
	read.Header.Set("Accept", "application/json")
	read.Header.Set("x-internal-token", token)
	read.Header.Set("x-kin-internal-token", token)
	// Serialize only this fixed, small request at the captured send boundary.
	// Response reads and all parsing happen without the Authority global lock.
	err = s.authority.withHealthState(request, func(_ AuthorityState) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return read.Write(connection)
	})
	if err != nil {
		return nil, err
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), read)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	media, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || media != "application/json" || response.StatusCode != http.StatusOK || response.ProtoMajor != 1 || response.ContentLength > nodeHealthMax {
		return nil, ErrInvalidAuthority
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, nodeHealthMax+1))
	if err != nil || len(data) > nodeHealthMax || len(response.Trailer) != 0 {
		return nil, ErrInvalidAuthority
	}
	health, err := publicKernelHealth(data, snapshot.InitialManifest.Identity)
	if err != nil {
		return nil, err
	}
	after, err := readPublishedCredential(s.cfg.Root, request.VMID, request.Fence, s.launcher.policy)
	if snapshot.InitialManifest.CredentialAuthority == nodePrivateCredentialAuthority {
		after, err = s.authority.readCanonicalCredential(s.cfg.Root, request.VMID, request.Fence, s.launcher.policy, snapshot)
	}
	if err != nil || !bytes.Equal(before, after) {
		return nil, ErrManagementDenied
	}
	if _, err = readPublishedInitial(s.cfg.Root, request.VMID, request.Fence, s.launcher.policy, *snapshot.InitialManifest, false); err != nil {
		return nil, err
	}
	if err = s.authority.withHealthState(request, func(state AuthorityState) error {
		if *state.InitialManifest != *snapshot.InitialManifest {
			return ErrFenceMismatch
		}
		return nil
	}); err != nil {
		return nil, err
	}
	health["credential"] = summary
	health["identity"] = identity
	return health, nil
}

func publicKernelHealth(data []byte, identity credentialIdentity) (map[string]any, error) {
	var source map[string]json.RawMessage
	if strictJSON(data, &source) != nil || source == nil {
		return nil, ErrInvalidAuthority
	}
	out := map[string]any{}
	for _, name := range []string{"ok", "healthy", "recovering", "classifier_request_context"} {
		if raw, ok := source[name]; ok {
			var value *bool
			if json.Unmarshal(raw, &value) != nil || value == nil {
				return nil, ErrInvalidAuthority
			}
			out[name] = *value
		}
	}
	if _, ok := out["ok"]; !ok {
		return nil, ErrInvalidAuthority
	}
	for _, name := range []string{"ready_slots", "closed_slots", "cli_restarts", "cli_pid"} {
		if raw, ok := source[name]; ok {
			value, err := strconv.ParseUint(string(raw), 10, 53)
			if err != nil || strconv.FormatUint(value, 10) != string(raw) {
				return nil, ErrInvalidAuthority
			}
			out[name] = value
		}
	}
	for _, name := range []string{"engine", "provider", "worker_version", "version", "unhealthy_reason"} {
		if raw, ok := source[name]; ok {
			var value *string
			if json.Unmarshal(raw, &value) != nil {
				return nil, ErrInvalidAuthority
			}
			if value == nil {
				out[name] = nil
				continue
			}
			if !publicHealthString(*value) {
				return nil, ErrInvalidAuthority
			}
			// Arbitrary internal error descriptions can contain endpoint or auth
			// details. Expose a fixed public reason instead of returning text.
			if name == "unhealthy_reason" && *value != "" {
				out[name] = "kernel_unhealthy"
			} else {
				out[name] = *value
			}
		}
	}
	for _, name := range []string{"credential", "identity"} {
		if raw, ok := source[name]; ok {
			var value map[string]json.RawMessage
			if json.Unmarshal(raw, &value) != nil || value == nil {
				return nil, ErrInvalidAuthority
			}
			if account, ok := value["account_uuid"]; ok {
				var id string
				if json.Unmarshal(account, &id) != nil || id != identity.AccountUUID {
					return nil, ErrManagementDenied
				}
			}
		}
	}
	return out, nil
}

func credentialString(source map[string]json.RawMessage, names ...string) (string, error) {
	for _, name := range names {
		if raw, ok := source[name]; ok {
			var value string
			if json.Unmarshal(raw, &value) != nil {
				return "", ErrInvalidAuthority
			}
			return value, nil
		}
	}
	return "", nil
}

func credentialRaw(source map[string]json.RawMessage, names ...string) json.RawMessage {
	for _, name := range names {
		if raw, ok := source[name]; ok {
			return raw
		}
	}
	return nil
}

// No float64 conversion: generation remains exact even beyond JS safe integer.
func credentialScalar(raw json.RawMessage) (string, error) {
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return "0", nil
	}
	if raw[0] == '"' {
		var value string
		if json.Unmarshal(raw, &value) != nil || value == "" || len(value) > 128 || !publicHealthString(value) {
			return "", ErrInvalidAuthority
		}
		return value, nil
	}
	value := string(raw)
	if len(value) > 128 || value == "" || (len(value) > 1 && value[0] == '0') {
		return "", ErrInvalidAuthority
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return "", ErrInvalidAuthority
		}
	}
	return value, nil
}

func nodeCredentialSummary(data []byte, expected credentialIdentity) (map[string]any, map[string]any, error) {
	var document map[string]json.RawMessage
	if strictJSON(data, &document) != nil || document == nil {
		return nil, nil, ErrInvalidAuthority
	}
	oauth := document
	if raw, ok := document["claudeAiOauth"]; ok {
		if json.Unmarshal(raw, &oauth) != nil || oauth == nil {
			return nil, nil, ErrInvalidAuthority
		}
	}
	account, err := credentialString(oauth, "accountUuid", "account_uuid")
	if err != nil || account != expected.AccountUUID {
		return nil, nil, ErrManagementDenied
	}
	org, err := credentialString(oauth, "orgUuid", "org_uuid")
	if err != nil {
		return nil, nil, err
	}
	email, err := credentialString(oauth, "email", "emailAddress", "email_address")
	if err != nil {
		return nil, nil, err
	}
	if !validCredentialIdentity(credentialIdentity{account, org, email}) {
		return nil, nil, ErrInvalidAuthority
	}
	typ, err := credentialString(document, "type")
	if err != nil {
		return nil, nil, err
	}
	if credential.NormalizeType(typ) == credential.TypeOAuth {
		if nested, e := credentialString(oauth, "type"); e != nil {
			return nil, nil, e
		} else if nested != "" {
			typ = nested
		}
	}
	access, err := credentialString(oauth, "accessToken", "access_token")
	if err != nil {
		return nil, nil, err
	}
	refresh, err := credentialString(oauth, "refreshToken", "refresh_token")
	if err != nil {
		return nil, nil, err
	}
	if raw, ok := document["anthropicApiKey"]; ok {
		var api map[string]json.RawMessage
		if json.Unmarshal(raw, &api) != nil || api == nil {
			return nil, nil, ErrInvalidAuthority
		}
		access, err = credentialString(api, "apiKey", "api_key")
		if err != nil {
			return nil, nil, err
		}
		typ = "apikey"
	}
	genRaw := credentialRaw(oauth, "kinGeneration", "kin_generation", "_token_version")
	if len(genRaw) == 0 {
		genRaw = credentialRaw(document, "kinGeneration", "kin_generation", "_token_version")
	}
	generation, err := credentialScalar(genRaw)
	if err != nil {
		return nil, nil, err
	}
	expires, err := credentialScalar(credentialRaw(oauth, "expiresAt", "expires_at"))
	if err != nil {
		return nil, nil, err
	}
	expiry, err := strconv.ParseInt(expires, 10, 64)
	if err != nil || expiry < 0 {
		return nil, nil, ErrInvalidAuthority
	}
	if expiry > 0 && expiry < 10_000_000_000 {
		expiry *= 1000
		expires = strconv.FormatInt(expiry, 10)
	}
	cred := credential.Credential{Type: typ, AccessToken: access, RefreshToken: refresh, ExpiresAt: expiry}
	summary := map[string]any{"has_access": cred.Valid(), "has_refresh": strings.TrimSpace(refresh) != "", "expires_at": expires, "generation": generation, "account_uuid": account, "needs_refresh": cred.NeedsRefresh(time.Now(), 5*time.Minute)}
	identity := map[string]any{"account_uuid": account}
	if org != "" {
		summary["org_uuid"] = org
		identity["org_uuid"] = org
	}
	if email != "" {
		summary["email"] = email
		identity["email"] = email
	}
	return summary, identity, nil
}
