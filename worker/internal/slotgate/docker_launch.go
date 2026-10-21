package slotgate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// DockerLaunchPolicy is node-owned configuration, never a client container
// spec. This first adapter only supports the existing non-KVM Claude payload.
type DockerLaunchPolicy struct {
	ImageID   string `json:"image_id"`
	NetworkID string `json:"network_id"`
	UID       int    `json:"uid"`
	GID       int    `json:"gid"`
}

type dockerLauncher struct {
	engine    *dockerEngine
	authority *Authority
	root      string
	boot      string
	policy    DockerLaunchPolicy
}

func fullDockerID(id string) bool {
	decoded, err := hex.DecodeString(id)
	return err == nil && len(decoded) == 32
}
func pinnedImage(id string) bool {
	return strings.HasPrefix(id, "sha256:") && fullDockerID(strings.TrimPrefix(id, "sha256:"))
}

func validateLaunchTarget(target DockerLaunchTarget) error {
	if !fullDockerID(target.ContainerID) || !pinnedImage(target.ImageID) || !validAuthorityID(target.DockerDaemonID) || !validAuthorityID(target.NodeBootID) || !validAuthorityID(target.Name) {
		return ErrInvalidAuthority
	}
	return nil
}

func newDockerLauncher(socket, root, boot string, a *Authority, policy DockerLaunchPolicy) (*dockerLauncher, error) {
	if !filepath.IsAbs(root) || !validAuthorityID(boot) || !pinnedImage(policy.ImageID) || (policy.NetworkID != "none" && !fullDockerID(policy.NetworkID)) || policy.UID <= 0 || policy.GID <= 0 || uint64(policy.UID) > 1<<31-1 || uint64(policy.GID) > 1<<31-1 {
		return nil, ErrInvalidAuthority
	}
	engine, err := newDockerEngine(socket)
	if err != nil {
		return nil, err
	}
	if a == nil {
		return nil, ErrInvalidAuthority
	}
	return &dockerLauncher{engine: engine, authority: a, root: filepath.Clean(root), boot: boot, policy: policy}, nil
}

