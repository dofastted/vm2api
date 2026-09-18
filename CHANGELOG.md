# Changelog

## Unreleased

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
