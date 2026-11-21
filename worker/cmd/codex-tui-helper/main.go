// codex-tui-helper is the per-slot helper that drives a real `codex` TUI process
// behind a PTY and serves the /internal/v1/codex/* unix-socket contract.
//
// Usage: codex-tui-helper --config /path/to/run/codex-kernel.json
package main

import (
	"flag"
	"log"

	"github.com/dofastted/kin-gateway/worker/internal/codextui"
)

func main() {
	configPath := flag.String("config", "", "path to codex-kernel.json")
	flag.Parse()
	// The control-plane supervisor spawns kernels as `<bin> <config-path>`.
	if *configPath == "" && flag.NArg() > 0 {
		*configPath = flag.Arg(0)
	}
	if *configPath == "" {
		log.Fatal("--config required")
	}
	cfg, err := codextui.LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	log.Printf("codex-tui-helper: vm=%s socket=%s home=%s parallel=%d bin=%s",
		cfg.VMID, cfg.SocketPath, cfg.CodexHome, cfg.MaxParallel, cfg.CodexBin)
	if err := codextui.NewServer(cfg).ListenAndServe(); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
