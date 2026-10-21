// Local authorization interoperability fixture. No Docker call or executor is created.
package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/dofastted/kin-gateway/worker/internal/slotgate"
)

func check(err error) {
	if err != nil {
		panic(err)
	}
}
func main() {
	file, err := os.Open(os.Args[1])
	check(err)
	var config slotgate.Config
	check(json.NewDecoder(file).Decode(&config))
	check(file.Close())
	server, err := slotgate.New(config)
	check(err)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	check(err)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- server.ServeListener(ctx, tls.NewListener(listener, server.TLSConfig())) }()
	cert := sha256.Sum256(server.TLSConfig().Certificates[0].Certificate[0])
	check(json.NewEncoder(os.Stdout).Encode(map[string]any{"address": "127.0.0.1", "port": listener.Addr().(*net.TCPAddr).Port, "token": config.Token, "certSha256": hex.EncodeToString(cert[:])}))
	<-ctx.Done()
	check(<-done)
}
