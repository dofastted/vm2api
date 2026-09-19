# 版本与构建

linux amd64 `bin/kin-{kernel,egress,worker,codex-kernel,cookie-auth}`、`share/wrap-cli` 进 git。kernel / wrap 只带预编译 ELF，不带过程源码。GitHub Release 仍挂一份 ELF。当前发布线：**1.2.5**（tag `v1.2.5`）。

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
git tag -a v1.2.5 -m "vm2api v1.2.5"
git push origin v1.2.5
```

`v*` tag 推上去之后，Actions 在 `ubuntu-latest` 编 Go linux amd64，并挂仓内预编译 kernel / wrap ELF 到该 tag 的 Release：

| 文件 | 角色 |
|---|---|
| `kin-kernel` | Claude Code 槽内核（仓内预编译，推理必带） |
| `kin-egress` | 远程 SOCKS5 透明网关 |
| `kin-worker` | **只** `telemetry`，不是 hop |
| `kin-codex-kernel` | Codex 槽；仓内 `bin/` 已带 |
| `kin-cookie-auth` | sessionKey / 授权码换票 helper；仓内预编译，控制面不带过程源码 |

没有 tag、只点 workflow_dispatch 时，产物进 artifact，不会建 Release。

装到机器上（Compose 部署可跳过，仓内 `bin/` 已有同名文件）：

```bash
install -m 755 kin-kernel kin-egress kin-worker kin-codex-kernel kin-cookie-auth /opt/vm2api/bin/
```

然后按 [DEPLOY.md](DEPLOY.md) 指环境变量。槽进程不是 root：权限必须是 `755`，不要 `700`。

控制面镜像：`docker compose build` 拷仓内 `bin/kin-*` 与 `share/wrap-cli`（见 [DEPLOY.md](DEPLOY.md#docker-compose)）。槽位 `kin-os/*` 首次启动编 ubuntu，或 `node docker/kin-os/build.mjs`。

## 本机构建

依赖：Node 22、Go 1.25、pnpm 10、python3（官方 CLI PTY 脚本）。换票走仓内 `bin/kin-cookie-auth`。kernel / wrap CLI 用仓内 ELF，不要在本机 cargo / 重编 Claude Code。

```bash
npm ci
pnpm -C web install --frozen-lockfile

npm run build:egress      # bin/kin-egress
npm run build:web         # web/dist
npm run build:worker      # bin/kin-worker（telemetry）
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
node --check src/server.mjs
```

CI（`.github/workflows/test.yml`）在 push / PR 上跑：Node unit、Go、预编译 kernel ELF 检查、web 测试和构建。

## 升级一台已部署的机

升 **v1.2.5**：更新控制面并 `wrap-cli/sync` 换槽内 CLI。步骤见 [DEPLOY.md · 已部署机升级到 1.2.5](DEPLOY.md#已部署机升级到-125)。

**Compose（其它版本通用）**

```bash
cd /opt/vm2api
git pull
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

槽位容器不会被这次升级 `docker rm`。1.2.5 要 `wrap-cli/sync`；1.2.4 相对 1.2.2 不必 kernel sync。

**本机 Node + systemd**

1. `git pull` 或检出目标 tag。
2. `npm ci`；有 web 改动则 `pnpm -C web install --frozen-lockfile && npm run build:web`。
3. 换仓内 `bin/` ELF（`install -m 755`）。1.2.5 再 `POST /api/panel/wrap-cli/sync`。
4. `node --check src/server.mjs`。
5. `systemctl restart vm2api` **一次**。确认 `/health`。

静态 HTML / `web/dist` 单独更新不必重启。同一轮不要 restart 两次，不要 `stop` 后不拉起。


---

交流见仓库 [README](../README.md)。
