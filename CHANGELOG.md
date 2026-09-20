# Changelog

## Unreleased

- 官方初装遥测：`CLAUDE_CONFIG_DIR` 下的 `~/.claude/.claude.json` 视为官方身份，提升到 `~/.claude.json`，不再当 leftover 删掉导致 sidecar 停在 `waiting_official_identity`

## 1.2.13 — 2026-09-20

修正 Compose 镜像名。不必换槽内 kernel。

- `docker-compose.yml` 的 `image` 从错误的 `vm2api:1.2.12,,` 改为 `vm2api:1.2.13`

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-1213)

## 1.2.12 — 2026-09-20

第三方 OpenAI 兼容口与 Anthropic Messages 的 cache 断点对齐。不必换槽内 kernel。

- 清洗后 system / messages 升成可挂断点的 text 块，保留 tools 与文本块上的 `cache_control`
- 非官方 cli-hop 改回 Node rewrite（last + 倒数第二个 user），官方仍剥光交给 kernel
- 三种入站协议 stamp 位置一致，避免 `cache_read` 冻在 system 前缀

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-1212)

## 1.2.11 — 2026-09-20

控制面调度补齐等待计划、额度受限三态和设置/列表。不必换槽内 kernel。

- 槽满（`ready_slots=0` 且 CLI 在）按 `slot_busy` 等待或改选，不标 `worker_unhealthy`
- 半截 assistant 不再经 `preferLastResult` 变成 HTTP 200
- 等待按账号计数，超时绑 wait plan；hop 吃剩余预算
- 额度用尽 / 429 / 冷却写成 **受限**，不拨操作员调度关；窗口到了自动恢复
- 列表芯片：在池 / 受限 / 关闭调用；设置页露出等待人数和两类超时
- Windows 上 Vite 8 / Vitest 4 能装到 rolldown 的 win32 绑定

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-1211)

## 1.2.10 — 2026-09-20

修复 Docker web 构建，并换仓内 `kin-cookie-auth`。不必换槽内 kernel。

- 401 跳登录补上必填 `search`，`tsc -b` 通过，compose 不再卡在 Dockerfile 第 7 步 `pnpm build`
- `kin-cookie-auth` 按 rust cli-hop 2.1.263 对齐 sessionKey 换票请求头（`claude-cli` + stainless，不再用合成 Chrome UA）

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-1210)

## 1.2.9 — 2026-09-20

thinking-only 残包不再当 HTTP 200；一键安装与 HTTP 面板登录加固。不必换槽内 kernel。

- `stream:false` 组包未完成不算 committed；只有 thinking / `stop_reason=null` 的假 `verified` 同槽再 hop，拿到正文再 200
- 重试用尽才 502 `incomplete_response`，禁止 `terminal_state=verified` + 空正文
- 槽满（`ready_slots=0`）等空槽，不 `docker restart`，也不往满槽塞请求
- 一键安装：空 `.env` 补默认管理台 `admin` / `123456`（不覆盖已有密码）与随机 API key；缺 `!CHANGELOG.md` 则补上并在 compose 失败时重试
- HTTP 裸 IP 登录：Bearer 写入 localStorage；Cookie `Secure` 跟请求走；401 回登录页，不再摊英文 Missing credentials

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-129)

## 1.2.8 — 2026-09-20

修复 compose build：`.dockerignore` 的 `*.md` 把 `CHANGELOG.md` 挡在构建上下文外，`COPY CHANGELOG.md` 失败。不必换槽内 kernel。

- `.dockerignore` 增加 `!CHANGELOG.md`

已部署机升级：只更新控制面并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-128)。卡住的 1.2.7 构建可先在仓库根 `.dockerignore` 加一行 `!CHANGELOG.md` 再 `docker compose up -d --build`。

## 1.2.7 — 2026-09-20

控制面：版本检查与一键更新。不必换槽内 kernel。

- `deploy/install.sh`：安装 / 更新 / 检查 / changelog / 状态（参考 sub2api 与 CLIProxyAPI）
- 面板 `GET /api/panel/version`、`GET /api/panel/changelog`、`POST /api/panel/update`；`GET /me` 带 `version`
- 设置页「关于」：当前版本、GitHub 最新 Release、changelog、复制一键命令
- 镜像 COPY `VERSION` / `CHANGELOG.md`；已挂 `docker.sock` 时可由面板拉起宿主机升级助手

已部署机升级：只更新控制面 Node（含 web）并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-127)。

## 1.2.6 — 2026-09-20

