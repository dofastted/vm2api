# 版本与构建

git 里只有源码。`bin/`、`web/dist`、`share/crag` 与 `share/wrap-cli` 里的 ELF / glibc 都不进 git：

- `web/dist` 与 `kin-api-kernel` 由源码编译（镜像构建内或本机）。
- 生产验证过的 linux amd64 产物（`kin-kernel`、`kin-codex-kernel`、`kin-oauth-auth`、`kin-computer`、`kin-worker`、`kin-egress`、`kin-slot-gate`、`cli-node`、`cc-node`、crag kernel、glibc 2.39 shim）放在独立的 payload Release，由 [`deploy/payload.json`](../deploy/payload.json) 按 sha256 / 大小钉住。`npm run fetch:payload` 下载并校验到 `bin/` / `share/`；镜像构建同样按清单下载，校验不过即失败。

换 payload：把新文件放到本机对应路径，然后

```bash
node scripts/fetch-payload.mjs --pin payload-YYYY.MM.DD     # 重算清单 sha256 / 大小并指向新 Release
node scripts/fetch-payload.mjs --stage /tmp/payload          # 按 asset 名导出
gh release create payload-YYYY.MM.DD /tmp/payload/* --prerelease --latest=false \
  --title "slot payload YYYY.MM.DD" --notes "Pinned by deploy/payload.json"
```

再提交 `deploy/payload.json`。payload Release 必须 `--prerelease --latest=false`：一键脚本与面板按 `releases/latest` 找应用版本。

## 版本怎么记

| 记号 | 谁写 | 含义 |
|---|---|---|
| 仓库根 `VERSION` | 人改 | 对外 semver，和 tag 对齐 |
| git tag `v*` | 人打 | 触发 Release 工作流 |
| Actions run 的 commit SHA | GitHub | 对照源码与构建；不再单独上传 `VERSION.txt` |

`VERSION` 是唯一应用版本来源；`package.json` / lockfile 不再重复记录版本。发版当天改 `VERSION` 和 [CHANGELOG.md](../CHANGELOG.md)，再打 annotated tag。`Dockerfile` 把这两个文件拷进控制面镜像，面板才能读当前版本。一键脚本 `deploy/install.sh` 按 GitHub Release tag 升级，不改版本文件。

## 打一个 Release

仓库要有 `contents: write`。流程在 `.github/workflows/release.yml`。

```bash
git tag -a v1.2.22 -m "vm2api v1.2.22"
git push origin v1.2.22
```

`v*` tag 推上去之后，Actions 按 `deploy/payload.json` 拉 payload（含 Go helper，不再从源码编译），并把这些 ELF 挂到该 tag 的 Release（面板按版本 Release 的同名附件下载 kernel / CLI）：

| 文件 | 角色 |
|---|---|
| `kin-kernel` | Claude Code 槽内核（payload，推理必带） |
| `kin-egress` | 远程 SOCKS5 透明网关 |
| `kin-slot-gate` | 扩展节点直连通道入口（控制面每请求一条 TLS 连接直达节点槽位） |
| `kin-worker` | **只** `telemetry`，不是 hop |
| `kin-codex-kernel` | Codex 槽（payload） |
| `kin-oauth-auth` | OAuth / Setup Token 换票服务二进制；源码不随部署上传 |
| `kin-kernel-crag` / `cli-node` / `cc-node` | crag kernel 与槽内 wrap CLI（payload） |

没有 tag、只点 workflow_dispatch 时，产物进 artifact，不会建 Release。

控制面镜像（amd64 `Dockerfile` 与 `deploy/Dockerfile.arm64-control`）是多阶段构建：在镜像里编 `web/dist` 和 `kin-api-kernel`，amd64 的 Go helper 与 payload 按清单下载；ARM64 镜像的 Go helper 仍在镜像内从源码编译。artifact 保留 7 天，正式 Release assets 不受此期限影响。

槽位 OS 镜像由 `.github/workflows/guest-images.yml` 独立发布：main 上 `docker/kin-os/`、`docker/kin-kvm/` 或该 workflow 有变化时触发，也可手动运行。四种系统并行构建，各用独立缓存；普通应用发版不再重复构建槽位 OS / KVM runner 镜像。

KVM runner 镜像（`ghcr.io/dofastted/kin-kvm-{ubuntu,debian,arch,fedora}`）在同一 workflow 的 `kvm` job 构建：单 Dockerfile `docker/kin-kvm/` + `ARG CLOUD_IMAGE_URL`（官方 cloud image URL 见 `src/lib/vm/os-catalog.mjs` 的 `kvm.cloud_image`）。本机构建：

