# 部署

推荐 **Docker Compose**，**拉预构建镜像**，不在你的机器上构建。安装目录任意（下文用 `/opt/vm2api`）。

## 机器

Ubuntu 24.04 + Docker Engine。Debian 12 上槽内核常常起不来。

最少三个环境变量，写在仓库 `.env`（`chmod 600`），不要进 git：

```bash
VM2API_API_KEY='很长的随机串'
VM2API_ADMIN_PASSWORD='面板密码'
VM2API_DB_SECRET='再一串'
```

抄本：[deploy/env.example](deploy/env.example)。`VM2API_*` 优先于 `KIN_*`。

宿主机开了 UFW / firewalld 且入站默认拒绝时，必须先放行槽出口网关，见下文「防火墙」。否则槽内请求全部 `502 incomplete_response`，面板代理探测却显示正常。

## 该看到什么容器

| 容器 | 说明 |
|---|---|
| `vm2api` | 控制面。Compose **只起这一个** |
| `kin-<槽>` | 每个**已启动**的槽 1 个 |
| 没有 | 未启动的槽；同机其它项目的 postgres 等 |

不是一个父容器里多个子进程。

槽位默认内存上限为 `512m`，在面板「规格」或 `routing.json` 的 `vm.memory` 配置（`256m` / `512m` / `1g` / `2g` / `4g` / `8g` / `16g`）。创建时可按槽覆盖，结果写在该槽 `vm.machine.memory`。已不再读取 `KIN_VM_MEMORY`。低于 1G 时，常驻 native host 与临时官方 CLI 同时运行可能 OOM；额度 API 探测本身不应额外启动推理 CLI。已有容器不会因控制面升级自动改内存，可在核对宿主余量后使用面板在线扩容，不重建容器。面板成功须 Docker HostConfig 的 memory 与 memory-swap 均等于请求值；若容器内可读 cgroup 限额（cgroup v2 的 `memory.max`，否则 v1 的 `memory/memory.limit_in_bytes`），则须与请求一致；读不到路径或值为 `max`/无上限哨兵时，在 HostConfig 已匹配的前提下跳过 cgroup 核对。`docker update` 成功后若后续校验失败，控制面会用扩容前的 memory/swap **回滚**容器限额且**不写** vm 配置；回滚失败时 API 会提示手动核对。内核每次准入按当前 cgroup 限额动态计算阈值，并按请求实际序列化大小限制在途负载。单次请求的 CLI 内存突增仍可能超过 512 MiB，准入不保证任意请求都能在此上限内运行。

KVM 槽需要宿主 `/dev/kvm` 可读写（控制面在容器内时，用一次 `--device /dev/kvm` 的探测容器确认）。runner 降权给槽位用户跑 QEMU 时会带上 `/dev/kvm` 的设备组，属组与槽位主 GID 不同也能用。已有 KVM 槽要更新 `kin-kvm-*` 镜像并重建一次。没有 KVM 时不要在生产打开 `vm.allow_tcg`：那是 TCG 软件模拟，仅供测试。

KVM 的 `kin-guest-exec` 前台命令由调用方控制执行时限，包含官方 Claude Code 初装的 hello / 用量步骤；SSH 建连仍保留 3 秒超时。后台启动（`-d`）保留 8 秒上限，超时返回 `124` 并提示命令启动超时，SSH 失败才提示 `guest ssh unavailable`。修复旧 runner 的前台 8 秒限制需要更新 `docker/kin-kvm` 镜像并在维护窗口按官方流程重建相关 KVM 容器；只升级控制面不会替换已运行容器内的脚本。不要重置或删除槽的家目录、凭据、指纹与虚拟磁盘。

出现 `native stdin: Broken pipe` 时同时检查容器 OOM 事件与 CLI 子进程，不能只看 Rust PID 1 是否存活。CLI 退出或输出管道关闭后，内核必须清零 `cli_pid` / `ready_slots`、终止在途请求并拒绝新任务，由宿主 watchdog 恢复槽；不重放已发送的推理请求。

CRAG V2 的资产、工作区和设备授权目录分别使用 Linux 私有 run 映射下的 `/run/kin/crag-native-assets`、`/run/kin/work`、`/run/kin/crag-license`；配置重写不能改回 DrvFS 家目录。目录归槽 UID 所有、权限 `0700`，设备文件/注册码为 `0600`。本机 Docker 创建 CRAG V2 容器时加载 `src/lib/vm/crag-v2-seccomp.json` 的默认拒绝策略，仅增加 `unshare(0x10020000)` 和 `mount` 标志 `0x44000` / `0x1000` / `0x1021` 所需例外；继续非 root、cap-drop ALL、no-new-privileges，不允许额外网络命名空间。创建/启动流程仅对缺少该策略的旧容器按需保留数据重建，已有精确策略的容器复用；单纯 Docker restart 不会更改 seccomp。不要用 privileged、cap-add SYS_ADMIN 或 seccomp=unconfined 替代。可用 `docker exec <槽容器> unshare --user --map-root-user --mount -- /home/kincli/.kin/crag-v2/claude-code-2.1.321/claude --version` 做无模型流量探针；仅看内核 PID 1 或空闲健康状态不足以证明 CLI 能启动。

