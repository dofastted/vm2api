package main

import (
	"context"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/dofastted/kin-gateway/protofront/internal/server"
)

func main() {
	socket := flag.String("socket", "", "unix socket path")
	token := flag.String("token", "", "internal auth token")
	flag.Parse()
	if *socket == "" {
		log.Fatal("-socket is required")
	}
	if err := os.MkdirAll(filepath.Dir(*socket), 0o770); err != nil {
		log.Fatalf("socket dir: %v", err)
	}
	_ = os.Remove(*socket)
	ln, err := net.Listen("unix", *socket)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	_ = os.Chmod(*socket, 0o660)

	srv := &http.Server{
		Handler:           (&server.Server{Token: *token}).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if serveErr := srv.Serve(ln); serveErr != nil && serveErr != http.ErrServerClosed {
			log.Fatalf("serve: %v", serveErr)
		}
	}()

	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	<-ch
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	_ = os.Remove(*socket)
}
