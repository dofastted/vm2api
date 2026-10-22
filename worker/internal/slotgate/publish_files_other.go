//go:build !linux

package slotgate

type initialFileTree struct{}

func stageInitialFiles(string, ManagementIntent, DockerLaunchPolicy, []byte, []byte, []byte, func(string) error) (*initialFileTree, error) {
	return nil, errPublishUnsupported
}
func (*initialFileTree) Publish(initialManifest, func(string) error) error {
	return errPublishUnsupported
}
func (*initialFileTree) Close() {}
func readPublishedInitial(string, string, Fence, DockerLaunchPolicy, initialManifest, bool) (string, error) {
	return "", errPublishUnsupported
}

func readPublishedCredential(string, string, Fence, DockerLaunchPolicy) ([]byte, error) {
	return nil, errPublishUnsupported
}
