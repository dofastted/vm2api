# 蓝绿部署（不停服升级）

单容器部署每次重启要停掉控制面：旧进程排空、新进程启动，这段时间前置代理挂住请求（实测约 1–2 分钟），长流可能被砍。蓝绿部署让两个控制面短暂并存：

- 新请求**不挂起**：切换本身约 1 秒，切换前后请求照常返回；
- 旧实例在后台跑完手上的流（最长 `BG_DRAIN_MS`，默认 60 分钟），跑完自己退出；
- 任一步失败，新实例被删掉，旧实例继续服务。

同一时刻只有一个 **leader**：持有数据目录锁、跑后台任务、改共享状态。另一个实例要么是 **standby**（启动好了，等着接班），要么是 **draining**（交出了领导权，只把手上的请求跑完）。

## 需要什么

- 单机：两个颜色跑在同一台宿主、同一个安装目录、同一个数据目录。
- `haproxy`（2.x）和 `socat`：haproxy 占对外端口（默认 8787），后端是 `blue` / `green` 两个 server；脚本经 admin socket 切换。
- 两个颜色各自的端口（默认 8788 / 8789）不要对公网开放，防火墙只放行对外端口。
- 宿主上要 `docker exec` 控制面的脚本（定时任务等）不要写死容器名 `vm2api`，改读 `<状态目录>/container`。

## 文件

| 文件 | 作用 |
|---|---|
| `deploy/bluegreen/bg-deploy.sh` | 部署脚本（`--bootstrap` / 默认部署 / `--wait` / `--status`） |
| `deploy/bluegreen/compose.bluegreen.yml` | 叠在 `docker-compose.yml`（和 `docker-compose.override.yml`）之后：按颜色设容器名、端口、standby、排空时长、各自的 api-kernel socket |
| `deploy/bluegreen/haproxy.cfg.example` | haproxy 配置样例 |
| `bluegreen/bg.env` | 可选，站点配置（见脚本头部的 `BG_*` 列表） |
| `bluegreen/override.yml` | 可选，站点额外的 compose 覆盖（补丁挂载、调试开关），叠在最后 |
| `bluegreen/active`、`bluegreen/container`、`bluegreen/deploy.log` | 当前颜色、当前容器名、部署日志（脚本维护） |

状态目录默认是安装目录下的 `bluegreen/`，可用 `BG_STATE_DIR` 改。

## 首次切换（一次性，会中断一次）

```bash
sudo apt install haproxy socat
sudo cp deploy/bluegreen/haproxy.cfg.example /etc/haproxy/haproxy.cfg   # 按需改地址/端口
sudo mkdir -p /var/lib/haproxy && sudo systemctl restart haproxy
```

控制面监听的不是 `127.0.0.1`（例如 `.env` 或 override 里 `HOST` 是公网 IP）时，haproxy 的后端地址和 `BG_HOST` 都要写这个地址：

```bash
echo 'BG_HOST=203.0.113.10' > bluegreen/bg.env
```

然后：

```bash
deploy/bluegreen/bg-deploy.sh --bootstrap
```

它停掉单容器 `vm2api`，以 `vm2api-blue` 启动，haproxy 指向 blue。此后**不要再直接 `docker compose up -d`**：两个颜色是独立的 compose 项目（`-p vm2api-blue` / `-p vm2api-green`），手工操作请照脚本里的 `dc()` 带齐 `-p` 和 `-f`。

## 部署

改 `.env` 里的 `VM2API_IMAGE_TAG`（或 override），然后：

```bash
deploy/bluegreen/bg-deploy.sh
```

脚本按顺序做：

