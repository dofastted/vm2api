# vm2api Local Protocol Standard Baseline

Offline, zero-upstream regression baseline for the 4 inbound protocols (`anthropic.messages`, `openai.chat` / `openai.completions`, `openai.responses`, `google.gemini`) across all `vm2api` targets (`claude_crag`, `gemini_craggemini`, `codex_kernel`, and external `api_*` endpoints).

Modeled on the standalone CRAG `replay-standards.py` harness:
- **100% local loopback mocks**: never dials Anthropic, OpenAI, Google, or production `vm2api`.
- **Isolated temp state**: never reads or modifies `vms/`, `data/kin.db`, or device licenses.
- **Zero secret persistence**: automatic redaction of API keys, OAuth tokens, cookies, and real emails.
- **Two-layer verification**:
  - **L1 (`replay-baseline.mjs`)**: full ≥110-case matrix verifying exact handoff envelope `E`, stripped inbound fingerprints, Web Settings passthrough gate (`WebSetting == ON && official_body`), and exact client-side JSON/SSE round-trip in the original inbound protocol.
  - **L2 (`replay-l2-crag.py`)**: feeds captured CRAG envelopes into a fixture-licensed local `crag-v2` + official Linux x64 Claude Code `2.1.321` + loopback TLS `api.anthropic.com:443` mock to assert `W_go == W_node`.

## Commands (run inside WSL2 Linux from worktree root)

```bash
# 1. Generate the standard >=110-case sanitized corpus
node scripts/protocol-baseline/generate-corpus.mjs

# 2. Freeze golden baseline on unmodified Node engine
KIN_PROTO_FRONT=node node scripts/protocol-baseline/replay-baseline.mjs \
  --record scripts/protocol-baseline/golden/node-dev-v0.json

# 3. Verify Go front-end parity + improvement contracts against frozen golden
KIN_PROTO_FRONT=go node scripts/protocol-baseline/replay-baseline.mjs \
  --verify scripts/protocol-baseline/golden/node-dev-v0.json

# 4. Run 5-dimension pure front-end benchmark (Node vs Go)
node scripts/protocol-baseline/replay-baseline.mjs --bench

# 5. Record fresh real local client traffic (automatically sanitized)
node scripts/protocol-baseline/capture-local.mjs \
  --listen 127.0.0.1:18787 --target http://127.0.0.1:8787 \
  --out scripts/protocol-baseline/corpus/local-captured.json

# 6. Optional L2 real CRAG + CC wire parity (Linux + fixture package/license/CC ELF)
python3 scripts/protocol-baseline/replay-l2-crag.py \
  --node-golden scripts/protocol-baseline/golden/node-dev-v0.json \
  --go-golden scripts/protocol-baseline/golden/go-candidate.json \
  --claude "$CC_ELF" --package "$FIXTURE/package" --license "$FIXTURE/license"
```
