---
name: hostdzire-version-switch
description: "Switch vm2api control-plane + console versions on HostDzire (kin.fkcodex.com). Use when deploying a new VERSION overlay, rolling back a HostDzire cutover, replacing the live frontend/backend, or the user says 切换版本 / 部署到 hostdzire / 切回上一版."
---

# HostDzire version switch

Fast path for **one HostDzire stack**: public `https://kin.fkcodex.com`, SSH alias `hostdzire` (`23.80.83.15`).

Live code stays at `/opt/kin-gateway`. Do **not** install Compose at `/opt/vm2api` — slot bind-mounts are `/opt/kin-gateway/vms/...`.

## When to load

- Deploy this repo's current `VERSION` over the live Node + `/var/www/kin-console`
- Roll back to a `.deploy-bak-vm2api-*` snapshot
- User asks to 切换 / 部署 / 切回 HostDzire 前后端

## Hard stops

- Never `docker rm` slot containers (`kin-*`).
- Never change `KIN_PROJECT_ROOT` / `WorkingDirectory` away from `/opt/kin-gateway`.
- Never overlay `src/config/routing.json`, `vms/`, `data/`, `.env`, or systemd unit secrets.
- Never echo `KIN_API_KEY` / admin password.
- Restart **`kin-gateway.service` once**. Leave `kin-gateway-go.service` (front door `:8787`, Node upstream `:8788`).
- Preserve `/var/www/kin-console/dl` → `/var/www/kin-console-dl`.
- SSH only via ssh-skill:

```
python3 ~/.codex/skills/ssh-skill/scripts/ssh_execute.py hostdzire "<cmd>"
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py hostdzire "<local>" "<remote>"
```

## Layout

| Piece | Live path |
|---|---|
| Node (strangler) | `127.0.0.1:8788` — `ExecStart=/usr/bin/node src/server.mjs` |
| Go front door | `:8787` — nginx `/api` `/v1` `/health` |
| Console | `/var/www/kin-console` (nginx `/`) |
| Wrap sample | `/opt/kin-gateway/share/wrap-cli` |
| Slots | `/opt/kin-gateway/vms/<id>/cli-home/.kin` |

## Forward (new VERSION)

1. Local: `pnpm -C web build`.
2. Pack overlay (repo root):

```
sh skills/hostdzire-version-switch/scripts/pack-overlay.sh
```

Writes `/tmp/vm2api-hostdzire-<VERSION>.tgz`. Includes `src/server.mjs`, `src/lib`, `src/config/distill-rules.json`, `bin/kin-{kernel,codex-kernel,cookie-auth,egress,worker}`, `share/wrap-cli` (no `cli-dist`/`bun`), `web/dist`, `VERSION`. Excludes routing/data/vms.

3. Upload:

```
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py hostdzire \
  "/tmp/vm2api-hostdzire-<VERSION>.tgz" "/tmp/vm2api-hostdzire-<VERSION>.tgz"
```

4. Remote apply (backs up first):

```
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py hostdzire \
  "skills/hostdzire-version-switch/scripts/remote-apply.sh" "/tmp/vm2api-remote-apply.sh"
python3 ~/.codex/skills/ssh-skill/scripts/ssh_execute.py hostdzire --timeout 180 \
  "sh /tmp/vm2api-remote-apply.sh <VERSION>"
```

Creates `/opt/kin-gateway/.deploy-bak-vm2api-<VERSION>-<UTC>/` then overlays bins via `tmp+mv`, swaps console with `--exclude dl`, restarts Node **once**.

5. `POST /api/panel/wrap-cli/sync` `{"restart":true}` using systemd `KIN_API_KEY` **without printing it**. Expect `ok_count` = listed VMs.
6. If the new wrap is compiled `cli-node` ELF, delete leftover slot `cli-dist/` and `bun` under each `vms/*/cli-home/.kin`.
7. Verify (all required):
   - Node health `service` is `vm2api` (or the new name)
   - `https://kin.fkcodex.com/` has `<title>vm2api</title>` and `id="root"`
   - `POST /api/panel/login` then `GET /api/panel/vms` lists slots
   - Tiny `POST /v1/messages` (haiku, 32 tokens) returns assistant text
   - `docker ps` still shows `kin-*` **Up** (not created from scratch)

## Rollback

Need a bak dir, default latest `.deploy-bak-vm2api-*`:

```
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py hostdzire \
  "skills/hostdzire-version-switch/scripts/remote-rollback.sh" "/tmp/vm2api-remote-rollback.sh"
python3 ~/.codex/skills/ssh-skill/scripts/ssh_execute.py hostdzire --timeout 180 \
  "sh /tmp/vm2api-remote-rollback.sh [BAK_DIR]"
```

Restores `server.mjs`, `src/lib`, `distill-rules.json`, bins, `share/wrap-cli`, `/var/www/kin-console` (keeps `dl`). Restarts Node once. Then wrap-cli/sync as in step 5.

Verified bak from the 1.2.5 cutover: `/opt/kin-gateway/.deploy-bak-vm2api-1.2.5-20260919T191637Z` (pre-overlay Node + bun/cli-dist wrap + previous console). Old Node health `service` is `kin-gateway-v2.1`.

## After either direction

- Do not restart `kin-gateway` a second time in the same cutover.
- Do not `systemctl stop` without start.
- Telegram wrap-up: `python3 /home/mci777/.omp/agent/hooks/tg_notify.py --task "..."`.