```bash
node docker/kin-kvm/build.mjs ubuntu          # 与 kin-os 同语义：--force / --pull / --pull-only / 过滤器
```

装到机器上（Compose 部署可跳过，镜像入口会把镜像内的同名文件写进挂载的 `bin/`）：

```bash
install -m 755 kin-kernel kin-egress kin-worker kin-codex-kernel kin-oauth-auth /opt/vm2api/bin/
```

然后按 [DEPLOY.md](DEPLOY.md) 指环境变量。槽进程不是 root：权限必须是 `755`，不要 `700`。

控制面镜像：`docker compose -f docker-compose.yml -f docker-compose.build.yml build` 在镜像内编控制台与 Go helper 并下载 payload，构建机需要能访问 GitHub Release（见 [DEPLOY.md](DEPLOY.md#docker-compose)）。槽位 `kin-os/*` 首次启动编 ubuntu，或 `node docker/kin-os/build.mjs`；KVM 槽编 `kin-kvm-*`，或 `node docker/kin-kvm/build.mjs`。

## 本机构建

依赖：Node 22、Go 1.25、pnpm 10、python3（官方 CLI PTY 脚本）。OAuth 换票由控制面 spawn `bin/kin-oauth-auth` 完成；`auth.js` 只保留在本地构建目录，不上传到控制面。kernel / wrap CLI 用 payload ELF，不要在本机 cargo / 重编 Claude Code。

```bash
npm ci
pnpm -C web install --frozen-lockfile

npm run fetch:payload     # bin/kin-{kernel,codex-kernel,oauth-auth,computer,worker,egress,slot-gate}、share/wrap-cli、share/crag
npm run build:web         # web/dist
```

格式：和 CI 同一套，全文 LF。说明见 [FORMAT.md](FORMAT.md)。

```bash
npm run format
npm run format:check
```

改 Go helper 时本机编译（会覆盖钉住的文件，`fetch:payload --check` 随之失败；要随版本发出，须按上文换 payload 重新钉）：

```bash
CGO_ENABLED=0 go build -trimpath -o bin/kin-egress ./worker/cmd/kin-egress
CGO_ENABLED=0 go build -trimpath -o bin/kin-slot-gate ./worker/cmd/kin-slot-gate
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

CI（`.github/workflows/test.yml`）在 main push / PR 上运行，也可手动触发，只有一个 job：Node 格式与语法、`worker/` / `api-kernel/` 的 gofmt；拉取并校验钉住的 payload；Node unit；Go vet 与 test；web 格式、测试与构建。基线是生产验证过的产物，CI 不做 ARM64、真链路 e2e 或历史升级回归。PR 的 run 会先合入 base 分支的最新提交（GitHub 的 `refs/pull/<n>/merge` 停在 PR 最后一次 push 时的 base，重跑也沿用），所以重跑即对着当前 main；main 的 ci 由红转绿时，`.github/workflows/pr-rerun.yml` 自动重跑最近一次 ci 失败的 open PR（非草稿、无冲突），也可手动触发。

## 升级一台已部署的机

升 **v1.2.22**：更新控制面和槽内 kernel；一键更新会自动同步且不会 `docker rm` 槽。步骤见 [DEPLOY.md · 已部署机升级到 1.2.22](DEPLOY.md#已部署机升级到-1222)。

**Compose（其它版本通用）**

```bash
cd /opt/vm2api
git pull
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

槽位容器不会被升级脚本无条件 `docker rm`。从 1.2.22 开始，一键更新默认把 `share/wrap-cli` 同步到本机槽并重启槽内 dataplane；集群槽在同一次同步里重建内容哈希镜像并换容器。仅在明确需要延后时使用 `--no-sync-wrap`。

**本机 Node + systemd**

1. `git pull` 或检出目标 tag。
2. `npm ci`；`pnpm -C web install --frozen-lockfile && npm run build:web`；`npm run build:egress && npm run build:worker`。
3. `npm run fetch:payload` 换 `bin/` 和 `share/` ELF，再调用 `POST /api/panel/wrap-cli/sync` 并传 `{"restart":true}`。同步优先 `bin/kin-kernel`。
4. `node --check src/server.mjs`。
5. `systemctl restart vm2api` **一次**。确认 `/health`。

静态 HTML / `web/dist` 单独更新不必重启。同一轮不要 restart 两次，不要 `stop` 后不拉起。


---

交流见仓库 [README](../README.md)。
