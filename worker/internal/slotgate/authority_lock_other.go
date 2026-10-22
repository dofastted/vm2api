//go:build !linux && !darwin

package slotgate

import "os"

// A platform without the node authority's process lock must fail closed.
func openAuthorityFile(string, int, os.FileMode) (*os.File, error) {
	return nil, ErrAuthorityUnavailable
}
func lockAuthority(string) (*os.File, error) { return nil, ErrAuthorityUnavailable }