挂 `docker.sock`，`network_mode: host`。安装目录不再限定 `/opt/vm2api`：控制面自省 `docker inspect vm2api` 的 Mounts，把槽的 `-v` 源换算成宿主路径；也可用 `VM2API_HOST_ROOT` 显式指定。

「内核」页拉取的二进制以独立缓存发布：默认内核使用 `share/wrap-cli-releases`，CRAG 使用 `share/crag/kernels/v2` 的 packages 子目录及原子 `current-<arch>.json` 指针。完成对应包校验后才切换，保留当前与上一快照；无指针时沿用出厂包，已有指针损坏时拒绝而不静默降级。只读出厂挂载无需改权限。镜像默认的 `KIN_KERNEL_BIN=<项目>/bin/kin-kernel` 支持更新，真正外部自定义路径覆盖仍固定，不会被拉取替换。amd64 镜像首次启动会把镜像内完整签名 CRAG 出厂包校验后落入空的 `share/crag/kernels/v2/amd64`，提供首次信任锚；已有出厂包、下载指针和显式 `KIN_CRAG_V2_ROOT` 覆盖不改写，后续包必须使用相同发行公钥。发布源缺少授权归档时可继续使用本地有效包，但自动获取返回失败，不能用 legacy ELF 代替。

### CRAG V2 二进制更新

vm2api 从自己的公开 payload Release 下载 `crag-v2-licensed-amd64.tar.gz` 签名加密包，无需私有供应仓凭据。「内核」页默认提供 3.1.4 标准版，也可选择 3.1.2、3.1.3 原发行和 Compact 修复版。这些发行使用同一授权身份，已激活的槽不必重新输入许可或增加占位就能升降级。下载只更新共用下载指针，不影响运行中的槽；确认安装后才应用。启用 `CRAGH2` 后不要回滚到 3.1.1 及更早内核。

宿主配额按同时运行和正在启动的订阅槽计算，不按已下载的版本数计算。原槽更新只占一个位置；正式停机后保留原绑定，其他槽需要座席时才回收已确认停止且不在操作中的 `CRAGH2` 座席。机况未知不算已停止；`CRAGH1` 不支持回收。单设备许可不消耗订阅槽。由 vm2api 负责受管 CRAG 的重启，避免 Docker 自行恢复绕过槽位准入。

旧授权资产只作历史恢复：`payload-2026.11.16-crag-3.1.2-legacy` 使用不同载荷密钥，现行官方版本不接受该密钥的历史 `CRAGU1`、`CRAGL1` 或 `CRAGS1`。为仍有效的旧许可可通过明确完整标签保留兼容包；常规更新不会预先重签或撤销旧槽。`manifest.version` 的 `v2` 是协议族，实际下载发行版见指针的 `release.payload_tag`。

amd64 默认一键安装/升级会自动完成出厂包初始化和最新版获取，不需要先在面板手动拉取。也可在服务器独立更新，不升级或重启控制面：

```bash
sudo bash /opt/vm2api/deploy/install.sh crag-update --crag-version payload-2026.11.17-crag-3.1.4
# 仅用于历史授权恢复；正常面板版本列表不提供这个版本
sudo bash /opt/vm2api/deploy/install.sh crag-update --crag-version payload-2026.11.16-crag-3.1.2-legacy
# 省略 --crag-version：从 vm2api 公开 payload Release 选最新完整签名包
sudo bash /opt/vm2api/deploy/install.sh crag-update
```

需要包含 `scripts/seed-crag.mjs`、`scripts/update-crag.mjs` 的消费端源码/镜像；只下载一个新版 shell 到旧镜像不足以补齐 Node 更新器。支持已有 Docker 控制面和主机 Node 部署；读取进程环境或 `.env` 的 `VM2API_API_KEY` / `KIN_API_KEY`。无 `.env` 的主机 systemd 部署可由 root 从既有 `vm2api.service` 进程环境读取 key/port，不复制或打印完整环境；也可用进程环境 `PORT` 指定本地控制面端口。普通 amd64 `install` / `upgrade` 即使没有 CRAG 缓存也执行获取；`--no-start` / `--no-sync-wrap` 跳过，显式 `crag-update --no-start` 报错。当前 CRAG 发行包仅支持 amd64，ARM64 一键安装明确提示并跳过 CRAG 获取，不影响原有安装路径。缺少有效出厂包时，拉取只信任随官方 vm2api 交付的 `deploy/payload.json` 固定公钥摘要；未携带此摘要的部署仍需可信出厂包。

