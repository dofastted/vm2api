# vm2api

订阅转 API。管理台调度槽位，协议口兼容 Anthropic / OpenAI。

[![Release](https://img.shields.io/github/v/release/dofastted/vm2api?display_name=tag)](https://github.com/dofastted/vm2api/releases)
[![License](https://img.shields.io/github/license/dofastted/vm2api)](LICENSE)
[![Telegram](https://img.shields.io/badge/Telegram-@VM2API-blue?logo=telegram)](https://t.me/VM2API)

💬 [Telegram @VM2API](https://t.me/VM2API)

自建：[部署说明](docs/DEPLOY.md) · 版本：[BUILD.md](docs/BUILD.md)

---

## 运行形态

Compose **只起 1 个**控制面容器 `vm2api`。每个**已启动**的槽再起 1 个 `kin-<槽>`。未启动的槽不占容器。`docker ps` 里其它名字是同机别的项目。

不要把多槽塞进一个容器当多进程。

---

## 部署

生产：Ubuntu 24.04 + Docker Engine。仓库放在 **`/opt/vm2api`**。

```bash
git clone https://github.com/dofastted/vm2api.git /opt/vm2api
cd /opt/vm2api
cp .env.example .env
chmod 600 .env
# 填写 VM2API_API_KEY / VM2API_ADMIN_PASSWORD / VM2API_DB_SECRET

docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

升级：`git pull && docker compose up -d --build`。

Docker Desktop / WSL 下 `127.0.0.1:8787` 可能打不到，改用：

```bash
docker exec vm2api python3 -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8787/health").read().decode())'
```

---

## 使用

1. 打开 `http://127.0.0.1:8787/console`，用 `.env` 里的管理员密码登录。
2. 代理池：添加本地出口，或导入 SOCKS5。
3. 建槽、绑出口、启动。没出口会停在 `stopped`。
4. 在槽里导入凭证后再打协议口。

| 入口 | 地址 |
|---|---|
| 探活 | `GET /health` |
| 管理台 | `GET /console` |
| 协议 | `POST /v1/messages`（master key 或 `sk-vm-…`） |

```bash
curl -sS http://127.0.0.1:8787/v1/messages \
  -H "Authorization: Bearer $VM2API_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":128000,"messages":[{"role":"user","content":"hello"}]}'
```

完整步骤：[DEPLOY.md](docs/DEPLOY.md)。

---

## 文档

| 文档 | 内容 |
|---|---|
| [DEPLOY.md](docs/DEPLOY.md) | 安装、环境变量、升级 |
| [BUILD.md](docs/BUILD.md) | 版本与构建 |
| [API.md](docs/API.md) | `/v1` |
| [PANEL_API.md](docs/PANEL_API.md) | 管理台 API |
| [CHANGELOG.md](CHANGELOG.md) | 版本记录 |

当前发布：**v1.1.2**

---

## FAQ

1. **立刻退出，提示 `VM2API_API_KEY not set`？**  
   Compose 写仓库 `.env`。本机 Node 见 [DEPLOY.md](docs/DEPLOY.md)。

2. **槽不调度？**  
   先绑出口，再导入凭证。没凭证是 `no_credential`。

3. **`permission denied` 跑 kin-kernel？**  
   `chmod 755 bin/kin-*`。不要 `700`。

4. **`docker ps` 容器很多？**  
   本项目只要 `vm2api` + 已启动的 `kin-*`。其它是同机别的软件。

---

## 交流

Telegram：[t.me/VM2API](https://t.me/VM2API)

<img src="docs/images/tg-vm2api.jpg" alt="Telegram @VM2API" width="220" />
<img src="docs/images/support-wechat.png" alt="支持收款码" width="220" />

欢迎 Issue / PR。不要提交 `.env` 或槽里的凭证。

---

vm2api 不是 Anthropic 官方项目。
