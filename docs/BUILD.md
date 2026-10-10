# 版本与构建

linux amd64 `bin/kin-{kernel,egress,worker,codex-kernel,oauth-auth}`、`share/wrap-cli` 和 `web/dist` 进 git。kernel / wrap / 控制台都是预编译产物，clone 或拉镜像即可部署，镜像构建不再跑 `pnpm build`。GitHub Release 仍挂一份 ELF。改了 `web/` 要重新 `pnpm -C web build` 并提交 `web/dist`。

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

`v*` tag 推上去之后，Actions 在 `ubuntu-latest` 编 Go linux amd64，并挂仓内预编译 kernel / wrap ELF 到该 tag 的 Release：

| 文件 | 角色 |
|---|---|
| `kin-kernel` | Claude Code 槽内核（仓内预编译，推理必带） |
| `kin-egress` | 远程 SOCKS5 透明网关 |
| `kin-worker` | **只** `telemetry`，不是 hop |
| `kin-codex-kernel` | Codex 槽；仓内预编译 |
| `kin-oauth-auth` | OAuth / Setup Token 换票服务二进制；源码不随部署上传 |
没有 tag、只点 workflow_dispatch 时，产物进 artifact，不会建 Release。

控制面镜像下载同一轮 `linux-amd64` artifact，把新编译的 `kin-worker` / `kin-egress` 放入镜像，不使用仓内旧 Go 副本。artifact 保留 7 天，正式 Release assets 不受此期限影响。

槽位 OS 镜像由 `.github/workflows/guest-images.yml` 独立发布：main 上 `docker/kin-os/`、`docker/kin-kvm/` 或该 workflow 有变化时触发，也可手动运行。四种系统并行构建，各用独立缓存；普通应用发版不再重复构建槽位 OS / KVM runner 镜像。

KVM runner 镜像（`ghcr.io/dofastted/kin-kvm-{ubuntu,debian,arch,fedora}`）在同一 workflow 的 `kvm` job 构建：单 Dockerfile `docker/kin-kvm/` + `ARG CLOUD_IMAGE_URL`（官方 cloud image URL 见 `src/lib/vm/os-catalog.mjs` 的 `kvm.cloud_image`）。本机构建：

```bash
node docker/kin-kvm/build.mjs ubuntu          # 与 kin-os 同语义：--force / --pull / --pull-only / 过滤器
```

装到机器上（Compose 部署可跳过，仓内 `bin/` 已有同名文件）：

```bash
install -m 755 kin-kernel kin-egress kin-worker kin-codex-kernel kin-oauth-auth /opt/vm2api/bin/
```

然后按 [DEPLOY.md](DEPLOY.md) 指环境变量。槽进程不是 root：权限必须是 `755`，不要 `700`。

控制面镜像：`docker compose build` 拷仓内 `bin/kin-*` 与 `share/wrap-cli`（见 [DEPLOY.md](DEPLOY.md#docker-compose)）。槽位 `kin-os/*` 首次启动编 ubuntu，或 `node docker/kin-os/build.mjs`；KVM 槽编 `kin-kvm-*`，或 `node docker/kin-kvm/build.mjs`。

## 本机构建

依赖：Node 22、Go 1.25、pnpm 10、python3（官方 CLI PTY 脚本）。OAuth 换票由控制面 spawn `bin/kin-oauth-auth` 完成；`auth.js` 只保留在本地构建目录，不上传到控制面。kernel / wrap CLI 用仓内 ELF，不要在本机 cargo / 重编 Claude Code。

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

CI（`.github/workflows/test.yml`）在 main push / PR 上运行，也可手动触发：Node 格式、源码及脚本语法与 unit；`worker/` 和 `api-kernel/` 的 gofmt、race test、vet 和命令编译；全部部署 ELF 的 linux amd64 检查与主 kernel / wrap 副本一致性；web 格式、测试、类型检查和构建。Node 22、Go 1.25、pnpm 10 与部署要求一致，依赖缓存分别以对应 lockfile / `go.sum` 为键。

## 升级一台已部署的机

升 **v1.2.22**：更新控制面和槽内 kernel；一键更新会自动同步且不会 `docker rm` 槽。步骤见 [DEPLOY.md · 已部署机升级到 1.2.22](DEPLOY.md#已部署机升级到-1222)。

**Compose（其它版本通用）**

```bash
cd /opt/vm2api
git pull
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

槽位容器不会被升级脚本 `docker rm`。从 1.2.22 开始，一键更新默认把 `share/wrap-cli` 同步到所有槽并重启槽内 dataplane；仅在明确需要延后时使用 `--no-sync-wrap`。

**本机 Node + systemd**

1. `git pull` 或检出目标 tag。
2. `npm ci`；有 web 改动则 `pnpm -C web install --frozen-lockfile && npm run build:web`。
3. 换仓内 `bin/` 和 `share/wrap-cli` ELF（`install -m 755`），再调用 `POST /api/panel/wrap-cli/sync` 并传 `{"restart":true}`。同步优先仓内 `bin/kin-kernel`。
4. `node --check src/server.mjs`。
5. `systemctl restart vm2api` **一次**。确认 `/health`。

静态 HTML / `web/dist` 单独更新不必重启。同一轮不要 restart 两次，不要 `stop` 后不拉起。


---

交流见仓库 [README](../README.md)。
