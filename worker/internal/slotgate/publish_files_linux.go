//go:build linux

package slotgate

import (
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

type initialFileTree struct {
	parent      *os.File
	stage       *os.File
	name        string
	incarnation string
	policy      DockerLaunchPolicy
}

func secureRoot(root string) (*os.File, error) {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return nil, ErrInvalidAuthority
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, part := range strings.Split(strings.TrimPrefix(root, "/"), "/") {
		if part == "" {
			continue
		}
		next, e := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if e != nil {
			return nil, e
		}
		fd = next
	}
	file := os.NewFile(uintptr(fd), root)
	if err = secureDirectory(file, os.Geteuid()); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func secureDirectory(dir *os.File, owner int) error {
	var stat unix.Stat_t
	if err := unix.Fstat(int(dir.Fd()), &stat); err != nil {
		return err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR || int(stat.Uid) != owner || stat.Mode&0o077 != 0 {
		return ErrInvalidAuthority
	}
	return nil
}

func openDirectoryAt(parent *os.File, name string, create bool, owner int) (*os.File, error) {
	if name == "" || name == "." || name == ".." || strings.Contains(name, "/") {
		return nil, ErrInvalidAuthority
	}
	if create {
		if err := unix.Mkdirat(int(parent.Fd()), name, 0o700); err != nil && !errors.Is(err, unix.EEXIST) {
			return nil, err
		}
	}
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), name)
	if err = secureDirectory(file, owner); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func incarnationParent(root, vm string, create bool) (*os.File, error) {
	if !vmIDRe.MatchString(vm) {
		return nil, ErrInvalidAuthority
	}
	current, err := secureRoot(root)
	if err != nil {
		return nil, err
	}
	for _, name := range []string{"vms", vm, "incarnations"} {
		next, e := openDirectoryAt(current, name, create, os.Geteuid())
		if e == nil && create {
			e = current.Sync()
		}
		current.Close()
		if e != nil {
			if next != nil {
				next.Close()
			}
			return nil, e
		}
		current = next
	}
	return current, nil
}

func writeInitialFile(dir *os.File, name string, data []byte, uid, gid int, mode uint32) error {
	fd, err := unix.Openat(int(dir.Fd()), name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, mode)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	var stat unix.Stat_t
	if err = unix.Fstat(fd, &stat); err != nil {
		return err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Nlink != 1 {
		return ErrInvalidAuthority
	}
	if _, err = file.Write(data); err != nil {
		return err
	}
	if int(stat.Uid) != uid || int(stat.Gid) != gid {
		if err = unix.Fchown(fd, uid, gid); err != nil {
			return err
		}
	}
	if err = unix.Fchmod(fd, mode); err != nil {
		return err
	}
	return file.Sync()
}

func stageInitialFiles(root string, intent ManagementIntent, policy DockerLaunchPolicy, kernel, token, credential []byte, fault func(string) error) (*initialFileTree, error) {
	parent, err := incarnationParent(root, intent.VMID, true)
	if err != nil {
		return nil, err
	}
	id, err := randomAuthorityID()
	if err != nil {
		parent.Close()
		return nil, err
	}
	tree := &initialFileTree{parent: parent, name: ".stage-" + id, incarnation: intent.Fence.Incarnation, policy: policy}
	fail := func(err error) (*initialFileTree, error) { tree.Close(); return nil, err }
	if err = unix.Mkdirat(int(parent.Fd()), tree.name, 0o700); err != nil {
		return fail(err)
	}
	tree.stage, err = openDirectoryAt(parent, tree.name, false, os.Geteuid())
	if err != nil {
		return fail(err)
	}
	for _, name := range []string{"config", "home", "claude", "run"} {
		dir, e := openDirectoryAt(tree.stage, name, true, os.Geteuid())
		if e != nil {
			return fail(e)
		}
		if name == "config" {
			mode := uint32(0o600)
			if policy.UID != os.Geteuid() {
				mode = 0o640
			}
			e = writeInitialFile(dir, "kernel.json", kernel, os.Geteuid(), policy.GID, mode)
			if e == nil {
				e = writeInitialFile(dir, "internal.token", token, os.Geteuid(), policy.GID, mode)
			}
		} else if name == "claude" {
			e = writeInitialFile(dir, "credentials.json", credential, policy.UID, policy.GID, 0o400)
			if e == nil {
				e = unix.Symlinkat("credentials.json", int(dir.Fd()), ".credentials.json")
			}
		}
		if e == nil && name != "config" {
			e = unix.Fchown(int(dir.Fd()), policy.UID, policy.GID)
		}
		if e == nil {
			e = dir.Sync()
		}
		dir.Close()
		if e != nil {
			return fail(e)
		}
	}
	if err = tree.stage.Sync(); err != nil {
		return fail(err)
	}
	if err = parent.Sync(); err != nil {
		return fail(err)
	}
	if err = publishFault(fault, "staged"); err != nil {
		return fail(err)
	}
	return tree, nil
}

func readInitialFile(dir *os.File, name string, owner int, max int64) ([]byte, error) {
	fd, err := unix.Openat(int(dir.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	var stat unix.Stat_t
	if err = unix.Fstat(fd, &stat); err != nil {
		return nil, err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Nlink != 1 || int(stat.Uid) != owner || stat.Mode&0o022 != 0 || stat.Size <= 0 || stat.Size > max {
		return nil, ErrInvalidAuthority
	}
	data, err := io.ReadAll(io.LimitReader(file, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, ErrInvalidAuthority
	}
	return data, nil
}

func checkInitialTree(base *os.File, policy DockerLaunchPolicy, manifest initialManifest, credentials bool) (string, error) {
	if err := secureDirectory(base, os.Geteuid()); err != nil {
		return "", err
	}
	// Fixed enumeration also refuses unexpected directories/files in staging.
	entries, err := base.ReadDir(-1)
	if err != nil {
		return "", err
	}
	if _, err = base.Seek(0, 0); err != nil {
		return "", err
	}
	if len(entries) != 4 {
		return "", ErrInvalidAuthority
	}
	for _, entry := range entries {
		if entry.Name() != "config" && entry.Name() != "home" && entry.Name() != "claude" && entry.Name() != "run" {
			return "", ErrInvalidAuthority
		}
	}
	config, err := openDirectoryAt(base, "config", false, os.Geteuid())
	if err != nil {
		return "", err
	}
	defer config.Close()
	entries, err = config.ReadDir(-1)
	if err != nil || len(entries) != 2 {
		return "", ErrInvalidAuthority
	}
	kernel, err := readInitialFile(config, "kernel.json", os.Geteuid(), gate2LineMax)
	if err != nil {
		return "", err
	}
	token, err := readInitialFile(config, "internal.token", os.Geteuid(), 256)
	if err != nil {
		return "", err
	}
	if hashBytes(kernel) != manifest.KernelDigest || hashBytes(token) != manifest.TokenDigest {
		return "", ErrInvalidAuthority
	}
	value := strings.TrimSuffix(string(token), "\n")
	decoded, e := hex.DecodeString(value)
	if e != nil || len(decoded) != 32 || strings.ToLower(value) != value || string(token) != value+"\n" {
		return "", ErrInvalidAuthority
	}
	for _, name := range []string{"home", "claude", "run"} {
		dir, e := openDirectoryAt(base, name, false, policy.UID)
		if e != nil {
			return "", e
		}
		if credentials && name == "claude" {
			entries, e = dir.ReadDir(-1)
			if e == nil && len(entries) != 2 {
				e = ErrInvalidAuthority
			}
			var data []byte
			if e == nil {
				data, e = readInitialFile(dir, "credentials.json", policy.UID, initialPublishMax)
			}
			if e == nil && hashBytes(data) != manifest.CredentialDigest {
				e = ErrInvalidAuthority
			}
			link := make([]byte, 64)
			var n int
			if e == nil {
				n, e = unix.Readlinkat(int(dir.Fd()), ".credentials.json", link)
			}
			if e == nil && string(link[:n]) != "credentials.json" {
				e = ErrInvalidAuthority
			}
		}
		dir.Close()
		if e != nil {
			return "", e
		}
	}
	return value, nil
}

func (t *initialFileTree) Publish(manifest initialManifest, fault func(string) error) error {
	if _, err := checkInitialTree(t.stage, t.policy, manifest, true); err != nil {
		return err
	}
	if err := publishFault(fault, "before-rename"); err != nil {
		return err
	}
	if err := unix.Renameat2(int(t.parent.Fd()), t.name, int(t.parent.Fd()), t.incarnation, unix.RENAME_NOREPLACE); err != nil {
		return err
	}
	if err := publishFault(fault, "after-rename"); err != nil {
		return err
	}
	if err := t.parent.Sync(); err != nil {
		return err
	}
	return publishFault(fault, "before-manifest-journal")
}

func (t *initialFileTree) Close() {
	if t.stage != nil {
		t.stage.Close()
	}
	if t.parent != nil {
		t.parent.Close()
	}
}

func readPublishedInitial(root, vm string, fence Fence, policy DockerLaunchPolicy, manifest initialManifest, credentials bool) (string, error) {
	if fence.Generation != manifest.Receipt.Intent.Fence.Generation || fence.Incarnation != manifest.Receipt.Intent.Fence.Incarnation {
		return "", ErrFenceMismatch
	}
	parent, err := incarnationParent(root, vm, false)
	if err != nil {
		return "", err
	}
	defer parent.Close()
	base, err := openDirectoryAt(parent, fence.Incarnation, false, os.Geteuid())
	if err != nil {
		return "", err
	}
	defer base.Close()
	return checkInitialTree(base, policy, manifest, credentials)
}

func readPublishedCredential(root, vm string, fence Fence, policy DockerLaunchPolicy) ([]byte, error) {
	parent, err := incarnationParent(root, vm, false)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	base, err := openDirectoryAt(parent, fence.Incarnation, false, os.Geteuid())
	if err != nil {
		return nil, err
	}
	defer base.Close()
	dir, err := openDirectoryAt(base, "claude", false, policy.UID)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	return readInitialFile(dir, "credentials.json", policy.UID, initialPublishMax)
}
