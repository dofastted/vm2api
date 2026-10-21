//go:build linux || darwin

package slotgate

import (
	"errors"
	"os"
	"syscall"
)

func openAuthorityFile(path string, flags int, mode os.FileMode) (*os.File, error) {
	fd, err := syscall.Open(path, flags|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, uint32(mode.Perm()))
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 {
		file.Close()
		if err != nil {
			return nil, err
		}
		return nil, ErrInvalidAuthority
	}
	return file, nil
}

func lockAuthority(path string) (*os.File, error) {
	file, err := openAuthorityFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, ErrAuthorityLocked
		}
		return nil, err
	}
	return file, nil
}
