package slotgate

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func nodeBootID() (string, error) {
	data, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(string(data))
	if !validAuthorityID(id) {
		return "", ErrInvalidAuthority
	}
	return id, nil
}

// newDockerVerifier speaks only to a configured, trusted local Engine socket.
// The old identity must already have been recorded by a trusted node launcher.
// A daemon ID mismatch, malformed response or denied request is not absence.
func newDockerVerifier(socket, boot string) (TerminationVerifier, error) {
	if !filepath.IsAbs(socket) || !validAuthorityID(boot) {
		return nil, ErrInvalidAuthority
	}
	transport := &http.Transport{DisableKeepAlives: true, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	client := &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	call := func(ctx context.Context, method, path string, out any, allowed ...int) (int, error) {
		req, err := http.NewRequestWithContext(ctx, method, "http://docker"+path, nil)
		if err != nil {
			return 0, err
		}
		res, err := client.Do(req)
		if err != nil {
			return 0, err
		}
		defer res.Body.Close()
		ok := false
		for _, status := range allowed {
			if res.StatusCode == status {
				ok = true
			}
		}
		if !ok {
			return res.StatusCode, fmt.Errorf("docker_status_%d", res.StatusCode)
		}
		data, err := io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
		if err != nil {
			return res.StatusCode, err
		}
		if len(data) > 1<<20 {
			return res.StatusCode, ErrInvalidAuthority
		}
		if out != nil && res.StatusCode == 200 {
			if err = json.Unmarshal(data, out); err != nil {
				return res.StatusCode, err
			}
		}
		return res.StatusCode, nil
	}
	type inspectState struct {
		ID    string `json:"Id"`
		State *struct {
			Running    *bool  `json:"Running"`
			Restarting *bool  `json:"Restarting"`
			StartedAt  string `json:"StartedAt"`
		} `json:"State"`
	}
	return func(ctx context.Context, expected ExecutorIdentity) (TerminationProof, error) {
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if err := validateExecutor(expected); err != nil {
			return TerminationProof{}, err
		}
		if expected.Kind != "container" || expected.NodeBootID != boot || !validAuthorityID(expected.DockerDaemonID) {
			return TerminationProof{}, ErrTerminationProof
		}
		var daemon struct {
			ID string `json:"ID"`
		}
		if _, err := call(ctx, "GET", "/info", &daemon, 200); err != nil {
			return TerminationProof{}, err
		}
		if daemon.ID != expected.DockerDaemonID {
			return TerminationProof{}, ErrTerminationProof
		}
		path := "/containers/" + expected.ContainerID
		var info inspectState
		status, err := call(ctx, "GET", path+"/json", &info, 200, 404)
		if err != nil {
			return TerminationProof{}, err
		}
		if status == 200 {
			if info.ID != expected.ContainerID || info.State == nil || info.State.Running == nil || info.State.Restarting == nil || info.State.StartedAt != expected.StartedAt {
				return TerminationProof{}, ErrTerminationProof
			}
			if *info.State.Running || *info.State.Restarting {
				if _, err = call(ctx, "POST", path+"/stop?t=10", nil, 204, 304); err != nil {
					return TerminationProof{}, err
				}
			}
			// Removal prevents the revoked incarnation being restarted by name or
			// automatic restart policy. Persistent bind-mounted slot data is kept.
			if _, err = call(ctx, "DELETE", path+"?force=1", nil, 204, 404); err != nil {
				return TerminationProof{}, err
			}
			var remaining inspectState
			status, err = call(ctx, "GET", path+"/json", &remaining, 200, 404)
			if err != nil || status != 404 {
				if err == nil {
					err = ErrTerminationProof
				}
				return TerminationProof{}, err
			}
		}
		// Recheck the trusted daemon after the absence observation as well.
		daemon.ID = ""
		if _, err = call(ctx, "GET", "/info", &daemon, 200); err != nil {
			return TerminationProof{}, err
		}
		if daemon.ID != expected.DockerDaemonID {
			return TerminationProof{}, ErrTerminationProof
		}
		id, err := randomAuthorityID()
		if err != nil {
			return TerminationProof{}, err
		}
		return TerminationProof{ID: id, Executor: expected, Scope: "container_removed", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}, nil
	}, nil
}