更新器先下载并验证签名包，再把指定版本交给运行中的控制面安装。控制面使用各槽的实际部署位置，逐槽暂停调度、排空在途请求，并确认运行槽的 `active_requests`、`queued`、`continuations` 均为 0 后才重启，不需要全局暂停。本机槽确认安装文件与运行中的 memfd 都已是目标版本时，不会再次安装；集群槽由控制面在节点安装并报告结果，不使用本机容器或文件校验远端状态。

仅更新已选用 CRAG V2 的槽；已停止的槽只换包，不开机。非 CRAG 本地槽若留有 `crag-v2` 缓存，仅原子更新该目录，不碰 wrapper、配置和进程；非 CRAG 集群槽、无副本的槽和 Codex 槽标为 `skip`。macOS 原生节点不支持此安装方式。报告逐槽列出 `sync` / `cache` / `skip`。

下载或信任校验失败不覆盖旧包、不停槽。更新锁为 `share/crag/kernels/v2/.update-lock`；强杀后须先确认后台安装和更新进程均已结束，再清理锁。失败返回非零，批量安装可能已更新其中部分槽；结果不明时先核对槽位状态，不要重复提交。回滚须选择保留的前一完整签名包并重新安装；仅改下载指针不会回滚槽内运行版本。

当前重装接口在同一槽生命周期锁内排空请求、停止服务、关闭 Docker 自动重启、替换文件并验证重启；成功报告 `restarted: true`、`stopped: false`、`status: running`，无需再发一次启动请求。失败可能保持 stopped，须按逐槽错误和实际运行状态处理，不能用 HTTP 200 判断成功。较旧控制面可能只安装并保持停止，按实际部署版本核对；详见[托管节点内核排障与验收](managed-kernel-troubleshooting.md)。安装不主动重置家目录、凭据、指纹或工作区；启动阶段若需更新容器布局可能保留持久目录重建，不能承诺容器 ID 恒定。

CRAG 历史密钥不匹配且无法安全迁移时，在停槽前拒绝安装。

## 安装

**一键（推荐）：**

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash
```

脚本只下载 `docker-compose.yml` / `.env.example` / `VERSION`（不 clone 仓库），补全 `.env`（`chmod 600`），然后 `docker compose pull && up -d`。`.env` 缺失或 `VM2API_ADMIN_PASSWORD` 为空时写入默认管理台 **`admin` / `123456`**（已有密码不覆盖）。空的 `VM2API_API_KEY` / `VM2API_DB_SECRET` 会生成随机值。登录：`http://<ip>:8787/cc#/login`。以后：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
sudo bash /opt/vm2api/deploy/install.sh check
sudo bash /opt/vm2api/deploy/install.sh changelog
```

保留 `.env` / `vms/` / `data/`。一键更新会把新版 `share/wrap-cli`（包括 `kin-kernel.bin`、`cli-node`、`cc-node`）同步到本机槽并重启槽内 dataplane；集群槽使用同一份二进制加上当前 Go `kin-worker` 遥测重建槽位镜像，再换容器，不改凭证和指纹。如需暂时跳过可加 `--no-sync-wrap`。管理台 **设置 → 关于** 可复制同一条命令、看 changelog。指定版本：`--version v1.2.22`。槽位重建可选「保留原数据」或「重建新特征」。

在 Ubuntu 24.04 等使用 apt 的 Linux amd64 宿主上，一键安装和升级会补齐缺少的 Gemini 宿主依赖，并自动准备 [Gemini 默认组件](gemini-host.md)。管理员在「导入 → Gemini」输入兑换码激活；已有 Gemini 载荷不会被替换。`--no-start` 不安装依赖，也不下载或启动 Gemini。

首次登录后，在「用户」中找到当前管理员，点击「改密码」设置至少 8 位的新密码。默认密码管理员也会写入用户列表；修改后数据库密码优先，重启或更新不会被 `.env` 中的旧密码覆盖。

**ARM64 主机（实验性）**：同一条命令按 `uname -m` 自动选择 `vX.Y.Z-arm64` 控制面镜像并准备 QEMU（slot 仍是 amd64）。`--version` 可带 `-amd64` / `-arm64` 后缀，须与宿主一致。详见 [ARM64.md](ARM64.md)。

**手动（同样只拉镜像）：**

```bash
mkdir -p /opt/vm2api && cd /opt/vm2api
curl -sSLO https://raw.githubusercontent.com/dofastted/vm2api/main/docker-compose.yml
curl -sSL -o .env https://raw.githubusercontent.com/dofastted/vm2api/main/.env.example
chmod 600 .env
# 空密码默认 admin / 123456；API key / DB secret 为空时入口会生成