控制面：本地出口导入、kernel 探活、Setup Token 额度。不必换槽内 kernel。

- 本地出口绑槽后允许导入 / host hop（空 SOCKS URL 视为直连，不再报未绑定）
- 调度、面板 live credential、VM 详情健康检查打 rust `kernel.sock`，不再探不存在的 `worker.sock`
- Setup Token 写入凭证时把 `inference` 规范成 `user:inference`
- Setup Token Extra 5h/7d 进面板详情；手动额度探测真正 hop
- 额度卡展示剩余百分比与重置时间

已部署机升级：只更新控制面 Node（含 web）并重启一次。不必 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-126)。

## 1.2.5 — 2026-09-20

仓内预编译 linux amd64 二进制，clone / compose 即可部署，不必在服务器上编 kernel 与 wrap CLI。

- `bin/kin-{kernel,codex-kernel,cookie-auth,egress,worker}` 与 `share/wrap-cli` 进 git；Release 再挂一份 ELF
- 已部署机升级：控制面重启一次 + `POST /api/panel/wrap-cli/sync` 换槽内 CLI（见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-125)）

## 1.2.4 — 2026-09-20

协议页简化 UI。缓存 TTL 默认 1h，可改 5m。

## 1.2.3 — 2026-09-20

控制面：拦截 memory-extractor 收割；创建槽开机失败仍可见；控制台集群/列表改版。

- 非官方 OpenAI chat 冒充 Claude Code、索要 durable-memory JSON 的 payload 在 hop 前拦截
- 创建槽位开机失败改 200 + `start_error`，列表立刻出现 error 行，不再当创建失败
- 集群页改为本机 VPS + 扩展节点拓扑（控制面尚未接入，示意为 RFC 5737）
- 虚拟机列表去掉重复 KPI 卡，筛选/工具收成两行

已部署机升级：只更新控制面 Node（含 web）并重启一次。已在 1.2.2 不必再 `wrap-cli/sync`。见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-123)

## 1.2.2 — 2026-09-20

修复缓存问题；换票逻辑更新。

