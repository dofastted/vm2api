// Package slotgate is the node side of the cluster direct link: one TLS
// listener that the control plane dials once per request instead of opening a
// channel on its long-lived SSH link. Each connection names a slot and one of
// its two sockets; the gate splices it to <root>/vms/<vm>/run/<kind>.sock and
// nothing else. The certificate is self-signed on first start; the control
// plane pins its fingerprint after reading it over SSH.
package slotgate

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Listen string `json:"listen"`
	Root   string `json:"root"`
	Token  string `json:"token"`
	// TLSDir holds key.pem / cert.pem, created on first start.
	TLSDir string `json:"tls_dir"`
	// Experimental node fencing. Raw SSH/Docker/SFTP permissions and controller
	// admission wiring must be migrated before this can be enabled for HA.
	Fenced       bool                `json:"fenced,omitempty"`
	AuthorityDir string              `json:"authority_dir,omitempty"`
	DockerSocket string              `json:"docker_socket,omitempty"`
	Launch       *DockerLaunchPolicy `json:"launch,omitempty"`
	Management   *PGManagementConfig `json:"management,omitempty"`
}

// Preface: "KSG1 <token> <vm> <kernel|worker|ping>\n"; reply "OK\n" or "ERR <code>\n".
const (
	Magic          = "KSG1"
	prefaceMax     = 512
	prefaceTimeout = 5 * time.Second
	keepAlive      = 30 * time.Second
	MaxConns       = 512
)

var (
	vmIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	kinds  = map[string]string{"kernel": "kernel.sock", "worker": "worker.sock"}
)

type Server struct {
	refresher        *nodeCredentialRefresher
	cfg              Config
	token            [sha256.Size]byte
	tls              *tls.Config
	slots            chan struct{}
	wg               sync.WaitGroup
	authority        *Authority
	launcher         *dockerLauncher
	allocator        *allocationManager
	publisher        *initialPublisher
	authorizeCommand CommandAuthorizer
	managementNodeID string
	nodeBootID       string
	// Internal injection for trusted adapters/tests. Config alone never grants
	// unimplemented network mutations to a holder of the forwarding token.
	authorizeManagement func(context.Context, gate2Request, func() error) error
}

func New(cfg Config) (*Server, error) {
	if !cfg.Fenced && (cfg.Management != nil || cfg.AuthorityDir != "") {
		return nil, ErrManagementDenied
	}
	if strings.TrimSpace(cfg.Listen) == "" {
		return nil, errors.New("listen required")
	}
	if !filepath.IsAbs(cfg.Root) {
		return nil, errors.New("root must be absolute")
	}
	if len(cfg.Token) < 32 || strings.ContainsAny(cfg.Token, " \t\r\n") {
		return nil, errors.New("token must be at least 32 non-space characters")
	}
	if !filepath.IsAbs(cfg.TLSDir) {
		return nil, errors.New("tls_dir must be absolute")
	}
	cert, err := loadOrCreateCert(cfg.TLSDir)
	if err != nil {
		return nil, fmt.Errorf("tls: %w", err)
	}
	srv := &Server{
		cfg:   cfg,
		token: sha256.Sum256([]byte(cfg.Token)),
		tls:   &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13},
		slots: make(chan struct{}, MaxConns),
	}
	if cfg.Fenced {
		inside, err := filepath.Rel(filepath.Join(cfg.Root, "vms"), cfg.AuthorityDir)
		if err != nil || inside == "." || (inside != ".." && !strings.HasPrefix(inside, ".."+string(filepath.Separator))) {
			return nil, errors.New("authority_dir must be outside slot mounts")
		}
		boot, err := nodeBootID()
		if err != nil {
			return nil, err
		}
		srv.nodeBootID = boot
		socket := cfg.DockerSocket
		if socket == "" {
			socket = "/var/run/docker.sock"
		}
		verify, err := newDockerVerifier(socket, boot)
		if err != nil {
			return nil, err
		}
		srv.authority, err = OpenAuthority(cfg.AuthorityDir, verify)
		if err != nil {
			return nil, err
		}
		if err = srv.authority.bindManagement(cfg.Management); err != nil {
			srv.authority.Close()
			return nil, err
		}
		if cfg.Launch != nil {
			srv.launcher, err = newDockerLauncher(socket, cfg.Root, boot, srv.authority, *cfg.Launch)
			if err != nil {
				srv.authority.Close()
				return nil, err
			}
			srv.publisher = &initialPublisher{authority: srv.authority, root: cfg.Root, policy: *cfg.Launch}
		}
		if cfg.Management != nil {
			authorizer, authErr := newPGAllocationAuthorizer(*cfg.Management)
			if authErr != nil {
				srv.authority.Close()
				return nil, authErr
			}
			srv.allocator = &allocationManager{authority: srv.authority, nodeID: cfg.Management.NodeID, authorize: authorizer.Authorize}
			srv.managementNodeID = cfg.Management.NodeID
			srv.authorizeCommand = authorizer.AuthorizeCommand
			if srv.launcher != nil {
				srv.refresher = &nodeCredentialRefresher{boot: boot, authority: srv.authority, root: cfg.Root, nodeID: cfg.Management.NodeID, policy: *cfg.Launch, authorize: authorizer.AuthorizeRefresh}
			}
		}
	}
	return srv, nil
}

