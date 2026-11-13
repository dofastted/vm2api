package main

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"log"
	"net/http"
	"os"

	"github.com/dofastted/kin-gateway/redact/internal/server"
)

func main() {
	sock := flag.String("sock", "", "unix socket path")
	keyPath := flag.String("key", "", "32-byte deployment key file")
	capPath := flag.String("capability", "", "file that receives the process capability")
	flag.Parse()
	if *sock == "" || *keyPath == "" || *capPath == "" {
		log.Fatal("kin-redact: -sock, -key and -capability are required")
	}
	key, err := server.LoadOrCreateKey(*keyPath)
	if err != nil {
		log.Fatal(err)
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		log.Fatal(err)
	}
	capability := hex.EncodeToString(buf)
	if err := os.WriteFile(*capPath, []byte(capability), 0o600); err != nil {
		log.Fatal(err)
	}
	ln, err := server.ListenUnix(*sock)
	if err != nil {
		log.Fatal(err)
	}
	srv := server.New(capability, key)
	if err := http.Serve(ln, srv.Handler()); err != nil {
		log.Fatal(err)
	}
}
