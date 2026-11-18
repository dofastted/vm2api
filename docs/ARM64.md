# 实验性 Linux ARM64 控制平面部署

此方案在 ARM64 主机上原生运行 vm2api 控制平面，并通过 QEMU 运行现有
`linux/amd64` slot。可以直接使用发布的 ARM64 镜像，也可以从当前源码
checkout 本机构建。

## 发布物与命名

| 发布物 | amd64 | arm64 |
| --- | --- | --- |
| 控制面镜像（单架构） | `ghcr.io/dofastted/vm2api:vX.Y.Z-amd64` | `ghcr.io/dofastted/vm2api:vX.Y.Z-arm64` |
| 控制面镜像（多架构） | `vX.Y.Z` / `latest`，按拉取平台选择 | 同左，ARM64 构建通过时才含 arm64 |
| Release 附件 | 无后缀：`kin-kernel`、`cli-node`、`kin-worker` 等 | `kin-worker-linux-arm64`、`kin-egress-linux-arm64` |

`vX.Y.Z` 与 `latest` 只要 amd64 镜像推成功就会发布：ARM64 job 失败时这两个 tag
降级为 amd64 单架构，并在 release 流水线里留一条 warning，不会让它们停在上一个
两架构都通过的版本上。此时 ARM64 主机拉 `vX.Y.Z` / `latest` 会报
`no matching manifest`，须改拉 `vX.Y.Z-arm64`（一键脚本和面板本来就固定写该
单架构 tag，不受影响）。

无后缀附件保持 linux amd64，已部署的面板按原名下载 kernel / CLI。slot 内
kernel、OAuth 和控制面造机服务 `kin-computer` 仍使用 amd64/QEMU。本机 Docker
Claude 推理 CLI 使用镜像内单独构建的 ARM64 overlay；远程节点保持 amd64 发布物。
控制面 Go helper 也有原生 ARM64 版本，详见文末 Native CLI 小节。

版本参数可带架构后缀：`v1.2.3`、`v1.2.3-arm64`、`v1.2.3-aarch64` 都解析为
版本 `v1.2.3`；后缀只用于核对，与宿主架构不一致时一键脚本和面板都会拒绝。
一键脚本和面板在 ARM64 上写入 `VM2API_IMAGE_TAG=vX.Y.Z-arm64`，固定单架构
控制面镜像；一键脚本运行 Compose 时忽略宿主的 `DOCKER_DEFAULT_PLATFORM`
（槽位平台由控制面镜像自己设为 `linux/amd64`）。手动在设置了
`DOCKER_DEFAULT_PLATFORM=linux/amd64` 的 shell 里运行 Compose 会报平台不匹配，
不会改用 amd64 控制面。amd64 仍写不带后缀的多架构 tag，与已有安装一致。

## 支持范围与已验证情况

控制镜像中的 Node.js 22、Python、iptables、Docker 27 CLI，以及静态 Go
worker 和 egress 二进制均为 ARM64。已有 Rust kernels、OAuth 和 CLI 预编译
资产默认仍为 amd64；本机 Docker 推理 CLI 由 ARM64 overlay 替代，其他部分由 QEMU
执行。slot 默认平台仍是 `linux/amd64`。
构建从固定的 Ubuntu 24.04 amd64 stage 只提取 x86 payload 实际加载的 9 个库
（glibc 2.39 的 `ld-linux-x86-64.so.2`、`libc`、`libm`、`libdl`、`libpthread`、`librt`，
以及 `libgcc_s`、`libstdc++`、`libz`），约 6M，取代原先整个 48M 的
`/usr/lib/x86_64-linux-gnu`（镜像压缩后约 476MB → 461MB）。构建末尾运行
`deploy/check-x86-deps.py` 校验所有 x86 ELF 的 `DT_NEEDED` 闭包，缺库即构建失败；
`libz` 由 `kin-computer` 解包后的子进程在运行时加载，不在 `DT_NEEDED` 中，
由镜像 smoke 的计算机身份创建覆盖。Go builder 和最终控制平面 stage 使用 ARM64。

| 场景 | 验证状态 |
| --- | --- |
| Oracle Ampere、Ubuntu 24.04 主机上的 ARM64 控制平面 | 已在现有部署验证 |
| 该部署中的 Ubuntu amd64 Claude slot | 已在现有部署验证 |
| 原生 ARM64 远程节点 | 未验证 |
| Codex 模型真实请求、其他 guest 镜像 | 未验证 |
| x86 CLI 载荷（`image-wrap-cli/cli-node`）在 qemu-user 下执行 | **不可用**，见下 |
| 主机重启后的恢复、性能与容量 | 未验证 |

