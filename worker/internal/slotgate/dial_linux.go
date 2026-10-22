//go:build linux

package slotgate

import (
	"context"
	"fmt"
	"net"
	"syscall"
)

// oPath is O_PATH on every Linux arch Go supports; package syscall does not export it.
const oPath = 0x200000

// dialSlotSocket never follows a planted symlink: the guest can create entries
// in run/, so the final component is opened O_PATH|O_NOFOLLOW, checked to be a
// socket, and connected through its /proc fd with no second path lookup.
func dialSlotSocket(path string) (net.Conn, error) {
	return dialSlotSocketContext(context.Background(), path)
}

func dialSlotSocketContext(ctx context.Context, path string) (net.Conn, error) {
	fd, err := syscall.Open(path, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer syscall.Close(fd)
	var st syscall.Stat_t
	if err = syscall.Fstat(fd, &st); err != nil {
		return nil, err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFSOCK {
		return nil, fmt.Errorf("%s is not a socket", path)
	}
	return (&net.Dialer{}).DialContext(ctx, "unix", fmt.Sprintf("/proc/self/fd/%d", fd))
}
