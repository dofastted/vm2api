package slotgate

import (
	"bytes"
	"encoding/json"
)

const nodePrivateCredentialAuthority = "node-private-v1"

type nodeCredentialState struct {
	Generation       string `json:"generation"`
	CanonicalDigest  string `json:"canonical_digest"`
	ProjectionDigest string `json:"projection_digest"`
}

func validNodeCredentialState(s *nodeCredentialState) bool {
	if s == nil || !validDigest(s.CanonicalDigest) || !validDigest(s.ProjectionDigest) {
		return false
	}
	gen, err := credentialScalar(json.RawMessage(s.Generation))
	return err == nil && gen == s.Generation && gen != "0"
}

// Only the private canonical document contains the rotating token. The guest
// projection retains the existing schema and cannot refresh by itself.
func credentialProjection(data []byte) ([]byte, error) {
	var doc map[string]json.RawMessage
	if strictJSON(data, &doc) != nil {
		return nil, ErrInvalidAuthority
	}
	if raw, ok := doc["claudeAiOauth"]; ok {
		var oauth map[string]json.RawMessage
		if strictJSON(raw, &oauth) != nil {
			return nil, ErrInvalidAuthority
		}
		delete(oauth, "refreshToken")
		delete(oauth, "refresh_token")
		var err error
		doc["claudeAiOauth"], err = json.Marshal(oauth)
		if err != nil {
			return nil, err
		}
	}
	delete(doc, "refreshToken")
	delete(doc, "refresh_token")
	return json.Marshal(doc)
}

func (a *Authority) readCanonicalCredential(root, vm string, fence Fence, policy DockerLaunchPolicy, state AuthorityState) ([]byte, error) {
	if state.InitialManifest == nil || state.InitialManifest.CredentialAuthority != nodePrivateCredentialAuthority || !validNodeCredentialState(state.Credential) {
		return nil, ErrManagementDenied
	}
	canonical, err := readNodeCredential(a.root, vm, fence)
	if err != nil || hashBytes(canonical) != state.Credential.CanonicalDigest {
		return nil, ErrInvalidAuthority
	}
	projection, err := credentialProjection(canonical)
	if err != nil || hashBytes(projection) != state.Credential.ProjectionDigest {
		return nil, ErrInvalidAuthority
	}
	guest, err := readPublishedCredential(root, vm, fence, policy)
	if err != nil || !bytes.Equal(guest, projection) {
		return nil, ErrManagementDenied
	}
	if err = checkCredentialLink(root, vm, fence, policy); err != nil {
		return nil, err
	}
	summary, _, err := nodeCredentialSummary(canonical, state.InitialManifest.Identity)
	if err != nil || summary["generation"] != state.Credential.Generation {
		return nil, ErrInvalidAuthority
	}
	return canonical, nil
}
