//go:build !linux

package slotgate

func writeInitialNodeCredential(string, string, Fence, []byte) error { return errPublishUnsupported }
func readNodeCredential(string, string, Fence) ([]byte, error)       { return nil, errPublishUnsupported }
func checkCredentialLink(string, string, Fence, DockerLaunchPolicy) error {
	return errPublishUnsupported
}

func publishCredentialProjection(string, string, Fence, DockerLaunchPolicy, []byte) error {
	return errPublishUnsupported
}
