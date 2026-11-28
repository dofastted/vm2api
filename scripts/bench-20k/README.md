# Phase 0 — 20K RPM × 100K-Context Replay Benchmark Suite

End-to-end reproducible benchmark harness for measuring `vm2api` control-plane overhead, PostgreSQL 18 + Redis 8 I/O saturation, concurrent panel read/write contention, and closed-loop zero-loss/zero-drift data integrity.

## Components

| Script | Responsibility |
| --- | --- |
| `build-corpus.py` | Compiles byte-length-preserving redacted 100K-token (`350–450 KB/req`) multi-turn Anthropic request corpus (`corpus-100k.jsonl` + `manifest.json`). |
| `docker-compose.bench.yml` | Isolated PostgreSQL 18 (`127.0.0.1:55432`) + Redis 8 (`127.0.0.1:56379`) under project `vm2api-bench`. |
| `mock-upstream.mjs` | Multi-worker Anthropic SSE mock upstream with configurable TTFT, stream latency, fault injection, `x-mock-upstream-ms` / `x-mock-ttft-ms` headers, and `/__stats`. |
| `sut-probe-preload.mjs` | Zero-invasive `NODE_OPTIONS=--import` preload exposing `/metrics` (`eventLoopDelayMs`, `atomicsWait`, `memory`, `cpuUsage`) and `POST /reset`. |
| `bootstrap-sut.mjs` | Initializes isolated PG/Redis + mock upstream + 1..N SUT instances and writes `session.json`. |
| `load-runner.mjs` | True open-loop constant-rate proxy load generator (pre-encoded `Buffer` replay, optional `worker_threads`, overhead stripping) + concurrent admin/tenant panel read/write pollers. |
| `metrics-collector.mjs` | O(1) PG 18 catalog sampler, Redis 8 `INFO` + `commandstats` parser, SUT probe & `PgLogWriter` sampler, and `diffSnapshots()`. |
| `verify-closed-loop.mjs` | Post-drain zero-loss & zero-drift verifier for PG `usage_logs`, `api_keys` billing reconciliation, `PgLogWriter` counters, and Redis evictions / `vm2api:live:inflight` orphans. |
| `run-phase0.mjs` | One-click stepped RPM sweep orchestrator with automatic knee detection, bottleneck attribution, and Markdown + JSON baseline report generation. |

## Quickstart

### 1. Build 100K-Context Redacted Corpus

```bash
python3 scripts/bench-20k/build-corpus.py \
  --out-dir .local/bench-20k/corpus \
  --verify-redaction
```

### 2. Start Isolated PG 18 + Redis 8 Topology

```bash
docker compose -p vm2api-bench -f scripts/bench-20k/docker-compose.bench.yml up -d
```

### 3. Run Stepped Phase 0 Baseline Sweep

```bash
# Baseline (origin/dev)
node scripts/bench-20k/run-phase0.mjs \
  --label baseline-dev \
  --sut-dir /mnt/x/vm2api \
  --instances 1 \
  --corpus .local/bench-20k/corpus/corpus-100k.jsonl \
  --steps 600,1500,3000,6000,10000,20000 \
  --step-sec 20 \
  --panel-pollers 20 \
  --workers 4 \
  --out-report .local/bench-20k/reports/baseline-dev.md

# Optimized branch (feat/redis-pg-io-optimization)
node scripts/bench-20k/run-phase0.mjs \
  --label opt-redis-pg \
  --sut-dir /mnt/x/vm2api-wt-redis-pg-opt \
  --instances 1 \
  --corpus .local/bench-20k/corpus/corpus-100k.jsonl \
  --steps 600,1500,3000,6000,10000,20000 \
  --step-sec 20 \
  --panel-pollers 20 \
  --workers 4 \
  --out-report .local/bench-20k/reports/opt-redis-pg.md
```

Each `--out-report <path>.md` writes both `<path>.md` (human-readable baseline tables + bottleneck attribution) and `<path>.json` (full structured telemetry).

### 4. Tear Down Bench Containers

```bash
docker compose -p vm2api-bench -f scripts/bench-20k/docker-compose.bench.yml down -v
```

## Standalone Tool Usage

### Open-Loop Load Runner (`load-runner.mjs`)

```bash
node scripts/bench-20k/load-runner.mjs \
  --session .local/bench-20k/session.json \
  --corpus .local/bench-20k/corpus/corpus-100k.jsonl \
  --target-rpm 6000 \
  --duration-sec 20 \
  --max-inflight 12000 \
  --workers 4 \
  --routing sticky \
  --panel-pollers 20 \
  --out .local/bench-20k/step-6000.json
```

### Telemetry Snapshot (`metrics-collector.mjs`)

```bash
node scripts/bench-20k/metrics-collector.mjs --session .local/bench-20k/session.json --reset-probes
node scripts/bench-20k/metrics-collector.mjs --session .local/bench-20k/session.json --out .local/bench-20k/snap.json
```

### Closed-Loop Integrity Verifier (`verify-closed-loop.mjs`)

```bash
node scripts/bench-20k/verify-closed-loop.mjs \
  --session .local/bench-20k/session.json \
  --expected-completed 2000 \
  --drain-timeout-ms 15000 \
  --out .local/bench-20k/closed-loop.json
```

Exits with code `0` when all assertions pass (`usage_logs` 0 loss, `api_keys` 0 billing drift, `PgLogWriter` 0 drops/errors/overflow/fallbacks, Redis 0 evictions & 0 `vm2api:live:inflight` orphans) and code `2` on any discrepancy.

## Unit Tests (Zero Docker Required)

```bash
node --test test/unit/bench-20k.test.mjs
npx biome check scripts/bench-20k/*.mjs test/unit/bench-20k.test.mjs
```