func (l *dockerLauncher) Launch(ctx context.Context, vm string, expected Fence, id string) (AuthorityState, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	state, err := l.authority.State(vm)
	if err != nil {
		return AuthorityState{}, err
	}
	if state.Fence != expected {
		return AuthorityState{}, ErrFenceMismatch
	}
	if state.Phase != PhaseVacant {
		return AuthorityState{}, ErrAuthorityPhase
	}
	if hasPendingMutation(state) {
		return AuthorityState{}, ErrPendingMutation
	}
	if !validAuthorityID(id) {
		return AuthorityState{}, ErrInvalidAuthority
	}
	if err = l.privateFiles(vm, expected); err != nil {
		return AuthorityState{}, err
	}
	var daemon struct {
		ID string `json:"ID"`
	}
	if _, err = l.engine.call(ctx, "GET", "/info", nil, &daemon, 200); err != nil {
		return AuthorityState{}, err
	}
	if !validAuthorityID(daemon.ID) {
		return AuthorityState{}, ErrInvalidAuthority
	}
	var image struct {
		ID     string `json:"Id"`
		Config struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	if _, err = l.engine.call(ctx, "GET", "/images/"+l.policy.ImageID+"/json", nil, &image, 200); err != nil {
		return AuthorityState{}, err
	}
	if image.ID != l.policy.ImageID || image.Config.Labels["kin.slot.full"] != "1" {
		return AuthorityState{}, ErrInvalidAuthority
	}
	if l.policy.NetworkID != "none" {
		var network struct {
			ID     string `json:"Id"`
			Driver string `json:"Driver"`
			Scope  string `json:"Scope"`
		}
		if _, err = l.engine.call(ctx, "GET", "/networks/"+l.policy.NetworkID, nil, &network, 200); err != nil {
			return AuthorityState{}, err
		}
		if network.ID != l.policy.NetworkID || network.Driver != "bridge" || network.Scope != "local" {
			return AuthorityState{}, ErrInvalidAuthority
		}
	}
	handle, err := l.authority.BeginLaunch(vm, expected, id)
	if err != nil {
		return AuthorityState{}, err
	}
	if err = l.authority.StartLaunch(handle); err != nil {
		return AuthorityState{}, err
	}
	if err = l.authority.checkLaunch(handle); err != nil {
		return AuthorityState{}, err
	}
	spec, name := l.spec(vm, expected, id)
	var created struct {
		ID string `json:"Id"`
	}
	if _, err = l.engine.call(ctx, "POST", "/containers/create?name="+url.QueryEscape(name), spec, &created, 201); err != nil {
		return AuthorityState{}, err
	}
	if !fullDockerID(created.ID) {
		return AuthorityState{}, ErrInvalidAuthority
	}
	target := DockerLaunchTarget{ContainerID: created.ID, DockerDaemonID: daemon.ID, NodeBootID: l.boot, ImageID: l.policy.ImageID, Name: name}
	if err = l.authority.RecordLaunchTarget(handle, target); err != nil {
		return AuthorityState{}, err
	}
	var currentDaemon struct {
		ID string `json:"ID"`
	}
	if _, err = l.engine.call(ctx, "GET", "/info", nil, &currentDaemon, 200); err != nil {
		return AuthorityState{}, err
	}
	if currentDaemon.ID != daemon.ID {
		return AuthorityState{}, ErrTerminationProof
	}
	if err = l.authority.checkLaunch(handle); err != nil {
		return AuthorityState{}, err
	}
	path := "/containers/" + created.ID
	if _, err = l.engine.call(ctx, "POST", path+"/start", nil, nil, 204, 304); err != nil {
		return AuthorityState{}, err
	}
	var inspected struct {
		ID     string `json:"Id"`
		Image  string `json:"Image"`
		Config struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
		State *struct {
			Running    *bool  `json:"Running"`
			Restarting *bool  `json:"Restarting"`
			StartedAt  string `json:"StartedAt"`
		} `json:"State"`
	}
	if _, err = l.engine.call(ctx, "GET", path+"/json", nil, &inspected, 200); err != nil {
		return AuthorityState{}, err
	}
	if inspected.ID != created.ID || inspected.Image != l.policy.ImageID || inspected.State == nil || inspected.State.Running == nil || !*inspected.State.Running || inspected.State.Restarting == nil || *inspected.State.Restarting {
		return AuthorityState{}, ErrTerminationProof
	}
	for key, value := range spec["Labels"].(map[string]string) {
		if inspected.Config.Labels[key] != value {
			return AuthorityState{}, ErrTerminationProof
		}
	}
	started, err := time.Parse(time.RFC3339Nano, inspected.State.StartedAt)
	if err != nil || started.IsZero() {
		return AuthorityState{}, ErrInvalidAuthority
	}
	currentDaemon.ID = ""
	if _, err = l.engine.call(ctx, "GET", "/info", nil, &currentDaemon, 200); err != nil {
		return AuthorityState{}, err
	}
	if currentDaemon.ID != daemon.ID {
		return AuthorityState{}, ErrTerminationProof
	}
	identity := ExecutorIdentity{Kind: "container", ContainerID: created.ID, DockerDaemonID: daemon.ID, NodeBootID: l.boot, StartedAt: inspected.State.StartedAt}
	return l.authority.BindExecutor(handle, identity)
}

func (l *dockerLauncher) spec(vm string, fence Fence, id string) (map[string]any, string) {
	digest := sha256.Sum256([]byte(vm + "\x00" + fence.Incarnation + "\x00" + id))
	name := "kin-fenced-" + hex.EncodeToString(digest[:16])
	private := filepath.Join(l.root, "vms", vm, "incarnations", fence.Incarnation)
	return map[string]any{
		"Image": l.policy.ImageID, "Hostname": name, "User": fmt.Sprintf("%d:%d", l.policy.UID, l.policy.GID), "WorkingDir": "/home/kincli",
		"Entrypoint": []string{"/opt/kin/kin-kernel"}, "Cmd": []string{"--gateway-worker", "--config", "/run/kin/kernel.json"},
		"Env":    []string{"HOME=/home/kincli", "CLAUDE_CONFIG_DIR=/home/kincli/.claude", "TZ=UTC", "LANG=en_US.UTF-8", "KIN_VM_ID=" + vm},
		"Labels": map[string]string{"kin.slot.fenced": "1", "kin.vm.id": vm, "kin.fence.generation": strconv.FormatUint(fence.Generation, 10), "kin.fence.incarnation": fence.Incarnation, "kin.fence.command": id},
		"HostConfig": map[string]any{
			"Binds":      []string{private + "/home:/home/kincli", private + "/claude:/home/kincli/.claude", private + "/run:/run/kin", private + "/config/kernel.json:/run/kin/kernel.json:ro", private + "/config/internal.token:/run/kin/internal.token:ro"},
			"Privileged": false, "NetworkMode": l.policy.NetworkID, "IpcMode": "private", "RestartPolicy": map[string]string{"Name": "no"}, "ReadonlyRootfs": true,
			"CapDrop": []string{"ALL"}, "SecurityOpt": []string{"no-new-privileges"}, "Memory": int64(1 << 30), "MemorySwap": int64(1 << 30), "NanoCpus": int64(1e9), "PidsLimit": 256,
			"Tmpfs": map[string]string{"/tmp": "rw,noexec,nosuid,size=32m"},
		},
	}, name
}

// File publication is separate. Launch only accepts an already prepared
// private tree; it never follows a symlink, creates a missing bind source, or
// lets a container select a host path. No credential contents are read here.
func (l *dockerLauncher) privateFiles(vm string, fence Fence) error {
	inc, err := hex.DecodeString(fence.Incarnation)
	if err != nil || len(inc) != 16 || !vmIDRe.MatchString(vm) {
		return ErrInvalidAuthority
	}
	parts := []string{l.root, filepath.Join(l.root, "vms"), filepath.Join(l.root, "vms", vm), filepath.Join(l.root, "vms", vm, "incarnations"), filepath.Join(l.root, "vms", vm, "incarnations", fence.Incarnation)}
	for _, dir := range parts {
		if err = launchPath(dir, true, os.Geteuid()); err != nil {
			return err
		}
	}
	base := parts[len(parts)-1]
	if err = launchPath(filepath.Join(base, "config"), true, os.Geteuid()); err != nil {
		return err
	}
	for _, dir := range []string{"run", "home", "claude"} {
		if err = launchPath(filepath.Join(base, dir), true, l.policy.UID); err != nil {
			return err
		}
	}
	for _, file := range []string{"kernel.json", "internal.token"} {
		path := filepath.Join(base, "config", file)
		if err = launchPath(path, false, os.Geteuid()); err != nil {
			return err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		stat := info.Sys().(*syscall.Stat_t)
		readable := info.Mode().Perm()&0o004 != 0 || (int(stat.Uid) == l.policy.UID && info.Mode().Perm()&0o400 != 0) || (int(stat.Gid) == l.policy.GID && info.Mode().Perm()&0o040 != 0)
		if !readable {
			return ErrInvalidAuthority
		}
	}
	return nil
}

func launchPath(path string, directory bool, owner int) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != owner || info.Mode().Perm()&0o022 != 0 || info.Mode()&os.ModeSymlink != 0 || info.IsDir() != directory {
		return ErrInvalidAuthority
	}
	if directory && info.Mode().Perm()&0o077 != 0 {
		return ErrInvalidAuthority
	}
	if !directory && (!info.Mode().IsRegular() || stat.Nlink != 1 || info.Size() == 0 || info.Size() > gate2RequestMax) {
		return ErrInvalidAuthority
	}
	return nil
}