- 额度缓存空刷新不再覆盖仍有效的 reset credits
- sessionKey / 授权码换票改走仓内 `bin/kin-cookie-auth`，控制面不再带过程源码
- 已部署机升级：控制面重启一次 + `POST /api/panel/wrap-cli/sync` 换槽内 kernel（见 [DEPLOY.md](docs/DEPLOY.md#已部署机升级到-122)）

## 1.2.1 — 2026-09-19

模型测试路径不再因缺 `message_stop` 刷成 api_error。

- wrap JobDone 若未带 `message_stop`，kernel 补发，hop 不再标 incomplete
- cli-hop 剥光 messages 上的 `cache_control`；kernel 按 Claude Code 打最后一块（跳过 thinking）并打上一条 user，避免 tool 循环把 cache_read 钉在 ~45k system 前缀

## 1.2.0 — 2026-09-19

messages 缓存断点对齐 sub2api/Parrot。

- 最后一条 + 仅当 messages≥4 打倒数第二个 user
- cli-hop 丢掉 last 后留下倒数第二个 user，wrap CLI 重打当前 last user，不再重复

## 1.1.9 — 2026-09-19

cli-hop prompt cache restamp；环境时区可自定义；代理出口地理检测。

- 默认 messages 断点 rewrite：重打最后一条 + 上一条，避免 cache_read 冻在 ~43.5k system
- cli-hop 只打 conversation 断点，剥 tools/system 和 last-message 让 wrap CLI 落点，不超 4 断点上限
- 创建槽位和环境设置支持任意 IANA 时区（自定义输入）
- `POST /proxies/geo` · `POST /proxies/:id/geo` 经 SOCKS5 查出口 IP 的国家 / 城市 / 时区
- 绑定代理后槽位默认采用出口时区；手动钉过的时区不被覆盖

## 1.1.8 — 2026-09-19

面板分档配额立刻生效；东京时区；Fable 5.1 官方模型 ID。

- 控制面板 5h/7d、RPM、并发、session 走 live policy；session 占用保持到空闲超时
- 槽位创建支持东京 JST，有效 IANA 时区在创建/指纹/重建时保留
- 内置目录改为 `claude-fable-5-1`，点号 ID 作兼容别名

## 1.1.7 — 2026-09-19

Opus/Sonnet extra-usage 429 与 GPT `/v1/messages` 未绑槽一并修掉。

- wrap/kernel `CLAUDE_CODE_ENTRYPOINT=cli`，订阅 OAuth 不再按 sdk-cli extra usage 429
- HTTP 2xx leftover `stream_incomplete` 不再刷成超时
- GPT 模型打 `/v1/messages` 转到 Codex 槽，回 Anthropic 信封，日志带 `vm_id`

## 1.1.6 — 2026-09-18

同步源仓 wrap 内核：复用槽内 `.claude`，submit 更快起 job。

- wrap 指向凭证父目录，不再写临时 config + dummy OAuth
- `kin_job_start` 先于 extra maps；热路径不再 `await retire_idle`

## 1.1.5 — 2026-09-18

同步源仓内核/后端补丁：wrap Extra 5h 头、slot 回收、官方 max_tokens、GPT 额度 failover。

- wrap `kin_job_done` Extra 5h 头进 trailer；ReadyBlocked 不再 30m 误杀；job 后清 tenant
- 缺 `max_tokens` 填官方 per-model 默认，不覆盖调用方
- GPT `x-codex-*` 入库，5h/7d 调度关，429 最多 4 槽 failover
- 本地与 CI 统一格式：Biome / gofmt / Prettier，全文 LF
- README 恢复详细说明；许可改为非商用开源，商用需书面授权

## 1.1.4 — 2026-09-17

补齐 cli-hop CI 夹具，和源仓 simulated job_error / CONNECT 桥一致。

- simulated CLI 对 `[job_error]` 发 `kin_job_error`，槽可回收
- 补回 `scripts/http_to_socks.py`，适配 `crates/kin-kernel` 布局

## 1.1.3 — 2026-09-17

gateway-worker 对齐源仓：local_cli 走 wrap CLI，不再 HTTP hop 到 Anthropic。

- `provider=local_cli` 启动 MultiplexCli，`/internal/v1/messages` 走 cli-hop
- 去掉 anthropic_api HTTP hop，避免 OAuth extra usage 429

## 1.1.2 — 2026-09-17

仓内携带部署二进制；文档写清运行形态。

- git 带 linux amd64 `bin/kin-{kernel,egress,worker,codex-kernel}` 和 wrap 母样本 `share/wrap-cli`
- Compose 拷到 `./bin` / `./share`，不再在服务器上编 Rust/Go；缺 `kin-os/ubuntu:24.04` 才编槽位 OS
- 入口用 `mv` 替换占用中的 `kin-kernel`，避免 `Text file busy` 重启循环
- 文档：1 个控制面容器 + 每个已启动槽 1 个 `kin-*` 容器，不是父容器多进程

## 1.1.1 — 2026-09-17

补回授权链接换票缺件。

- 补回 `scripts/session-import-cffi.py`（源仓 CookieAuth / Chrome TLS），控制面镜像安装 `curl_cffi`
- 补回官方 Claude Code 常驻脚本 `scripts/official-cc-resident.py`

## 1.1.0 — 2026-09-17

推荐 Docker Compose 部署，并修槽位启动。

- 文档把 Compose 定为生产推荐路径（`/opt/vm2api` + `docker.sock` + host 网络）
- 槽位客户镜像配方进仓：`docker/kin-os/`（`node docker/kin-os/build.mjs`）
- 修复本地出口启动误判 `egress network missing`（inspect 同时返回 `name` 与 `network`）
- 文档要求 `bin/kin-*` 为 **755**：槽 UID 是 `10000+序号`，`700` 会 permission denied
- 标明 Docker Desktop / WSL 下 `127.0.0.1:8787` 可能打不到 host 网络
- 控制面可用 Docker Compose 部署（槽位仍在宿主机引擎）
- 同步源仓运行时补丁：换票后回收 wrap、官方凭证软链、未确认 401 不再当吊销
- 同步源仓 GPT 额度：重置券缓存失败不覆盖、探测带回 `cred_status`

## 1.0.0 — 2026-09-16

首个公开版本。

- Setup Token → Console API，产品面 0 提示词注入
- 推理只走 Rust 内核 + Claude Code 原生 subagent（最大 20）
- 删除 Go HTTP hop；`kin-worker` 只保留 telemetry
- 代理池支持远程 SOCKS5 与本地出口（宿主机 NAT）
- Vite 管理台（`GET /console`），环境变量 admin，无用户管理
- 协议口 `/v1/messages` 及 OpenAI 兼容入口
- GitHub Actions：测试 + `v*` linux amd64 Release
- 文档：技术路线图、部署说明、版本构建

交流：[t.me/VM2API](https://t.me/VM2API)