docker compose pull
docker compose up -d
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

`bin/` 与 `share/wrap-cli` 由镜像入口写入挂载目录，`src/config` 缺文件时用镜像内默认值补齐。

同一安装目录只能运行一个控制面，不要让宿主机 `vm2api.service` 和 Compose 控制面共用其 `data/` 同时运行。即使 HTTP 端口不同，槽位出口仍使用同一组监听端口。Linux 源码直跑需要 `flock`（`util-linux`，官方镜像已包含）；重复启动会报 `vm2api_control_plane_already_running`，不会接管已有出口。首次从未使用该锁的旧版本迁移时，先停旧控制面再启动新的；不要靠换 HTTP 端口做并行切换。

Docker 入口在覆盖共享二进制前加锁，并把同一把锁交给 Node。`KIN_AUTO_SYNC_WRAP=1` 时，共享内核文件有变化才会在该 Node 实例开始监听后同步槽位，不向其他控制面发送 HTTP 请求。

KVM / Docker 槽位将宿主 `data/run/slot-guest-bin/`（仅含 `kin-worker`、`kin-kernel` 两个文件，**不会**挂载整个 `bin/`）只读挂进容器，避免单文件 bind mount 在升级替换二进制后仍粘旧 inode，也避免把 `kin-egress`、`kin-api-kernel` 等其它 helper 暴露进槽位 PATH。此后升级 worker/kernel **不必重建槽位**；若容器仍是旧版单文件挂载创建的，须 **重建该槽位容器一次** 才能切换到 staging 目录挂载。
槽位系统镜像优先 `docker pull ghcr.io/dofastted/kin-os-*`，拉不到时在建槽阶段用仓内 Dockerfile 兜底构建（启动不阻塞）。

**新建槽位的闭源依赖**：`kin-computer` 只分发编译后二进制，不公开源码。它由 `deploy/payload.json` 固定大小与 SHA256，随 Release 和控制面镜像交付；镜像入口自动安装到 `bin/kin-computer`，无需额外挂载私有源码目录。源码直接运行前执行 `npm run fetch:payload`；默认读取仓库的 `bin/kin-computer`，也可用 `KIN_COMPUTER_BIN` 指定绝对路径。二进制为 linux amd64，按 Ubuntu 22.04 / GLIBC 2.35 构建，Debian 12 与 Ubuntu 24.04 可向上兼容；ARM64 控制面通过 QEMU 运行。Docker 与 KVM 槽默认生成 Linux PC 计算机（真实 DMI 档案），不依赖 Bash 或 Python 3；手动 `--os macos` 生成 macOS 人设时才需要两者（控制面镜像已安装）。缺失时面板建槽返回 HTTP 400 `computer_service_missing`，生成失败返回 `computer_create_failed`。已有容器启动不会重新发布身份或改写主机名。

`v1.3.176` 原镜像未包含该依赖；补传 Release 附件不会改变旧镜像。继续使用该镜像时，需将附件安装到挂载的 `bin/kin-computer`，在 `.env` 设置 `KIN_COMPUTER_BIN=/opt/vm2api/bin/kin-computer` 后重新创建控制面容器以载入环境变量（不要重建槽位容器）。

集群节点已有目标槽镜像标签时跳过传输；仅在缺少云端基础系统时拉取它，母机只上传程序层。此优化不代表远端槽位已接入本机容器的全部计算机身份挂载。

**源码模式（自己改代码时）：**