1. **预检**：compose 能渲染；挂进来的项目内文件都存在；挂载的入口脚本可执行。
2. **迁移护栏**：新镜像比旧镜像多了数据库迁移时 `exit 2`。两个版本不能共用一个库，这一版请用普通重启部署（见下）。
3. **standby 启动**：新颜色以 `KIN_STANDBY=1` 起来，不拿锁、不跑后台任务、不改共享文件，`/healthz` 报 `role: standby`，业务请求返回 503 `controller_standby`。它预先连好节点链路、算好槽镜像摘要，完成后打日志 `standby-warm`（脚本最多等 90 秒）。
4. **旧实例让权**（`SIGUSR1`）：停后台任务、结束面板实时流、释放数据目录锁；监听不关，手上的请求继续跑。
5. **新实例激活**（`SIGUSR2`）：拿锁、跑后台任务。和旧实例重叠期间，会破坏旧实例在途请求的维护先记下不做：重建出口容器/远端 gate、因 wrap 变化重启槽内核、备份。
6. **切流量**：haproxy 新 `ready`、旧 `drain`（不断已有连接）。
7. **旧实例排空**（`SIGTERM`）：在后台跑完剩下的流后退出；正在跑的备份会被中止。
8. **收尾**：旧容器退出后，后台的 watcher 删掉它、把 haproxy 里的旧 server 设为 `maint`，给新实例 `SIGHUP`；新实例同步共享二进制、补做第 5 步推迟的维护，打日志 `handover-exclusive`。

`--wait` 在前台等到第 8 步做完；默认 watcher 在后台跑，结果写进 `deploy.log`。旧实例还没退出时再次部署会被拒绝（`still running`）。

`--status` 显示两个颜色是否在跑、角色、haproxy 状态。

### 失败时

- 第 3–4 步失败：删掉新颜色，旧实例原样服务。
- 第 5 步失败（新实例没激活）：删掉新颜色，**重启**旧实例让它重新做 leader，这一次会像普通重启一样挂住请求。

### 带新迁移的版本

脚本 `exit 2` 时用普通重启：

```bash
c=$(cat bluegreen/active)
BG_COLOR=$c BG_PORT=$([ "$c" = blue ] && echo 8788 || echo 8789) \
  docker compose -p vm2api-$c -f docker-compose.yml -f docker-compose.override.yml \
  -f deploy/bluegreen/compose.bluegreen.yml up -d
```

（有 `bluegreen/override.yml` 时也要带上；没有 `docker-compose.override.yml` 时去掉那一项。）haproxy 的 retries 会在重启期间挂住请求。

## 重叠期的保证

- **锁**：同一时刻只有 leader 持有数据目录 flock；draining 实例的面板/管理接口返回 503 `controller_draining`。
- **调度容量**：draining 实例把在途请求的槽、账号、席位写进 `data/run/handover-load.json`，新 leader 调度时把它算进占用，不会把一个槽超发到两倍。
- **共享资源**：每个颜色有自己的 api-kernel socket；draining 实例关停时不删节点 relay socket；出口容器、远端 gate、内核重启、备份都等旧实例退出后才做。
- **CRAG 授权文件**：控制面启动后第一次准入会先比对节点上已发布的订阅文件，内容相同就不重写（重写期间完成的流会被槽判授权无效）。
- **数据库**：WAL，两个进程并发读写；迁移护栏挡住结构变化。

## 回滚到单容器

```bash
c=$(cat bluegreen/active)
BG_COLOR=$c docker compose -p vm2api-$c down --timeout 100
sudo cp /etc/haproxy/haproxy.cfg.<备份> /etc/haproxy/haproxy.cfg   # 或直接停掉 haproxy
rm -f data/run/bg-active-* bluegreen/active bluegreen/container
docker compose up -d
```

## 已知限制

- 只支持单机：两个颜色共用一个数据目录。
- 重叠期间内存占用约翻倍（两个控制面），长流越多重叠越久。
- 排空中的旧实例退出前，新实例的出口/gate 重建、内核重启、备份都在排队；`BG_DRAIN_MS` 不宜设得比最长请求长太多。
- 带迁移的版本不能蓝绿。