这些结果只覆盖上述环境，不构成其他 ARM 主机、镜像或负载的兼容性承诺。
**每个 Docker daemon 仅运行一个部署**：slot 使用 `kin-01` 等全局容器名称，
即使为控制容器指定不同名称，也无法隔离 slot。已有 x86 部署的主机不要直接
叠加此 override；迁移应先停止原控制器并保留其状态和密钥。

### x86 CLI 载荷在 qemu-user 下不可执行

x86 `cli-node` 经 qemu-user 执行时，Bun 的 JavaScriptCore 在 `LocalAllocator::allocateSlowCase`
抛 `MemoryExhaustion` 断言，QEMU 收到 SIGABRT，`--version` 都打不出来。**已排除**：缺库或架构
错配（`check-x86-deps.py` 闭包校验与 `ld-linux --list` 均通过）、宿主内存不足（该容器无
`--memory` 限制）、大页内核（`prepare-arm64.py` 的 `page-size` 通过，页大小 4096）。由于
`ld-linux-x86-64.so.2` 本身就是在 QEMU 下执行的 x86 ELF 且运行正常，故障特定于 JSC 预留
大块连续虚拟地址空间（gigacage / JIT 区），不是 QEMU 执行能力问题；缓解方向是关 JIT 或限制
gigacage，而非加内存。

该路径只服务 Codex、KVM 与远程 slot（见 §Native CLI for local ARM64 Docker slots 的选择
逻辑），均为上表未验证项，故 `test/deploy/smoke_arm64_image.py` 不执行它、只校验 ELF。要恢复
执行须先改支持矩阵。本地 ARM64 Docker 的 Claude slot 不受影响，走原生 overlay。

## 主机要求

- Linux `aarch64` 主机，**4K 页内核**（见下表）。
- `binfmt_misc` 已挂载并启用；init 为 systemd（`systemd-binfmt`）或 OpenRC（`binfmt` 服务）。
- 直接在宿主上运行，不在 LXC/Docker 容器里（binfmt handler 属于宿主内核）。
- 已安装 Git、Python 3、Docker Engine 20.10 或更新和 Compose V2。
- 当前用户可访问 Docker daemon；准备脚本需要 root 或可用的 `sudo -n`。
- 可访问构建镜像来源，并具备运行 amd64 slot 所需的内存、磁盘和 CPU。

`prepare-arm64.py` 在改动主机之前检查以上各项，所有不满足项一次列出并附处理建议：

| 检查项 | 失败原因 | 处理 |
| --- | --- | --- |
| `page-size` | 16K/64K 页内核。Bun 尚未支持非 4K 页（oven-sh/bun#17627），qemu-user 大页未验证 | 换 4K 页内核：Ubuntu 用 `linux-generic` 而非 `linux-generic-64k`；Raspberry Pi 5 在 `config.txt` 写 `kernel=kernel8.img`；Asahi Linux 不支持 |
| `container` | 在容器内运行 | 到宿主上运行 |
| `binfmt_misc` | 未挂载或全局禁用 | `modprobe binfmt_misc && mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc` |
| `init` | 既无 `systemd-binfmt` 也无 OpenRC `binfmt` 服务 | 重启后注册会丢失，不支持 |
| `other-x86-handlers` | 另一个已启用的 handler（如 `qemu-x86_64-static`）也匹配 x86_64 ELF | `echo -1 > /proc/sys/fs/binfmt_misc/<名字>`，并移除其 binfmt.d 条目或软件包 |

`binfmt.d` 一项只做说明：发行版 `qemu-user-binfmt` 的 `/usr/lib/binfmt.d/qemu-x86_64.conf`
会被同名的 `/etc/binfmt.d/qemu-x86_64.conf` 覆盖，脚本不改动发行版文件。