// TLSConfig is the server side config, for callers that bring their own listener.
func (s *Server) TLSConfig() *tls.Config { return s.tls }

func (s *Server) Serve(ctx context.Context) error {
	lc := net.ListenConfig{KeepAlive: keepAlive}
	ln, err := lc.Listen(ctx, "tcp", s.cfg.Listen)
	if err != nil {
		if s.authority != nil {
			s.authority.Close()
		}
		return err
	}
	return s.ServeListener(ctx, tls.NewListener(ln, s.tls))
}

func (s *Server) ServeListener(ctx context.Context, ln net.Listener) error {
	stop := context.AfterFunc(ctx, func() { ln.Close() })
	defer stop()
	if s.authority != nil {
		defer s.authority.Close()
	}
	defer s.wg.Wait()
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			return err
		}
		select {
		case s.slots <- struct{}{}:
		default:
			conn.Close()
			continue
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer func() { <-s.slots }()
			if s.cfg.Fenced {
				stopConn := context.AfterFunc(ctx, func() { conn.Close() })
				defer stopConn()
			}
			s.handle(ctx, conn)
		}()
	}
}

// handle runs the TLS handshake and preface under one deadline, so a client
// that stalls in either is dropped after prefaceTimeout.
func (s *Server) handle(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(prefaceTimeout))
	br := bufio.NewReaderSize(conn, prefaceMax)
	line, err := br.ReadSlice('\n')
	if err != nil {
		return
	}
	if s.cfg.Fenced {
		s.handleFenced(ctx, conn, br, string(line))
		return
	}
	vm, kind, code := s.parse(string(line))
	if code != "" {
		fmt.Fprintf(conn, "ERR %s\n", code)
		return
	}
	if kind == "ping" {
		io.WriteString(conn, "OK\n")
		return
	}
	target, err := dialSlotSocket(filepath.Join(s.cfg.Root, "vms", vm, "run", kinds[kind]))
	if err != nil {
		fmt.Fprintf(conn, "ERR no_socket\n")
		return
	}
	defer target.Close()
	if _, err = io.WriteString(conn, "OK\n"); err != nil {
		return
	}
	conn.SetDeadline(time.Time{})
	splice(conn, br, target)
}

func (s *Server) parse(line string) (vm, kind, code string) {
	f := strings.Fields(line)
	if len(f) != 4 || f[0] != Magic {
		return "", "", "bad_request"
	}
	sum := sha256.Sum256([]byte(f[1]))
	if subtle.ConstantTimeCompare(sum[:], s.token[:]) != 1 {
		return "", "", "auth"
	}
	kind = f[3]
	if kind == "ping" {
		return "", kind, ""
	}
	if _, ok := kinds[kind]; !ok || !vmIDRe.MatchString(f[2]) {
		return "", "", "bad_request"
	}
	return f[2], kind, ""
}

type closeWriter interface{ CloseWrite() error }

// splice copies both ways and forwards each half-close, so a client that
// finishes sending still receives the rest of a streamed reply. An error on
// either side (reset, dead peer found by keepalive) tears down both.
func splice(client net.Conn, clientReader io.Reader, target net.Conn) {
	done := make(chan struct{}, 2)
	pipe := func(dst net.Conn, src io.Reader) {
		defer func() { done <- struct{}{} }()
		if _, err := io.Copy(dst, src); err != nil {
			if !errors.Is(err, net.ErrClosed) {
				log.Printf("slotgate splice: %v", err)
			}
			client.Close()
			target.Close()
			return
		}
		if cw, ok := dst.(closeWriter); ok {
			cw.CloseWrite()
		} else {
			dst.Close()
		}
	}
	go pipe(target, clientReader)
	go pipe(client, target)
	<-done
	<-done
}