```bash
git clone https://github.com/dofastted/vm2api.git /opt/vm2api
cd /opt/vm2api && cp .env.example .env && chmod 600 .env
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

一键脚本对应 `--from-source`；目录里有 `.git` 时 `upgrade` 自动走源码分支。仓库只有源码：镜像构建内编控制台与 Go helper，并按 `deploy/payload.json` 从 payload Release 下载、校验 kernel / CLI / kin-computer，构建机要能访问 GitHub。镜像入口再把它们写进挂载的 `bin/` 与 `share/`。

2026-10-11 起仓库历史已重写以移除构建产物，所有 tag 的提交号都变了。旧的源码安装用新版 `deploy/install.sh upgrade`（脚本已改为 `git fetch --force --tags`），不要用旧面板的一键更新做这次迁移。

升级到 **v1.2.22** 见下面「已部署机升级到 1.2.22」。更新控制面和槽内 kernel，但不要 `docker rm` 槽。

Docker Desktop / WSL 下 `curl 127.0.0.1:8787` 可能失败：

```bash
docker exec vm2api python3 -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8787/health").read().decode())'
```

槽位安装、同步和模板制作优先使用 `KIN_KERNEL_BIN` / `bin/kin-kernel`；母样本或槽内快照只在主内核不可用时使用。更新或上传主内核后，仍需同步并重启目标槽。控制面重启本身不会替换正在运行的槽内进程。

## 防火墙（UFW / firewalld）

绑定远程 SOCKS5 的槽，出站走这条路：

```
kin-<槽> 容器 → keg* 网桥 → 宿主机 kin-egress（网关 IP:端口）→ SOCKS5 → 上游
```

本机 SOCKS5 槽位（Docker / KVM）的重启策略为 `no`：由控制面的内核自动恢复流程负责进程崩溃和开机恢复，Docker 不再独立启动槽位。控制面启动时通过现有自动恢复流程，先安装阻断与代理规则，再启动记录为运行中的槽位；如果控制面启动失败、代理不可用或关闭了内核自动恢复，槽位保持停止，需恢复控制面或在面板手动启动。暂停的槽位不会被开机恢复。本地直连出口和远端节点的启动策略不变。

升级时控制面会用 `docker update --restart no` 原地迁移已有本机代理槽位（包括暂停槽位的容器），不重建槽位、不改凭据。请先升级并确认控制面成功启动，再重启 Docker。迁移失败会阻止控制面启动并打印错误；不能仅凭版本号认定已启用保护。该保护针对 Docker 守护进程重启；不要手工 `docker start` 代理槽位或清除其防火墙规则，`live-restore` 场景也不在此启动顺序保证范围内。

宿主机 `kin-egress` 的运行方式（v1.4.134 起）：控制面在 Docker 中运行（compose 设置 `VM2API_CONTAINER_NAME` 并挂载 `docker.sock`）时，每个代理的 `kin-egress` 作为独立的 host 网络容器 `kin-cp-egress-<代理>`（`--restart unless-stopped`）运行，控制面重启不会打断槽位 DNS；其他情况作为控制面子进程运行。可用 `KIN_EGRESS_RUNTIME=process|container` 强制指定。从容器方式切回进程方式时，控制面会先删除同一代理遗留的 `kin-cp-egress-*` 容器再占用端口；降级到 v1.4.133 及更早版本前，请先执行 `docker ps -aq --filter name=kin-cp-egress- | xargs -r docker rm -f`，否则旧版本看不到这些容器的进程，会一直等待端口释放。

**代理故障与恢复（Unreleased）：** 单条宿主 `kin-egress` 故障只限制当前依赖该 helper 的本机运行或暂停槽位；同一代理上的远端槽和本机 GPT 槽不依赖这个 helper。代理端点自身连续探测失败仍按代理池阈值处理，影响绑定该代理的槽位。Docker inspect 或 `ss` 不可用不算已确认故障，不新增或清除槽位限制。

定时探测（启用时）和面板「探测」使用同一恢复逻辑：代理协议探测成功，需要宿主 helper 的槽还须确认其 TCP 监听；随后只清除当前绑定代理留下的自动 `proxy_cooldown`，即使代理行此前已显示健康也会核对。手动禁用代理仍须点「启用」；手动调度关、维护锁、凭据或内核造成的不可调度不会被清除。监听检查不是 DNS 或真实推理验收；若恢复后请求仍失败，按下方步骤从槽内验证网络。

故障期间不会改绑、换 IP、自动直连或放宽防火墙与 IPv6 策略。这是同一控制面内的出口隔离，不是跨宿主高可用；宿主或共享上游故障仍可能影响多个出口，进程模式下控制面进程树退出也可能同时停止多个 helper。

控制面用 iptables 把容器的 TCP 和 DNS 重定向到宿主机上的 `kin-egress`。这一跳的目的地是宿主机本身，要经过宿主机 **INPUT** 链。UFW 默认入站 `DROP`，而 vm2api 不改你的 INPUT 规则，所以需要手动放行：

| 项 | 值 |
|---|---|
| 网卡 | `keg` 开头，每个 SOCKS5 出口一个（`ip -br link \| grep '^keg'`） |
| 网关 | 该网桥网段的 `.1`（`docker network inspect kin-eg-<代理id>`） |
| 端口 | 20000–35999 内，按代理 id 固定：偶数为 TCP，下一个奇数为 DNS（TCP + UDP） |

**UFW：**

```bash
sudo ufw allow in on keg+ to any port 20000:35999 proto tcp
sudo ufw allow in on keg+ to any port 20000:35999 proto udp
sudo ufw reload
```

**firewalld：**

```bash
for br in $(ip -br link | awk '/^keg/{print $1}'); do
  sudo firewall-cmd --permanent --zone=trusted --add-interface="$br"
