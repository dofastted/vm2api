# 部署

本机或 Linux 主机自建一份 vm2api。推理走 **Rust 内核 + Claude Code**，不走 Go hop。

**推荐 Docker Compose**：仓库放到 `/opt/vm2api`，`docker compose up -d --build`。本机 Node + systemd 是备选。

先看路线：[技术路线.md](技术路线.md)。打二进制：[BUILD.md](BUILD.md)。仓库总览：[README](../README.md)。

## 机器要什么

| 项 | 建议 |
|---|---|
| OS | Ubuntu 24.04（glibc 够新，wrap / Claude kernel 才能起） |
| 运行时 | Node 22、Docker、iptables、python3 + `curl_cffi`（授权链接 / sessionKey CookieAuth） |
| 编译（本机构建时） | Rust stable、Go 1.25、pnpm 10 |
| 网 | 每槽一条出口：远程 SOCKS5，或代理池里的 **本地出口** |

Debian 12（glibc 2.36）上新 Claude kernel 常常起不来，优先 Ubuntu 24。

## 目录怎么摆

把仓库放到例如 `/opt/vm2api`。工作目录就是仓库根。

```text
/opt/vm2api/
  src/server.mjs      控制面
  web/dist/           管理台（Compose 镜像内已构建）
  bin/kin-kernel      Rust 内核（必须 755）
  bin/kin-egress      远程 SOCKS5 透明网关
  bin/kin-worker      只跑 telemetry，不是推理 hop
  docker/kin-os/      槽位客户镜像配方（宿主机编）
  vms/                槽位 JSON + 槽家目录
  data/               SQLite 等
  src/config/routing.json
```


环境变量 `KIN_PROJECT_ROOT` 默认就是仓库根。`KIN_DATA_DIR` 不设时落在 `src/data`；自建请显式设成仓库 `data/`。

## 环境变量

`VM2API_*` 优先，没有再读 `KIN_*`。

最少这三项，缺 `VM2API_API_KEY` 进程直接起不来：

```bash
export VM2API_API_KEY='换成很长的随机串'
export VM2API_ADMIN_PASSWORD='面板登录密码'
export VM2API_DB_SECRET='再换一串，加密库用'
```

常用可选：

| 变量 | 默认 | 做什么 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 监听 |
| `PUBLIC_BASE_URL` | 按 host:port 拼 | 对外看到的根 |
| `KIN_KERNEL_BIN` | 空则按仓库 `bin/` 解析 | Rust 内核路径 |
| `KIN_EGRESS_BIN` | `/opt/kin-gateway/bin/kin-egress` | 远程 SOCKS 网关；自建请改成 `/opt/vm2api/bin/kin-egress` |
| `KIN_WORKER_BIN` | `/opt/kin-gateway/bin/kin-worker` | 只给 telemetry |
| `VM2API_ADMIN_USER` | `admin` | 面板用户名 |

完整抄本：[deploy/env.example](deploy/env.example)。

不要把这些值写进 git。

## Docker Compose

**推荐。** 控制面用 Compose 起；槽位仍由**宿主机** Docker 引擎创建。这不是把整套推理塞进一个无特权应用容器。

| 在容器里 | 必须在宿主机 |
|---|---|
| Node 控制面、`/console`、`/v1` | Docker 引擎、槽位容器、`kin-os/*` 客户镜像 |
| `docker` CLI（经 `docker.sock`） | Release 二进制目录 `bin/`（挂进去，**755**） |
| `kin-egress` 进程 + iptables（`network_mode: host` + `NET_ADMIN`） | 桥接网卡、透明出口 |

约束：

