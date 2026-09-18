# vm2api

虚拟机拟真 + Claude Code 原生 subagent。**0 提示词注入**。

[![Release](https://img.shields.io/github/v/release/dofastted/vm2api?display_name=tag)](https://github.com/dofastted/vm2api/releases)
[![License](https://img.shields.io/badge/License-Noncommercial-yellow.svg)](LICENSE)
[![Telegram](https://img.shields.io/badge/Telegram-@VM2API-blue?logo=telegram)](https://t.me/VM2API)


> **许可**：个人学习与非商用自建可用。**商用必须先取得书面授权**。联系 [Telegram @VM2API](https://t.me/VM2API)。全文见 [LICENSE](LICENSE)。

💬 **加入讨论**：[Telegram @VM2API](https://t.me/VM2API)

主路线图解：[技术路线](docs/技术路线.md) · 自建：[部署说明](docs/DEPLOY.md) · 打二进制：[版本构建](docs/BUILD.md)
---

## 核心能力

- 🪪 **Console API，不是 OAuth**：Setup Token 转成 Console 可用 API，取代 OAuth 换来的 AT / RT。上游按 Console 客户端看待你。
- 🧼 **0 提示词注入**：不再靠改 system / 注入人设去“像官方”。身份在凭证形态上就已经是 Console。
- 🧩 **Claude Code 原生 subagent**：槽内官方转发面，最大 **20** 路并发，不用第三方假客户端顶替。
- 🖥️ **Docker 或真虚拟机**：一槽一台机器。拟真物理机指纹仍在攻克，欢迎方案。
- 📡 **全量遥测**：目标是 Claude 认为你是一台完全独立的电脑，并且无其余特征。
- 🌐 **出口可选**：每槽一条远程 SOCKS5，或代理池「添加本地出口」。
- 🎛️ **管理台**：`GET /console`。环境变量 admin 登录，没有用户管理页。
- 🔌 **协议口**：`POST /v1/messages`（Anthropic），以及 Chat / Completions / Responses 兼容入口。

---

## 快速开始

### 环境要求

| 项 | 建议 |
|---|---|
| OS | Ubuntu 24.04（glibc 够新；Debian 12 上新内核常常起不来） |
| 运行时 | Node 22、Docker、iptables |
| 本机构建 | Rust stable、Go 1.25、pnpm 10 |
| 网 | 每槽一条出口：远程 SOCKS5，或本地出口 |

### Docker Compose（推荐）

生产就用这条。仓库必须在 **`/opt/vm2api`**（容器内外路径一致）。

**运行形态（不是一个父容器里一堆子进程）：**

- Compose **只起 1 个** `vm2api` 控制面（面板、`/v1`、调度）
- 每个**已启动**的槽另起 1 个宿主机容器 `kin-<槽>`（独立家目录 / 出口 / 指纹 / 遥测）
- 未启动的槽不占容器。`docker ps` 里其它名字是同机别的项目，不是 vm2api

```bash
git clone https://github.com/dofastted/vm2api.git /opt/vm2api
cd /opt/vm2api
cp .env.example .env
chmod 600 .env
# 填写 VM2API_API_KEY / VM2API_ADMIN_PASSWORD / VM2API_DB_SECRET

docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

`--build` 拷仓内 `bin/kin-{kernel,egress,worker,codex-kernel}` 和 `share/wrap-cli`，**不在服务器上编 Rust/Go**。缺槽位 OS 时入口编 `kin-os/ubuntu:24.04`。其它发行版：`node docker/kin-os/build.mjs`。槽 UID 是 `10000+序号`，`bin/kin-*` 必须 **755**，不要 `700`。



Docker Desktop（含 WSL2）的 host 网络在 Desktop Linux VM 里，WSL/macOS 的 `127.0.0.1:8787` 可能连不上。改用：

```bash
docker exec vm2api python3 -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8787/health").read().decode())'
```

生产请用 **Ubuntu 24.04 + Docker Engine**。完整约束：[DEPLOY.md · Docker](docs/DEPLOY.md#docker-compose)。


### 本机 Node

1. **克隆并安装**

   ```bash
   git clone https://github.com/dofastted/vm2api.git /opt/vm2api
   cd /opt/vm2api
   npm ci
   pnpm -C web install --frozen-lockfile
   npm run build:web
   ```

   内核 / 网关：仓内 `bin/kin-*` 已是 linux amd64。也可本机重编或从 [Release](https://github.com/dofastted/vm2api/releases) 覆盖。

2. **写环境变量和占位槽**

   ```bash
   cp docs/deploy/env.example /etc/vm2api.env
   chmod 600 /etc/vm2api.env
   # 必填：VM2API_API_KEY / VM2API_ADMIN_PASSWORD / VM2API_DB_SECRET
   # 自建请把 KIN_*_BIN 指到 /opt/vm2api/bin/

   mkdir -p vms data bin
   printf '%s\n' '{ "active_vm": "vm-01" }' > vms/active.json
   ```

   还要有 `vms/vm-01.json`，抄本见 [部署说明](docs/DEPLOY.md#第一次落地)。没有 `vms/active.json` 进程会退出。

3. **启动**

   ```bash
   set -a && source /etc/vm2api.env && set +a
   node src/server.mjs
   ```

   生产用 systemd：[docs/deploy/vm2api.service](docs/deploy/vm2api.service)。

### 访问

启动成功后：

| 入口 | 地址 |
|---|---|
| 探活 | `http://127.0.0.1:8787/health` |
| 管理台 | `http://127.0.0.1:8787/console`（`VM2API_ADMIN_PASSWORD`） |
| 协议 | `POST /v1/messages`（master key 或 `sk-vm-…`） |

上线后：代理池绑出口 → 建 Claude 槽 → 导入 Setup Token → 官方初装 → 再打 `/v1`。完整步骤：[DEPLOY.md](docs/DEPLOY.md)。

```bash
curl -sS http://127.0.0.1:8787/v1/messages \
  -H "Authorization: Bearer $VM2API_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":128000,"messages":[{"role":"user","content":"hello"}]}'
```

---

## 技术路线

![Console API 取代 OAuth AT/RT，零提示词注入](docs/images/vm2api-01-console-api.png)

| 旧路 | 本仓 |
|------|------|
| OAuth 拿到 AT / RT，上游按 OAuth 客户端看你 | Setup Token → Console API |
| 为了像官方，要注人设 / 提示词 | Claude 认为你是 Console API |
| 提示词注入有泄漏面 | **0 提示词注入** |

![用户请求到 Console API 的六站流水线](docs/images/vm2api-02-route.png)

```text
用户请求
  → 协议清洗
  → POST /v1/messages
  → 接入 Claude Code 原生 subagent
  → TCP 转发
  → Console API endpoint
  → 透明转发给用户
```

![Docker / 真虚拟机、物理指纹、20 路原生 subagent](docs/images/vm2api-03-vm-subagent.png)

- 槽位可以是 **Docker**，也可以是 **真虚拟机**
- 槽内 **Claude Code 原生 subagent**，最大 **20** 并发
- **拟真物理机指纹** 仍在攻克。欢迎开 Issue / PR

![全量遥测，独立电脑，无其余特征](docs/images/vm2api-04-telemetry.png)

遥测全量发送。一槽一台机器。身份、遥测、指纹都按单机收敛。

展开说明：[docs/技术路线.md](docs/技术路线.md)

---

## 架构

```text
客户端 / Claude Code / 兼容 SDK
        │  Bearer / x-api-key
        ▼
Node 控制面  :8787
  协议清洗 · 调度 · 管理台 /console
        │  cli-hop
        ▼
槽（Docker 或真虚拟机）
  Rust 内核 + Claude Code 原生 subagent（≤20）
        │  SOCKS5 或本地出口
        ▼
Console API endpoint  →  原样回传给调用方
```

| 目录 | 做什么 |
|---|---|
| `src/` | Node 控制面、`/v1`、面板 API |
| `web/` | Vite 管理台，构建后 `GET /console` |
| `crates/kin-kernel` | Claude Code Rust 内核 |
| `worker/cmd/kin-egress` | 远程 SOCKS5 透明网关 |
| `worker/cmd/kin-worker` | **只** telemetry，不是推理 hop |
| `docs/` | 路线、部署、构建、契约 |

二进制走 GitHub Release，不要把 ELF 提交进 git。不要提交凭证。

---

## 部署与配置

生产推荐：仓库放到 `/opt/vm2api`，写 `.env`，`docker compose up -d --build`。前面可以 nginx 反代 `/v1` `/api` `/console` `/health`。本机 Node + systemd 是备选，见 [DEPLOY.md](docs/DEPLOY.md#第一次落地本机-node)。

最少三项，缺 `VM2API_API_KEY` 或面板密码进程起不来：

```bash
VM2API_API_KEY=         # master key，/v1 + 面板 + /admin
VM2API_ADMIN_PASSWORD=  # 管理台登录
VM2API_DB_SECRET=       # 库加密
```

`VM2API_*` 优先，没有再读 `KIN_*`。完整表和 nginx 抄本：[DEPLOY.md](docs/DEPLOY.md) · [env.example](docs/deploy/env.example)

---

## 版本与构建

当前发布：**v1.1.6**

```bash
git tag -a v1.1.6 -m "vm2api v1.1.6"
git push origin v1.1.6
```

`v*` tag 会触发 [Release 工作流](.github/workflows/release.yml)，再挂一份 linux amd64 ELF。仓内 `bin/` 已可直接部署。步骤：[BUILD.md](docs/BUILD.md)


---

## 文档

| 文档 | 内容 |
|---|---|
| [技术路线](docs/技术路线.md) | 产品主路线（图） |
| [DEPLOY.md](docs/DEPLOY.md) | Docker Compose（推荐）、环境变量、占位槽、systemd、反代 |
| [BUILD.md](docs/BUILD.md) | 本机构建、Release、升级 |
| [API.md](docs/API.md) | `/v1` 客户端契约 |
| [PROTOCOL.md](docs/PROTOCOL.md) | 协议行为 |
| [PANEL_API.md](docs/PANEL_API.md) | 管理台 API |
| [OAUTH.md](docs/OAUTH.md) | 导入与换票（主凭证是 Setup Token） |
| [CHANGELOG.md](CHANGELOG.md) | 版本记录 |

---

## FAQ

1. **进程立刻退出，提示 `VM2API_API_KEY not set` 或读不到 JSON？**  
   Compose 写仓库 `.env`；本机 Node 写 `/etc/vm2api.env`，再准备 `vms/active.json`。抄本在 [DEPLOY.md](docs/DEPLOY.md#第一次落地本机-node)。

2. **`/console` 是空白或 404？**  
   Compose 镜像里已带 `web/dist`。本机 Node 先 `npm run build:web`。静态页更新不必重启 Node。

3. **槽建好了但不调度？**  
   先绑出口（远程 SOCKS5 或管理台 **添加本地出口**），再导入 Setup Token。没凭证是 `no_credential`，不会入池。

4. **Debian 12 上内核起不来？**  
   优先 Ubuntu 24.04。过旧的 glibc 跑不了当前 wrap / Claude kernel。

5. **还要不要跑 Go hop / `kin-worker` 当推理？**  
   不要。hop 服务端已删除。`kin-worker` 不带参数会退出，只接受 `telemetry`。

6. **密钥写进 git 了怎么办？**  
   立刻轮换 `VM2API_*`、Setup Token、面板密码。不要把密钥贴到 Issue。

7. **Compose 起来了但建不了槽 / `egress network missing`？**  
   仓库在 `/opt/vm2api`、`bin/kin-*` 为 **755**、宿主机有 `kin-os/*`、挂了 `docker.sock`。先添加本地出口再启动槽。1.1.0 已对齐 egress 的 `name`/`network` 字段。

8. **`exec: "/usr/local/bin/kin-kernel": permission denied`？**  
   `chmod 755 bin/kin-kernel bin/kin-egress bin/kin-worker bin/kin-codex-kernel`。不要用 `700`。

9. **本机 `curl 127.0.0.1:8787` 失败，容器却是 healthy？**  
   Docker Desktop 的 `network_mode: host` 不在 WSL/macOS localhost。用 `docker exec vm2api …` 探活，或改 Ubuntu + Docker Engine。

10. **`docker ps` 怎么这么多容器？**  
    vm2api 只要 `vm2api` + 每个已启动槽一个 `kin-*`。postgres / newapi / hermes 等同机其它栈，不是本项目子进程。不能把多槽塞进一个容器当多进程，否则指纹/遥测糊成一台。


---

## 交流与支持

Telegram 群组：[t.me/VM2API](https://t.me/VM2API)（`@VM2API`）

开源维护需要时间。扫码进群或支持一下，谢谢。

<img src="docs/images/tg-vm2api.jpg" alt="Telegram @VM2API" width="220" />
<img src="docs/images/support-wechat.png" alt="支持收款码" width="220" />

感谢 liunx do 论坛支持。

欢迎 Issue / PR。提交前请勿带上 `.env`、槽 JSON 里的票、或 Release 二进制。

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=dofastted/vm2api&type=Date)](https://star-history.com/#dofastted/vm2api&Date)

## 许可证

开源版仅覆盖个人学习、研究与非商用自建，须保留 [LICENSE](LICENSE) 全文。

**商用必须先取得书面授权**（对外收费、作为付费服务、公司生产营收、收费再分发等）。未授权商用禁止。申请：[Telegram @VM2API](https://t.me/VM2API)。

vm2api 不是 Anthropic 官方项目，与其无关联。Claude、Claude Code、Anthropic 等均为其权利人的商标。