done
sudo firewall-cmd --reload
```

新增 SOCKS5 出口会出现新的 `keg*` 网卡。UFW 的 `keg+` 通配会自动覆盖；firewalld 需要对新网卡再执行一次。

**验证**（在宿主机上，对已启动的槽）：

```bash
docker exec kin-<槽> getent hosts api.anthropic.com
docker exec kin-<槽> curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 https://api.anthropic.com
```

能解析且打印 HTTP 状态码（如 `404`）即通。两条都超时就是仍被拦截。本地出口（`px-local`）不经过 `kin-egress`，不需要这一步。

本地出口上的 GPT 槽位：控制面进程环境里有 `HTTPS_PROXY`（其次 `https_proxy`、`ALL_PROXY`、`all_proxy`；`HTTP_PROXY` 不算）时，Codex kernel 推理和目录同步、额度、token 刷新、OAuth 换票都走这个代理，代理不通就失败，不回落直连；`NO_PROXY` 对它不生效。没设就直连。本地出口上的 Claude 槽位始终直连。

## 上线后

1. 打开 `/cc` 是欢迎页，右上角「登录」进入登录页 `/cc#/login`（未配置时为 `admin` / `123456`）。首次登录回到欢迎页，下方首配清单按真实状态列出改密码、出口、槽位账号、可调度、密钥、首个请求，每步可跳面板或文档；点「跳过引导」后再登录直接进总览，用户菜单「欢迎与引导」可重新打开。
2. 代理池：添加本地出口，或导入 SOCKS5。
3. 建槽、绑出口、启动。没出口会停在 `stopped`。
4. 在槽里导入凭证，再用 `sk-vm-…` 或 master key 打 `POST /v1/messages`。

没出口或没凭证的槽不会进调度。

## 反代

Node 听 `:8787`。HTTPS 放在 nginx。

```nginx
# 集群、槽位和 Gemini 终端是 WebSocket：必须透传 Upgrade，并直连 Node。
location ~ ^/api/panel/((cluster/nodes|vms)/[^/]+/shell|gemini/environments/[^/]+/terminal/ws)$ {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_buffering off;
  proxy_read_timeout 3600s;
}

# Responses WebSocket 与 HTTP 共用路径，也必须直连 Node 并保留 Upgrade。
location ~ ^/(v1/)?responses$ {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header Authorization $http_authorization;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_buffering off;
  proxy_read_timeout 3600s;
}

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

`Connection ""` 会剥掉 Upgrade，终端或 Responses WS 握手拿不到 101。生产机的 Go 前门在 `:8787`、Node 在 `:8788` 时，上述两个 WebSocket location 必须 `proxy_pass` 到 Node。终端症状和核对命令见 [nginx-shell.md](nginx-shell.md)。

## 本机 Node（备选）

`npm run fetch:payload` 拉 `bin/kin-{kernel,codex-kernel,oauth-auth}` 与 `share/`；`npm run build:egress && npm run build:worker`；`npm ci`、`pnpm -C web install --frozen-lockfile && npm run build:web`；以及占位 `vms/active.json`。单元：[deploy/vm2api.service](deploy/vm2api.service)。细节见 [BUILD.md](BUILD.md)。

## 一键安装 / 更新

`deploy/install.sh` 默认拉 ghcr 预构建镜像，不在目标机编译，只下载 `docker-compose.yml`、`.env.example`、`VERSION`、`CHANGELOG.md`、`deploy/install.sh`（ARM64 另加 `deploy/prepare-arm64.py`）。`--from-source` 在目标机按 `Dockerfile` 多阶段构建：编 `web/dist` 与 Go helper，按 `deploy/payload.json` 下载 payload。不碰已有非空 `.env` 字段、`vms/`、`data/`，不 `docker rm` 槽。

### 两类安装错误

**1. `COPY VERSION CHANGELOG.md` / `"/CHANGELOG.md": not found`**

v1.2.7 的 `.dockerignore` 用 `*.md` 把 changelog 挡在构建上下文外。脚本会自动补一行；若仍失败：

```bash
cd /opt/vm2api
grep -q '!CHANGELOG.md' .dockerignore || echo '!CHANGELOG.md' >> .dockerignore
docker compose up -d --build
```

或 `curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade`。

**2. 管理台「Missing credentials」/「鉴权失效，请重新登录」**

打开登录页 `http://<ip>:8787/cc#/login`。未配置时账密是 `admin` / `123456`。已有密码：`grep '^VM2API_ADMIN_PASSWORD=' /opt/vm2api/.env`。