1. 仓库放在 **`/opt/vm2api`**。槽位 `-v /opt/vm2api/vms/…` 由宿主机 Docker 解释，内外路径必须相同。
2. `network_mode: host`。远程 SOCKS 出口要在主机网络命名空间里 REDIRECT。
3. 挂 `/var/run/docker.sock`。这等于给容器宿主机级 Docker 权限。
4. 把 `kin-kernel` / `kin-egress` / `kin-worker` 放进 `./bin`（[Release](https://github.com/dofastted/vm2api/releases)），`chmod 755`。槽 UID 是 `10000+序号`，`700` 会 `permission denied`。
5. 槽位镜像 `kin-os/ubuntu:24.04` 等要已经在宿主机 `docker images` 里。Compose **不**编这些 OS；用 `node docker/kin-os/build.mjs ubuntu`（不加参数编四套）。

```bash
git clone https://github.com/dofastted/vm2api.git /opt/vm2api
cd /opt/vm2api
cp .env.example .env
chmod 600 .env
# 填写三项密钥

mkdir -p bin
# 下载 v1.1.1 linux amd64 到 bin/ 后：
chmod 755 bin/kin-kernel bin/kin-egress bin/kin-worker

node docker/kin-os/build.mjs ubuntu
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

Docker Desktop（Windows / macOS / WSL2）能编镜像。`network_mode: host` 绑的是 Desktop Linux VM，**不是** WSL 的 localhost。`curl 127.0.0.1:8787` 失败时：

```bash
docker exec vm2api python3 -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8787/health").read().decode())'
```

槽位、iptables、透明出口按 Linux 写。**生产用 Ubuntu 24.04 + Docker Engine。**

升级控制面：`git pull && docker compose up -d --build`。槽位容器不会因此被 `docker rm`。静态管理台在镜像里，要带上新的 `web/dist` 就重新 `--build`。

建槽前先在 `/console` 点 **添加本地出口**（或导入 SOCKS5）。没绑出口的槽会停在 `stopped`。1.1.0 起本地出口网络同时带 `name` 和 `network`，不再误报 `egress network missing`。


## 第一次落地（本机 Node）

```bash
git clone https://github.com/dofastted/vm2api.git /opt/vm2api
cd /opt/vm2api
npm ci
pnpm -C web install --frozen-lockfile
pip3 install --break-system-packages curl_cffi

# 本机构建，或从 Release 把 linux amd64 丢进 bin/
npm run build:kernel
npm run build:egress
npm run build:web
# 可选：npm run build:worker   # 只要 telemetry
```

启动前必须有一个占位槽，否则 `loadConfig()` 读不到 `vms/active.json` 会退出：

```bash
mkdir -p vms data bin
cat > vms/active.json <<'EOF'
{ "active_vm": "vm-01" }
EOF
cat > vms/vm-01.json <<'EOF'
{
  "id": "vm-01",
  "name": "vm-01",
  "status": "stopped",
  "schedulable": false,
  "policy": { "maxConcurrency": 2 }
}
EOF
```

然后：

```bash
set -a && source /etc/vm2api.env && set +a
node src/server.mjs
```

本机探活：

```bash
curl -sS http://127.0.0.1:8787/health
```

管理台：`GET /console`（要先有 `web/dist`）。面板账号是环境变量里的 admin，没有用户管理页。

## systemd

单元抄本：[deploy/vm2api.service](deploy/vm2api.service)。

```bash
install -m 600 docs/deploy/env.example /etc/vm2api.env   # 再改真实密钥
install -m 644 docs/deploy/vm2api.service /etc/systemd/system/vm2api.service
systemctl daemon-reload
systemctl enable --now vm2api
```

改热路径 `.mjs` 后：`node --check src/server.mjs`，再 `systemctl restart vm2api` **一次**。静态 `web/dist` 不用重启。

## 反代

Node 只绑 `:8787`。前面用 nginx 把 `/v1` `/api` `/console` `/health` 转过去即可。HTTPS 终结在 nginx。

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header Authorization $http_authorization;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_read_timeout 600s;
}
```

## 上线后点什么

1. 打开 `/console`，用 `VM2API_ADMIN_PASSWORD` 登录。Docker Desktop 下若浏览器打不开 `127.0.0.1:8787`，见上文 `docker exec` 探活。
2. 代理池：点 **添加本地出口**（宿主机 NAT，不启 kin-egress），或导入远程 SOCKS5。
3. 建 Claude 槽（默认 Ubuntu 24.04），绑出口，再 **启动**。没出口会停在 `stopped`。
4. 导入 Setup Token。换票后走官方初装（wipe → hello → `/stats`）。推理不跑官方常驻 CLI。
5. 用 `sk-vm-…` 或 master key 打 `POST /v1/messages`。

槽必须有出口。没凭证时 `schedulable=false` / `no_credential`，不会调度。


## 不要做的事

- 不要把 ELF 提交进 git。
- 不要让 Node 直连 Anthropic 当推理回落。
- 不要再启 Go HTTP hop。`kin-worker` 只接受 `telemetry`。
- 不要把 `VM2API_*` / OAuth / sessionKey 写进仓库或 Issue。

---

交流与支持见仓库 [README](../README.md#交流与支持)。
