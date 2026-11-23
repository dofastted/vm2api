# 蓝绿部署（不停服升级）

单容器部署每次升级都要重启控制面：旧进程排空、新进程启动，前置代理这段时间挂住请求（约 1–2 分钟），长流可能被砍。蓝绿部署让两个控制面（`blue` / `green`）在同一台机器上轮流接班：

- 切换约 1 秒，切换前后新请求照常返回；
- 旧实例在后台跑完手上的流再退出（最长 `BG_DRAIN_MS`，默认 60 分钟）；
- 任一步失败都会回到原状态，旧实例继续服务。

## 日常使用

```bash
deploy/bluegreen/bg-deploy.sh            # 部署 compose/.env 当前描述的版本（改 VM2API_IMAGE_TAG 或挂载后运行）
deploy/bluegreen/bg-deploy.sh --status   # 两个颜色是否在跑、角色、haproxy 状态
deploy/bluegreen/bg-deploy.sh --restart  # 普通重启当前颜色：带新迁移的版本用，会中断一次
```

- 部署命令在旧实例开始排空后就返回，收尾在后台进行，结果写进 `bluegreen/deploy.log`。要在前台等到收尾完成，加 `--wait`。
- 旧实例还没退出时再次部署会被拒绝（`still running`），等它跑完长流即可。
- 蓝绿安装后**不要再直接 `docker compose up -d`**：控制面容器会拒绝以单容器方式启动（日志 `vm2api_bluegreen_install`），避免和当前颜色抢锁。手工 compose 操作请照脚本里的 `dc()` 带齐 `-p` 和 `-f`。

## 工作原理

同一时刻只有一个 **leader**：持有数据目录锁、跑后台任务、改共享状态。另一个实例要么是 **standby**（已启动，等着接班，业务请求返回 503 `controller_standby`），要么是 **draining**（已交出领导权，只跑完手上的请求）。

| 步骤 | 做什么 |
|---|---|
| 1 预检 | compose 能渲染；挂进来的项目内文件都在；挂载的入口脚本可执行 |
| 2 迁移护栏 | 新镜像带新数据库迁移时 `exit 2`（两个版本不能共用一个库），改用 `--restart` |
| 3 standby | 新颜色以 `KIN_STANDBY=1` 启动：不拿锁、不跑后台任务、不改共享文件；预先连好节点链路、算好槽镜像摘要后报 `standby-warm` |
| 4 让权 | 旧实例收到 `SIGUSR1`：停后台任务、结束面板实时流、释放锁；监听不关 |
| 5 激活 | 新实例收到 `SIGUSR2`：拿锁、跑后台任务。重叠期间会破坏旧实例在途请求的维护先推迟（重建出口容器/远端 gate、重启槽内核、备份） |
| 6 切流量 | haproxy 新 `ready`、旧 `drain`（不断已有连接） |
| 7 排空 | 旧实例收到 `SIGTERM`，在后台跑完剩下的流后退出；正在跑的备份会被中止 |
| 8 收尾 | 旧容器退出后，后台 watcher 删掉它、把 haproxy 里的旧 server 设为 `maint`，给新实例 `SIGHUP`；新实例同步共享二进制、补做推迟的维护（`handover-exclusive`）。watcher 没跑完（被杀、宿主重启）时，新实例发现旧实例走了也会自己收尾（`handover-peer-gone`） |

重叠期间的保证：

- **锁**：只有 leader 持有数据目录锁；draining 实例的面板/管理接口返回 503 `controller_draining`。`SIGUSR1` 只对蓝绿实例（`KIN_STANDBY=1`）生效。
- **容量**：draining 实例把在途请求占用的槽、账号、席位写进 `data/run/handover-load.json`，新 leader 调度时算进去，不会把一个槽超发到两倍。
- **共享资源**：每个颜色有自己的 api-kernel socket；draining 实例关停时不删节点 relay socket；出口容器、gate、内核重启、备份都等旧实例退出后再做。
- **CRAG 授权文件**：新控制面先比对节点上已发布的订阅文件，相同就不重写；确实要更新时整组一次换上。
- **数据库**：SQLite WAL，两个进程可以并发读写；结构变化由迁移护栏挡住。

## 安装（一次性）

需要：

- 单机：两个颜色共用同一个安装目录和数据目录。
- `haproxy`（2.x）和 `socat`。haproxy 占对外端口（默认 8787），后端是 `blue` / `green` 两个 server；两个颜色自己的端口（默认 8788 / 8789）不要对公网开放。
- 宿主上要 `docker exec` 控制面的脚本（定时任务等）不要写死容器名，改读 `bluegreen/container`。

