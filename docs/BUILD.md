# 版本与构建

源码和 linux amd64 `bin/kin-{kernel,egress,worker,codex-kernel}`、`share/wrap-cli` 进 git。GitHub Release 仍挂一份 ELF。当前发布线：**1.1.5**（tag `v1.1.5`）。

## 版本怎么记

| 记号 | 谁写 | 含义 |
|---|---|---|
| 仓库根 `VERSION` | 人改 | 对外 semver，和 tag 对齐 |
| git tag `v*` | 人打 | 触发 Release 工作流 |
| `package.json` `"version"` | 人改 | 和 `VERSION` 相同 |
| `VERSION.txt` artifact | `.github/workflows/version.yml` 在 main 推送后 | 当时 `GITHUB_SHA` 前 7 位，给人对照部署，**不会**写回 git |

发版当天三处一起改：`VERSION`、`package.json`、[CHANGELOG.md](../CHANGELOG.md)，再打 annotated tag。

## 打一个 Release

仓库要有 `contents: write`。流程在 `.github/workflows/release.yml`。

```bash
git tag -a v1.1.5 -m "vm2api v1.1.5"
git push origin v1.1.5
```

`v*` tag 推上去之后，Actions 在 `ubuntu-latest` 编 linux amd64，并挂到该 tag 的 Release：

| 文件 | 角色 |
|---|---|
| `kin-kernel` | Claude Code Rust 内核（推理必带） |
| `kin-egress` | 远程 SOCKS5 透明网关 |
| `kin-worker` | **只** `telemetry`，不是 hop |
| `kin-codex-kernel` | Codex 槽；仓内 `bin/` 已带 |

没有 tag、只点 workflow_dispatch 时，产物进 artifact，不会建 Release。

装到机器上（Compose 部署可跳过，仓内 `bin/` 已有同名文件）：

```bash
install -m 755 kin-kernel kin-egress kin-worker kin-codex-kernel /opt/vm2api/bin/
```

然后按 [DEPLOY.md](DEPLOY.md) 指环境变量。槽进程不是 root：权限必须是 `755`，不要 `700`。

控制面镜像：`docker compose build` 拷仓内 `bin/kin-*` 与 `share/wrap-cli`（见 [DEPLOY.md](DEPLOY.md#docker-compose)）。槽位 `kin-os/*` 首次启动编 ubuntu，或 `node docker/kin-os/build.mjs`。

## 本机构建

依赖：Node 22、Rust stable、Go 1.25、pnpm 10、python3 + `curl_cffi`（授权码换票）。Windows 上 Go/Rust 能编，槽位运行面按 Linux + Docker 写。

```bash
npm ci
pnpm -C web install --frozen-lockfile

npm run build:kernel      # bin/kin-kernel
npm run build:egress      # bin/kin-egress
npm run build:web         # web/dist
npm run build:worker      # bin/kin-worker（telemetry）
# 可选 npm run build:codex-kernel
```

格式：和 CI 同一套，全文 LF。说明见 [FORMAT.md](FORMAT.md)。

```bash
npm run format
npm run format:check
```

对应命令：

```bash
CGO_ENABLED=0 go build -trimpath -o bin/kin-egress ./worker/cmd/kin-egress
CGO_ENABLED=0 go build -trimpath -o bin/kin-worker ./worker/cmd/kin-worker
cargo build --release --manifest-path crates/kin-kernel/Cargo.toml
cp crates/kin-kernel/target/release/kin-kernel bin/kin-kernel
pnpm -C web build
```

`kin-worker` 不带参数会退出（hop 已删）。只要：

```bash
kin-worker telemetry --config /path/to/worker.json
```

## 验证

```bash
npm test                  # unit + worker Go（egress / proxy / config / telemetry）
npm run test:web          # 要先 pnpm -C web install
npm run test:kernel
node --check src/server.mjs
```

CI（`.github/workflows/test.yml`）在 push / PR 上跑：Node unit、Go、Rust kernel、web 测试和构建。

## 升级一台已部署的机

**Compose（推荐）**

```bash
cd /opt/vm2api
git pull
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

槽位容器不会被这次升级 `docker rm`。

**本机 Node + systemd**

1. `git pull` 或检出目标 tag。
2. `npm ci`；有 web 改动则 `pnpm -C web install --frozen-lockfile && npm run build:web`。
3. 换 Release 二进制或本地重编 `bin/`（`install -m 755`）。
4. `node --check src/server.mjs`。
5. `systemctl restart vm2api` **一次**。确认 `/health`。

静态 HTML / `web/dist` 单独更新不必重启。同一轮不要 restart 两次，不要 `stop` 后不拉起。


---

交流见仓库 [README](../README.md)。