```bash
# 安装
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash

# 更新到最新 Release
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade

# 指定 tag
sudo bash /opt/vm2api/deploy/install.sh upgrade --version v1.2.22

# 只检查
sudo bash /opt/vm2api/deploy/install.sh check
```

面板：`GET /api/panel/version`、`GET /api/panel/changelog`、`POST /api/panel/update`。确认更新后，控制面会通过已挂载的 `docker.sock` 自省当前 Compose 项目和全部配置文件，拉起独立升级助手。助手记录更新前正常运行的槽位，按源码/镜像模式更新，保留已有 `src/config` 配置并 `--force-recreate` 控制面；通过健康检查、版本接口和槽位详情接口确认后端版本正确、此前健康的槽内内核仍能通过控制面鉴权，完成后才报告成功。忙碌但进程健康的槽位不视为故障；更新前已故障或停止的槽位不计入本次回归检查。助手失败时保留 `docker logs vm2api-upgrade-<project>`；容器里没有可识别的 Compose 服务时返回 `409 host_upgrade_required`，响应里带同一条 curl 命令。槽位内核健康检查不调用模型，不消耗上游额度。

CRAG 订阅使用宿主 ID，不使用容器自己的机器 ID、网卡地址或每次启动随机生成的值。Linux 原生控制面依次读取 `/etc/machine-id` 和 `/var/lib/dbus/machine-id`；也可通过 `KIN_CRAG_HOST_ID_FILE` 指定可信的宿主 ID 文件。已有订阅继续使用原有 ID 摘要；如果多个 Linux 来源中存在与原订阅匹配的值，优先保留原绑定。

Docker 的宿主 ID 文件须只读挂载到控制面的 `/run/crag-host-machine-id`。从宿主运行新版 `deploy/install.sh` 时，Linux（含 ARM64）优先使用原有 machine ID，其次使用 D-Bus、DMI UUID 或设备树序列号；macOS 的 Docker Desktop 场景由宿主通过 `ioreg` 读取 `IOPlatformUUID`，不使用 Desktop Linux 虚拟机的 ID。DMI、设备树和 macOS 使用安装目录中的固定快照，不会在检测到不同宿主时覆盖。Docker Desktop/WSL 共享文件即使显示为合成权限，也必须能核实该文件在容器内实际是只读挂载。这里支持的是 macOS 宿主采集和 Linux 容器内的订阅，不代表所有槽位运行时可原生运行在 macOS。

手动部署可先在宿主运行 `sudo bash deploy/install.sh prepare-crag-host --dir <安装目录>`。这一步不重启服务；新版 Compose 从 `.env` 的 `VM2API_CRAG_HOST_ID_FILE` 读取挂载源（默认 `/etc/machine-id`）。自定义或旧 Compose 必须对齐该挂载后，仅重建控制面。面板镜像升级助手会补齐缺失挂载，但不会覆盖已有自定义挂载或替宿主采集 ID。

如果原来曾用不同来源完成付款或绑定，请先恢复原来的宿主 ID 来源，再用同一浏览器操作原订单；不要删除订阅数据或重新付款。订单和授权私有目录仍须位于控制面可验证的 Linux 本地文件系统；Docker Desktop 的桌面共享目录可能不满足要求，新的安装可将控制面的 `data` 放在 Docker Linux VM 内的本地卷。已有订单迁移时必须一并保留原收据密钥，不要直接用空卷替换现有数据。

如果服务健康但本机 CRAG 订阅显示「状态不可用」，用 `namei -l` 核对实际数据目录的每级父目录。CRAG 会拒绝组或其他用户可写的父目录；确认安装根目录无需组写权限后，只移除该目录的组写位，不要递归修改数据目录和槽位权限。

## 已部署机升级到 1.2.22

1.2.22 修复 Anthropic 工具循环缓存边界：Node 保留上一轮稳定断点，槽内 kernel 只补当前尾部。升级必须同时更新 `bin/kin-kernel` 和 `share/wrap-cli/kin-kernel.bin`，再同步所有槽；不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

脚本会重建控制面、调用 `wrap-cli/sync` 并重启槽内 dataplane。手动部署时必须完成同一同步步骤。

## 已部署机升级到 1.2.15

1.2.15 只动**控制面**（信封不再误拦蒸馏；同一 API key 信封粘一个账号）。不必换槽内 kernel，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.15
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.15` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.14

1.2.14 只动**控制面**（第三方 cli-hop 改回 1.2.1 剥光；保留 1.2.12 convert 升块）。不必换槽内 kernel，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.14
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.14` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.13

1.2.13 只动**控制面**（Compose 镜像名去掉多余逗号）。不必换槽内 kernel，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.13
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.13` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.12

1.2.12 只动**控制面**（第三方 OpenAI 兼容口 cache 断点与 Anthropic Messages 对齐）。不必换槽内 kernel，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.12
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.12` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.11