Docker 的安装方式参见 [Docker Engine 安装文档](https://docs.docker.com/engine/install/)。
此 override 不强制设置 CPU 或内存上限；容量应按实际 slot 数量和负载规划。

## 一键安装（推荐）

与 x86 相同的命令，脚本按 `uname -m` 识别架构：

```sh
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
sudo bash /opt/vm2api/deploy/install.sh status
```

在 ARM64 上脚本额外下载 `deploy/prepare-arm64.py`，启动前准备 QEMU handler
（见下一节），然后拉取 `-arm64` 镜像。没有 ARM64 发布的旧版本会明确报错，
不会回退到 amd64 镜像。`status` 显示宿主架构、当前镜像 tag，并在 ARM64 上附带
`prepare-arm64.py --check` 的主机检测结果。

预构建镜像安装应使用 `docker-compose.yml`（及可选的 `docker-compose.override.yml` /
自定义 overlay，**不要**含 `docker-compose.arm64.yml`）与
`VM2API_IMAGE_TAG=vX.Y.Z-arm64`。若 `.env` 的 `COMPOSE_FILE` 仍含
`docker-compose.arm64.yml`（例如先跑过 `deploy/init-arm64-env.py`），会叠加
源码构建 override（默认镜像是 `vm2api-arm64-control:local`），而不是拉 ghcr
的 `-arm64` 控制面。

自 #746 起，**仅当执行新版** `deploy/install.sh`（`install` / `upgrade`）时，
脚本会从 `COMPOSE_FILE` **去掉** `docker-compose.arm64.yml` 这一项，其它 overlay
保留；若去掉后为空则写回 `docker-compose.yml`。**不会**为空的 `COMPOSE_FILE`
写入默认值（避免 Compose 不再自动加载 `docker-compose.override.yml`）。
**面板一键更新不会改 `.env`**；若仍用旧版 `install.sh` 升级，当次仍是旧逻辑，
需再拉新版脚本执行一次 `upgrade`/`install`，或手动编辑 `COMPOSE_FILE`。

## 准备主机

一键脚本会自动执行；源码构建时在仓库根目录手动执行：

```sh
python3 deploy/prepare-arm64.py
python3 deploy/prepare-arm64.py --check
```

`--check` 只读取状态。安装使用固定的 `tonistiigi/binfmt` QEMU 10.2.3 资产，
只切换 `qemu-x86_64` handler。脚本检查受管理路径，遇到符号链接或不同内容
时拒绝覆盖。安装失败时恢复原内核 handler 描述及启用状态，
并只移除本次新安装的文件。发行版的 binfmt 数据库和其他架构 handler 不参与此事务。

持久化：systemd 主机由 `systemd-binfmt.service` 开机读取 `/etc/binfmt.d`。OpenRC 主机
（如 Alpine）读取同一文件；脚本直接写 `register` 完成本次注册，并在 `binfmt` 服务不在
boot runlevel 时执行 `rc-update add binfmt boot`（失败回滚时撤销本次新增）。`--check`
在 OpenRC 上缺少该 runlevel 时报错。

控制容器启动时会试跑一个静态 amd64 helper；宿主 handler 丢失（例如重启后未恢复）时
日志提示重新运行 `prepare-arm64.py`，但不阻止面板启动。

QEMU 下 slot 进程的 `/proc/<pid>/exe` 指向模拟器，程序路径在 `argv[1]`。
控制面在终止 slot 数据面进程和判断 PID 1 拓扑时按此识别。

## 源码构建

为新部署创建 `.env`：

```sh
python3 deploy/init-arm64-env.py
```

默认端口为 `8787`，控制容器名为 `vm2api`，仅绑定 `127.0.0.1`。可用
`--port`、`--container-name`、`--bind-host` 调整这些值。若要绑定其他地址，
应先确认该地址的访问范围和主机网络配置；IPv6 绑定需要宿主机启用 IPv6。

初始化器以排他创建方式写入权限为 `0600` 的 `.env`，生成管理密码、API key
和数据库密钥，且不输出凭据。它同时写入
`COMPOSE_FILE=docker-compose.yml:docker-compose.arm64.yml` 与
`VM2API_HOST_ROOT=<仓库绝对路径>`：裸 `docker compose` 和面板一键更新都
因此使用 ARM64 override 与正确的宿主目录。已有 `.env` 会保留，缺这两项时
脚本提示需要补的值；面板更新发现 ARM64 源码安装缺 `COMPOSE_FILE` 会拒绝
执行，避免以基础服务启动到 `./vms`、`./data`。用本地编辑器查看
`VM2API_ADMIN_PASSWORD` 后登录；不要把 `.env`、凭据或会话信息放入 PR。

```sh
docker compose build vm2api
docker compose up -d vm2api
```

一键脚本 `--from-source` 在 ARM64 上同样写入这两项。

override 的默认本地镜像是 `vm2api-arm64-control:local`，可通过
`VM2API_ARM64_IMAGE` 改名。Compose 使用 `deploy/Dockerfile.arm64-control`
构建 `linux/arm64` 控制镜像；`DOCKER_DEFAULT_PLATFORM=linux/amd64` 用于
控制平面启动的 slot。amd64 集群资产置于 `/opt/vm2api/cluster-bin-amd64`。

源码构建的持久目录位于仓库下的 `.local/arm64/`（一键镜像安装与 x86 相同，
在安装目录的 `vms/`、`data/` 等）：

| 目录 | 用途 |
| --- | --- |
| `vms` | slot 相关持久状态 |
| `data` | 控制平面数据 |
| `bin` | 运行时二进制目录 |
| `share` | 共享文件 |
| `config` | 运行配置 |

仓库原有 `bin/` 中的 amd64 资产会保留。备份时同时保留 `.env` 和这些持久
目录，数据库密钥必须与原数据库对应。

## 检查状态

在安装目录或仓库根目录执行（`.env` 的 `COMPOSE_FILE` 已选好 Compose 文件）：

```sh
docker compose ps
docker compose logs --tail=100 vm2api
docker compose exec vm2api node -p process.arch
python3 deploy/prepare-arm64.py --check
```

Node.js 应返回 `arm64`。随后在本地浏览器打开 `http://127.0.0.1:8787`，
登录并检查账户、slot 和实际请求。使用自定义端口时替换地址中的端口。
容器启动或架构检查成功，不能代替真实模型请求验证。

## 更新源码与镜像

一键安装用 `install.sh upgrade` 或面板“一键更新”，二者都保留架构后缀。

源码构建先保存当前源码 revision，并备份 `.env` 和持久数据。更新应在干净的源码
checkout 中进行；有本地修改时先审查并保留这些修改。

```sh
git pull --ff-only
docker compose build vm2api
docker compose up -d --no-deps vm2api
```

更新保留原有挂载目录与密钥。完成后重复状态检查及之前成功的实际请求。
基础依赖的固定 digest 应单独审查和维护，不随应用 `VERSION` 自动刷新。

## 故障恢复与迁移

QEMU 准备失败时先阅读脚本错误，再运行 `--check` 核对恢复后的状态；不要
手动覆盖发行版的 binfmt 文件。应用故障可恢复已保存的源码 revision，重新
构建并用相同 Compose 参数启动；数据库发生格式变更时，按对应版本的迁移
要求恢复匹配的数据备份，避免旧代码直接读取不兼容数据库。

已有部署改用此方案时，先核对旧控制器的数据库、密钥、配置和各目录挂载，
备份后停止旧控制器，再制定与新挂载对应的迁移步骤。不要任意移动仍在使用
的数据库，也不要同时启动两个会管理相同 slot 的控制器。成功验证登录、
账户、slot 与实际请求后，再决定是否保留旧部署作为恢复入口。


## Native CLI for local ARM64 Docker slots

The ARM control image now builds a native CLI overlay. The Rust kernel and
OAuth/cc-node payloads remain amd64/QEMU; only the long-lived inference CLI
runs on native ARM64 Bun. This avoids a reproducible `native stdin write
blocked for 10s` failure while sending large frames to the emulated CLI.

`deploy/arm64-cli.json` pins the existing CLI, its embedded JavaScript, Bun
and the unpacking tool by SHA-256. `deploy/build-native-cli.py` extracts only
that exact source bundle, without changing its business logic, and packages
the matching ARM64 Bun plus a private ARM64 glibc loader/library directory.
Build tools are not installed globally. No account, token, live request or
customer text is an input to this build. Extracted sources and binaries are
build artifacts, not tracked repository files.

The portable `share/wrap-cli` template remains amd64. `KIN_NATIVE_CLI_ROOT`
selects the image-owned overlay only for local Linux ARM64 Docker Claude
slots. Remote nodes (including amd64 nodes), KVM, Codex and amd64 controllers
keep their existing payload selection. Source mismatch or a damaged overlay
fails closed before changing a slot. Capturing an ARM-native slot as the
portable template is rejected. A changed runtime participates in the normal
kernel-sync/restart detection.

When updating the pinned CLI payload, also review and update the native
source/runtime manifest. The build and runtime checks deliberately reject an
old native overlay against a new portable CLI; do not bypass the check or
silently reuse a previous release's extracted source. Control-container startup
still refreshes the portable assets normally; no persistent bind override of
`image-wrap-cli/cli-node` is needed. Remove any earlier host-specific native CLI
bind override before deploying this integrated image, after saving its rollback
configuration and confirming the replacement native image has passed tests.

CI builds the ARM control image and uses a network-disabled synthetic upstream
for 15/32 MiB requests, four concurrent 15 MiB requests and cancellation/slot
recovery. This does not consume a real account. It does not certify the full
128 MiB concurrency limit, other guest images or long-duration performance.
Production upgrades must still drain requests, preserve `.env`, `routing.json`,
`vms/` and `data/`, retain a consistent database backup, and verify a real model
request. Recover by deploying the saved previous image with the same volumes;
do not restore an old database over new traffic without a separate data decision.