```bash
sudo apt install haproxy socat
sudo cp deploy/bluegreen/haproxy.cfg.example /etc/haproxy/haproxy.cfg   # 按需改地址/端口
```

先**不要**重启 haproxy：单容器还占着对外端口。控制面监听的不是 `127.0.0.1` 时（例如 `HOST` 是公网 IP），haproxy 后端地址和 `BG_HOST` 都写这个地址：

```bash
echo 'BG_HOST=203.0.113.10' > bluegreen/bg.env
deploy/bluegreen/bg-deploy.sh --bootstrap
```

`--bootstrap` 校验 haproxy 配置，停掉单容器，以 `vm2api-blue` 启动，再启动（或重载）haproxy 并指向 blue。这一次会中断一次。

## 配置

环境变量或 `bluegreen/bg.env`（环境变量优先）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `BG_HOST` | `127.0.0.1` | 探活和 haproxy 后端用的地址 |
| `BG_BLUE_PORT` / `BG_GREEN_PORT` | `8788` / `8789` | 两个颜色的监听端口 |
| `BG_DRAIN_MS` | `3600000` | 旧实例最长排空时间 |
| `BG_RESTART_GRACE` | `100` | `--restart` 等旧容器退出的秒数 |
| `BG_NAME` | `vm2api` | 容器/项目名前缀（`vm2api-blue` / `vm2api-green`） |
| `BG_SERVICE` | `vm2api` | compose 服务名 |
| `BG_COMPOSE_FILES` | `docker-compose.yml` [+ `docker-compose.override.yml`] | 基础 compose 文件 |
| `BG_HAPROXY_SOCK` | `/run/haproxy/admin.sock` | haproxy admin socket |
| `BG_HAPROXY_BACKEND` | `app` | backend 名，里面要有 `server blue` / `server green` |
| `BG_HAPROXY_STATE` | `/var/lib/haproxy/server-state` | server-state-file |
| `BG_HAPROXY_CFG` | `/etc/haproxy/haproxy.cfg` | `--bootstrap` 校验的配置 |
| `BG_HAPROXY_RELOAD` | `systemctl reload-or-restart haproxy` | `--bootstrap` 启动/重载 haproxy 的命令 |
| `BG_PROJECT_DIR` / `BG_STATE_DIR` | 脚本上两级 / `$BG_PROJECT_DIR/bluegreen` | 安装目录 / 状态目录 |

站点自己的额外挂载、环境（补丁、调试开关）放 `bluegreen/override.yml`，存在就叠在最后。`bluegreen/` 下的 `active`、`container`、`deploy.log` 由脚本维护。

## 失败与恢复

| 情况 | 脚本做什么 | 你要做什么 |
|---|---|---|
| 新颜色起不来 / 不是 standby | 删掉新颜色，旧实例原样服务 | 看 `docker logs <新容器>` |
| 旧实例对 `SIGUSR1` 没反应 | 同上 | 看旧实例日志 |
| 旧实例开始让权但没按时报告释放锁 | 删掉新颜色，**重启**旧实例做回 leader（中断一次） | 看旧实例日志 |
| 新实例没激活 | 同上 | 看新实例日志里的 `standby-activate-failed` |
| haproxy 切不过去（重试 5 次） | `exit 3`：新实例已是 leader，旧实例 draining 但照常接流量（面板 503） | 修好 haproxy 后 `bg-deploy.sh --cutover <旧色> <新色>` |
| 带新迁移的版本 | `exit 2`，什么都不动 | `bg-deploy.sh --restart` |

排查时看 `bluegreen/deploy.log`、`--status`，以及两个颜色日志里的事件：`standby-warm`、`handover-released`、`standby-activated`、`handover-peer-gone`、`handover-exclusive`。

## 验证

不改版本跑一次 `bg-deploy.sh` 就是一次完整演练（同版本切换）。建议在低峰、没有别的运维操作时做，同时用前置端口压一些短请求和长流，看有没有失败或卡顿。

## 回滚到单容器

```bash
c=$(cat bluegreen/active)
BG_COLOR=$c docker compose -p vm2api-$c down --timeout 100
sudo cp /etc/haproxy/haproxy.cfg.<备份> /etc/haproxy/haproxy.cfg   # 或停掉 haproxy，让单容器直接占对外端口
rm -f data/run/bg-active-* bluegreen/active bluegreen/container
docker compose up -d
```

## 已知限制

- 只支持单机。
- 重叠期间内存约翻倍，长流越多重叠越久。
- 旧实例退出前，新实例的出口/gate 重建、内核重启、备份都在排队；`BG_DRAIN_MS` 不宜比最长请求长太多。
- 带新迁移的版本不能蓝绿，只能 `--restart`。
- 首次 `--bootstrap` 会中断一次。