1.2.11 只动**控制面**（外层调度等待计划、额度受限三态、设置/列表）。不必换槽内 kernel，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.11
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.11` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.10

1.2.10 只动**控制面**（Docker web `pnpm build` 类型检查；换仓内 `kin-cookie-auth`）。不必换槽内 kernel，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.10
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.10` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → 换仓内 `bin/kin-cookie-auth` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.9

1.2.9 只动**控制面**（thinking-only 残包同槽重试；一键安装补空账密；HTTP 裸 IP 登录不再丢会话）。不必换槽内 kernel，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.9
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.9` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.8

1.2.8 只动**控制面**（`.dockerignore` 放行 `CHANGELOG.md`，修好 v1.2.7 的 compose `COPY CHANGELOG.md` 失败）。不必换槽内 kernel，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

若还停在失败的 1.2.7 构建，可先手工：

```bash
cd /opt/vm2api
grep -q '!CHANGELOG.md' .dockerignore || echo '!CHANGELOG.md' >> .dockerignore
docker compose up -d --build
```

然后再升到 v1.2.8。

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.8
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.8` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

## 已部署机升级到 1.2.7

1.2.7 只动**控制面 Node + web**（版本检查、一键安装/更新、面板「关于」）。不必换槽内 kin-kernel / wrap CLI，也不要 `docker rm` 槽。

推荐：

```bash
curl -sSL https://raw.githubusercontent.com/dofastted/vm2api/main/deploy/install.sh | sudo bash -s -- upgrade
```

手动：

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.7
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.7` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

管理台 **设置 → 关于** 也可复制命令或（已挂 docker.sock 时）从面板发起。

## 已部署机升级到 1.2.6

1.2.6 只动**控制面 Node + web**（本地出口导入、kernel 探活、Setup Token 额度）。不必换槽内 kin-kernel / wrap CLI，也不要 `docker rm` 槽。

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.6
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.6` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

当前不在 1.2.5 的机器：若 wrap CLI 还是 `cli-dist`，先按下面「已部署机升级到 1.2.5」做 `wrap-cli/sync`，再 `git checkout v1.2.6` 重启控制面。

## 已部署机升级到 1.2.5

1.2.5 动两处：**控制面 Node** 和槽内 **wrap CLI ELF**（`cli-node` 替换原来的 `cli-dist`）。槽容器不要 `docker rm`。

### 1. 控制面

```bash
cd /opt/vm2api
git fetch --tags
git checkout v1.2.5
docker compose up -d --build
curl -sS --noproxy '*' http://127.0.0.1:8787/health
```

本机 systemd：`git checkout v1.2.5` → `npm ci` → `pnpm -C web install --frozen-lockfile && npm run build:web` → `systemctl restart vm2api` **一次**。

### 2. 槽内 wrap CLI

换 `vms/<id>/cli-home/.kin/cli-node`（以及 kernel.bin / 包装器）。用面板同步：

```bash
curl -sS -X POST http://127.0.0.1:8787/api/panel/wrap-cli/sync \
  -H "Authorization: Bearer $VM2API_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"restart":true}'
```

`ids` 可限定槽；省略则全槽。未启动的槽下次 start 会铺新文件。

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

### Ubuntu AppArmor 与 Docker 原生 Claude

在 `kernel.apparmor_restrict_unprivileged_userns=1` 的宿主上，单独设置
`apparmor=unconfined` 仍可能使原生 Claude 在创建 user/mount namespace 后进入
`unprivileged_userns` 限制，导致 bind mount 返回 `Permission denied (os error 13)`。

安装/升级脚本在启动控制面前，加载并持久保存 `vm2api-crag-docker` AppArmor
profile，显式允许 `userns`。不关闭宿主 sysctl，不授予槽位 privileged 或额外
capability，现有 seccomp 和 `no-new-privileges` 保持不变。策略检查或加载失败会
终止安装，并保留错误信息；已有同名非托管策略不会被覆盖。

手动 Compose 部署需先在 **Docker 宿主机** 执行新版本安装脚本中的准备命令：

```bash
sudo bash deploy/install.sh prepare-native
```

随后更新控制面，并通过面板重载正在使用的 CRAG v2 槽位。Docker restart 无法
更改 AppArmor profile；旧 `unconfined` 槽位会在正常重载/启动路径中重建。
已停用槽位不会由准备命令启动，在下次手动启动时应用新配置。profile 未加载时
Docker 会明确拒绝创建槽位，不退回 `unconfined`。命令必须在 Docker daemon
所在宿主执行，不能在控制面容器或远端 Docker 客户端机器上执行。
