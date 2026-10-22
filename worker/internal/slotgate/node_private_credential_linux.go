//go:build linux

package slotgate

import (
	"golang.org/x/sys/unix"
	"os"
)

func nodeCredentialDirectory(root, vm string, fence Fence, create bool) (*os.File, error) {
	if !vmIDRe.MatchString(vm) || len(fence.Incarnation) != 32 {
		return nil, ErrInvalidAuthority
	}
	dir, err := secureRoot(root)
	if err != nil {
		return nil, err
	}
	for _, name := range []string{"credentials", vm, fence.Incarnation} {
		next, e := openDirectoryAt(dir, name, create, os.Geteuid())
		if e == nil && create {
			e = dir.Sync()
		}
		dir.Close()
		if e != nil {
			if next != nil {
				next.Close()
			}
			return nil, e
		}
		dir = next
	}
	return dir, nil
}
func writeInitialNodeCredential(root, vm string, fence Fence, data []byte) error {
	dir, err := nodeCredentialDirectory(root, vm, fence, true)
	if err != nil {
		return err
	}
	defer dir.Close()
	if err = writeInitialFile(dir, "credentials.json", data, os.Geteuid(), os.Getegid(), 0o600); err != nil {
		return err
	}
	return dir.Sync()
}
func readNodeCredential(root, vm string, fence Fence) ([]byte, error) {
	dir, err := nodeCredentialDirectory(root, vm, fence, false)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	return readInitialFile(dir, "credentials.json", os.Geteuid(), initialPublishMax)
}
func checkCredentialLink(root, vm string, fence Fence, policy DockerLaunchPolicy) error {
	parent, err := incarnationParent(root, vm, false)
	if err != nil {
		return err
	}
	defer parent.Close()
	base, err := openDirectoryAt(parent, fence.Incarnation, false, os.Geteuid())
	if err != nil {
		return err
	}
	defer base.Close()
	dir, err := openDirectoryAt(base, "claude", false, policy.UID)
	if err != nil {
		return err
	}
	defer dir.Close()
	link := make([]byte, 64)
	n, err := unix.Readlinkat(int(dir.Fd()), ".credentials.json", link)
	if err != nil || string(link[:n]) != "credentials.json" {
		return ErrInvalidAuthority
	}
	return nil
}

func publishCredentialProjection(root, vm string, fence Fence, policy DockerLaunchPolicy, data []byte) error {
	parent, err := incarnationParent(root, vm, false)
	if err != nil {
		return err
	}
	defer parent.Close()
	base, err := openDirectoryAt(parent, fence.Incarnation, false, os.Geteuid())
	if err != nil {
		return err
	}
	defer base.Close()
	dir, err := openDirectoryAt(base, "claude", false, policy.UID)
	if err != nil {
		return err
	}
	defer dir.Close()
	if _, err = readInitialFile(dir, "credentials.json", policy.UID, initialPublishMax); err != nil {
		return err
	}
	id, err := randomAuthorityID()
	if err != nil {
		return err
	}
	name := ".node-credential-" + id
	if err = writeInitialFile(dir, name, data, policy.UID, policy.GID, 0o400); err != nil {
		return err
	}
	defer unix.Unlinkat(int(dir.Fd()), name, 0)
	if err = unix.Renameat(int(dir.Fd()), name, int(dir.Fd()), "credentials.json"); err != nil {
		return err
	}
	return dir.Sync()
}
