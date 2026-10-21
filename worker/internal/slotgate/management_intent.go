package slotgate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
)

const initialPresetID = "claude-docker-v1"
const initialPublishMax = 64 << 10
const commandPublish CommandKind = "publish-initial"

// ManagementIntent is an exact issued grant, not a reusable node capability.
// All decimal fields remain strings across the PG/JavaScript boundary.
type ManagementIntent struct {
	Action                   string `json:"action"`
	NodeID                   string `json:"node_id"`
	VMID                     string `json:"vm_id"`
	AllocationID             string `json:"allocation_id"`
	OperationID              string `json:"operation_id"`
	OwnerID                  string `json:"owner_id"`
	CommandID                string `json:"command_id"`
	Epoch                    string `json:"epoch"`
	Fence                    Fence  `json:"fence"`
	ExpectedManifestRevision string `json:"expected_manifest_revision"`
	ManifestRevision         string `json:"manifest_revision"`
	PayloadDigest            string `json:"payload_digest"`
	PresetID                 string `json:"preset_id"`
	PolicyDigest             string `json:"policy_digest"`
	ManifestDigest           string `json:"manifest_digest"`
}

// CommandAuthorizer holds the node/VM grant's shared authorization lock only
// across dispatch's bounded local journal/rename work, never upload or Engine I/O.
type CommandAuthorizer func(context.Context, ManagementIntent, func() error) error

func (i ManagementIntent) digest() string {
	return hashText(strings.Join([]string{"slotgate-command-v1", i.Action, i.NodeID, i.VMID, i.AllocationID,
		i.OperationID, i.OwnerID, i.CommandID, i.Epoch, strconv.FormatUint(i.Fence.Generation, 10), i.Fence.Incarnation,
		i.ExpectedManifestRevision, i.ManifestRevision, i.PayloadDigest, i.PresetID, i.PolicyDigest, i.ManifestDigest}, "\x00"))
}

func hashText(value string) string  { return hashBytes([]byte(value)) }
func hashBytes(value []byte) string { sum := sha256.Sum256(value); return hex.EncodeToString(sum[:]) }
func validDigest(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == 32 && strings.ToLower(value) == value
}

func validManagementIntent(i ManagementIntent) bool {
	if !validAllocation(AllocationIntent{i.NodeID, i.VMID, i.AllocationID, i.OperationID, i.OwnerID}, i.Epoch) ||
		!vmIDRe.MatchString(i.CommandID) || i.Fence.Generation != 1 || i.Fence.Executor != (ExecutorIdentity{}) ||
		i.PresetID != initialPresetID || !validDigest(i.PolicyDigest) || i.ManifestRevision != "1" {
		return false
	}
	incarnation, err := hex.DecodeString(i.Fence.Incarnation)
	if err != nil || len(incarnation) != 16 || strings.ToLower(i.Fence.Incarnation) != i.Fence.Incarnation {
		return false
	}
	switch i.Action {
	case "publish-initial":
		return i.ExpectedManifestRevision == "0" && validDigest(i.PayloadDigest) && i.ManifestDigest == ""
	case "launch":
		return i.ExpectedManifestRevision == "1" && i.PayloadDigest == "" && validDigest(i.ManifestDigest)
	}
	return false
}

func (p DockerLaunchPolicy) digest() string {
	return hashText(strings.Join([]string{"slotgate-policy-v1", initialPresetID, p.ImageID, p.NetworkID,
		strconv.Itoa(p.UID), strconv.Itoa(p.GID)}, "\x00"))
}

type PublicationReceipt struct {
	Intent           ManagementIntent `json:"intent"`
	IntentDigest     string           `json:"intent_digest"`
	ManifestRevision string           `json:"manifest_revision"`
	ManifestDigest   string           `json:"manifest_digest"`
}

type LaunchReceipt struct {
	Intent           ManagementIntent `json:"intent"`
	IntentDigest     string           `json:"intent_digest"`
	ManifestRevision string           `json:"manifest_revision"`
	ManifestDigest   string           `json:"manifest_digest"`
	Fence            Fence            `json:"fence"`
}

// Private file hashes stay in the journal; RPC receipts expose only the
// aggregate manifest and never credentials, internal tokens or their hashes.
type initialManifest struct {
	Receipt          PublicationReceipt `json:"receipt"`
	KernelDigest     string             `json:"kernel_digest"`
	TokenDigest      string             `json:"token_digest"`
	CredentialDigest string             `json:"credential_digest"`
}

func (m initialManifest) digest() string {
	return hashText(strings.Join([]string{"slotgate-manifest-v1", m.Receipt.Intent.digest(), "1",
		m.KernelDigest, m.TokenDigest, m.CredentialDigest}, "\x00"))
}
