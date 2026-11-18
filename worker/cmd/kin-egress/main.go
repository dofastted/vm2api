package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/dofastted/kin-gateway/worker/internal/egress"
)

func main() {
	configPath := flag.String("config", "", "path to egress JSON config")
	proxyURL := flag.String("socks", "", "socks5h URL (overrides config)")
	listenTCP := flag.String("listen", "", "tcp redirect listen addr")
	listenDNS := flag.String("dns", "", "udp dns listen addr")
	proxyID := flag.String("proxy-id", "", "proxy id for logs")
	flag.Parse()

	cfg, err := loadConfig(*configPath, *proxyURL, *listenTCP, *listenDNS, *proxyID)
	if err != nil {
		log.Fatalf("%v", err)
	}
	srv, err := egress.New(cfg)
	if err != nil {
		log.Fatalf("kin-egress: %v", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if *configPath != "" {
		// SIGHUP re-reads the config: proxy, DNS and policy change without
		// cutting established connections. Flags still override the file.
		hup := make(chan os.Signal, 1)
		signal.Notify(hup, syscall.SIGHUP)
		go func() {
			for range hup {
				next, err := loadConfig(*configPath, *proxyURL, *listenTCP, *listenDNS, *proxyID)
				if err == nil {
					err = srv.Reload(next)
				}
				if err != nil {
					log.Printf("kin-egress reload rejected, keeping current config: %v", err)
				}
			}
		}()
	}
	if err = srv.Serve(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "kin-egress serve: %v\n", err)
		os.Exit(1)
	}
}

func loadConfig(configPath, proxyURL, listenTCP, listenDNS, proxyID string) (egress.Config, error) {
	cfg := egress.Config{ProxyID: proxyID, ProxyURL: proxyURL, ListenTCP: listenTCP, ListenDNS: listenDNS}
	if configPath == "" {
		return cfg, nil
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		return cfg, fmt.Errorf("read egress config: %w", err)
	}
	if err = json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("decode egress config: %w", err)
	}
	if proxyURL != "" {
		cfg.ProxyURL = proxyURL
	}
	if listenTCP != "" {
		cfg.ListenTCP = listenTCP
	}
	if listenDNS != "" {
		cfg.ListenDNS = listenDNS
	}
	if proxyID != "" {
		cfg.ProxyID = proxyID
	}
	return cfg, nil
}
