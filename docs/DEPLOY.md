# 部署

推荐 **Docker Compose**。仓库放在 `/opt/vm2api`。

## 机器

Ubuntu 24.04 + Docker Engine。Debian 12 上槽内核常常起不来。

最少三个环境变量，写在仓库 `.env`（`chmod 600`），不要进 git：

```bash
VM2API_API_KEY='很长的随机串'
VM2API_ADMIN_PASSWORD='面板密码'
VM2API_DB_SECRET='再一串'
```

抄本：[deploy/env.example](deploy/env.example)。`VM2API_*` 优先于 `KIN_*`。

## 该看到什么容器

| 容器 | 说明 |
|---|---|
| `vm2api` | 控制面。Compose **只起这一个** |
| `kin-<槽>` | 每个**已启动**的槽 1 个 |
| 没有 | 未启动的槽；同机其它项目的 postgres / newapi 等 |

不是一个父容器里多个子进程。

仓库必须在 `/opt/vm2api`（槽的 `-v` 路径由宿主机 Docker 解释）。挂 `docker.sock`，`network_mode: host`。

## 安装

```bash
git clone https://github.com/dofastted/vm2api.git /opt/vm2api
cd /opt/vm2api
cp .env.example .env
chmod 600 .env
# 填写上面三项

docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

二进制在仓内 `bin/`，Compose 会拷到挂载目录。`bin/kin-*` 必须 **755**。缺槽位系统镜像时会编 `kin-os/ubuntu:24.04`。

升级到 **v1.2.4** 见下面「已部署机升级到 1.2.4」。控制面重启即可，不必换槽内 kernel。

Docker Desktop / WSL 下 `curl 127.0.0.1:8787` 可能失败：

```bash
docker exec vm2api python3 -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8787/health").read().decode())'
```

## 上线后

1. 打开 `/console`，用 `VM2API_ADMIN_PASSWORD` 登录。
2. 代理池：添加本地出口，或导入 SOCKS5。
3. 建槽、绑出口、启动。没出口会停在 `stopped`。
4. 在槽里导入凭证，再用 `sk-vm-…` 或 master key 打 `POST /v1/messages`。

没出口或没凭证的槽不会进调度。

## 反代

Node 听 `:8787`。HTTPS 放在 nginx。

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

## 本机 Node（备选）

仓内已有 `bin/kin-*`。还要 `npm ci`、`pnpm -C web install --frozen-lockfile && npm run build:web`，以及占位 `vms/active.json`。单元：[deploy/vm2api.service](deploy/vm2api.service)。细节见 [BUILD.md](BUILD.md)。

## 已部署机升级到 1.2.4

1.2.4 只动**控制面 Node + web**（协议页简化 UI、缓存 TTL 默认 1h）。不必换槽内 kin-kernel，也不要 `docker rm` 槽。

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.4
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.4` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.3

1.2.3 只动**控制面 Node + web**（蒸馏拦截、创建槽 `start_error`、集群/列表页）。相对 1.2.2 **不必**换槽内 kin-kernel，也不要 `docker rm` 槽。

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.3
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.3` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。同一轮不要 restart 两次，不要 `stop` 后不拉起。

当前不在 1.2.2 的机器：先按下面「已部署机升级到 1.2.2」换槽内 kernel，再 `git checkout v1.2.3` 重启控制面。

## 已部署机升级到 1.2.2

1.2.2 要动两处：**控制面 Node**（`prepareCliHopBody` 剥 messages 断点）和槽内 **kin-kernel ELF**。槽容器不要 `docker rm`。

### 1. 控制面

更新 Node，**重启一次**。

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.2
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.2` → `npm ci`（web 有改再 `pnpm -C web build`）→ `systemctl restart vm2api` **一次**。同一轮不要 restart 两次，不要 `stop` 后不拉起。

### 2. 槽内 kin-kernel

换 `vms/<id>/cli-home/.kin/kin-kernel.bin` 和包装器 `kin-kernel`。用面板同步即可，**只同步 kernel，不是重装 wrap**：

```bash
curl -sS -X POST http://127.0.0.1:8787/api/panel/wrap-cli/sync \
  -H "Authorization: Bearer $VM2API_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"restart":true}'
```

`ids` 可限定槽；省略则全槽。等价拷贝：把仓内 `bin/kin-kernel` 装到该槽 `.kin/kin-kernel.bin`（755），并更新同目录包装器 `kin-kernel`。不要走 `POST /vms/:id/wrap-cli/repair` 当这次升级路径。

### 3. bounce kernel

每槽只留 **一个** kernel 进程，让它加载新 ELF。`sync` 带 `restart`（默认 true）一般会 bounce rust 槽。完成后确认槽内不是两个 `kin-kernel`。

未启动的槽下次 start 会铺新文件，不必先 sync。

---

交流见仓库 [README](../README.md)。
