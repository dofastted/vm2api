package slotgate

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"time"
)

type dockerEngine struct{ client *http.Client }

func newDockerEngine(socket string) (*dockerEngine, error) {
	if !filepath.IsAbs(socket) {
		return nil, ErrInvalidAuthority
	}
	transport := &http.Transport{DisableKeepAlives: true, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	return &dockerEngine{client: &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (e *dockerEngine) call(ctx context.Context, method, path string, body, out any, allowed ...int) (int, error) {
	var payload io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		payload = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://docker"+path, payload)
	if err != nil {
		return 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := e.client.Do(req)
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
	if out != nil && len(data) != 0 {
		if err = json.Unmarshal(data, out); err != nil {
			return res.StatusCode, err
		}
	}
	return res.StatusCode, nil
}
