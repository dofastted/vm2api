# 设置 → Gemini：维护与版本管理

此入口仅对管理员开放。它把 Gemini 宿主维护与账号真实试聊分开，不把 socket 可达、载荷已安装、已授权或模型列表当成推理成功。

导入、虚拟机列表与环境详情、终端、模型拉取/试聊、兑换过程遇到本地宿主或载荷故障时，可从提示中的「设置 → Gemini：诊断与维护」跳转到同一维护区域。跳转只导航，不会自动安装、修复或发送对话。非管理员显示联系管理员的提示；账号授权、地区资格、代理、额度及兑换码错误仍沿用原处理入口，不会误导为需要重装。

## 首次启用

升级到包含维护组件的 vm2api 版本后，安装器会准备独立的 `vm2api-gemini-maintenance.service`。已有部署可在宿主执行当前版本的 `sudo bash /opt/vm2api/deploy/install.sh prepare-gemini --dir /opt/vm2api`；请替换成实际已有安装目录。服务缺失时，非 root 的面板不能凭空取得 root 权限，页面会明确显示 bootstrap 前置条件和宿主命令，不会报告假安装任务。

Docker 部署需使用更新后的 Compose 配置，将 `/run/vm2api-gemini-maintenance` 只读挂载到控制面；只读目录挂载仍允许连接其中的 Unix socket。独立 Node 服务需具备 `vm2api` 组权限。宿主无 systemd、平台非 Linux amd64 或发行包缺少维护组件时，按错误提示处理，不回退为任意 root 执行。

维护 unit 使用 `RuntimeDirectoryPreserve=yes`，使 broker 停止、启动或重启时保留 `/run/vm2api-gemini-maintenance` 的目录 inode。Compose 挂载的是该目录而不是 socket 文件，因此不必为 broker 重启重新创建网关容器。不要改成仅在 restart 时保留目录。若旧配置已删除并重建目录、现有网关已挂在旧 inode 上，则需要重新绑定挂载（例如一次性重新创建网关容器）；只恢复 broker 无法修复已经陈旧的挂载。

已有自定义 unit/drop-in 的部署应先由宿主管理员迁移到标准 Gemini unit。维护服务不会猜测或覆盖额外的启动、载荷和信任策略；它返回 `gemini_maintenance_unsupported_service_config`，而不是强制重启。源码部署的安装目录、代码及所有父目录也必须由 root 拥有且不可由其他用户写入，不能把面板可写脚本冻结成 root 维护代码。

## 页面操作

- **诊断宿主**：读取服务、签名载荷、激活和运行前置条件，显示逐项结果。
- **安装运行环境**：通过已初始化的维护服务执行固定安装动作，不接收浏览器提供的命令或目录。
- **修复安装 / 恢复推理环境**：修复可验证的宿主输入并启动 Gemini 服务；apt 宿主缺少运行工具时，只安装固定的 nodejs/python3/iproute2/nftables/util-linux/bubblewrap/curl/kbd 包。非 apt 宿主需先按诊断补齐工具。不重启控制面、不换绑代理、不修改 Google 资格或全局转发策略。完成后选择已有环境，在下方拉取模型并显式发送一次短文本试聊。
- **仅更新 CLI**：只允许与所选签名清单及已安装原生组件相容的 CLI。不能任意执行 `agy update` 或把最新官方 CLI 直接覆盖到受信路径。
- **更新 CRAGGemini / 回滚上一版**：选择 root 安装包内的兼容目录，完整验签、校验成员后再切换，保留上一版以供回滚。不会默默把较新的或手工版本降到默认版。

维护任务单次运行，页面显示真实阶段、终态和错误；运行中的 Google 授权、终端或推理会阻止修改，不强杀进行中的任务。维护中断的 journal 会封锁新运行请求，直到维护服务完成恢复。新版清单若需要兑换，仍须通过正常兑换入口激活；不要把旧激活标记复制成新版本授权。

## 权限与可信输入

维护服务仅监听 `/run/vm2api-gemini-maintenance/control.sock`，无 TCP 监听。操作只允许 diagnose/install/repair/recover/update_cli/update_native/rollback；只接受受信目录中的 release_id，不接受下载地址、公钥、任意路径、shell 或包名。

`/etc/vm2api/gemini-maintenance.json` 及其 bundle 必须由 root 拥有、不可由其他用户写入。bundle 在宿主安装阶段从对应发行文件固定下来；维护请求不会从应用可写目录复制并执行代码。`kin-egress` 仅在大小和 SHA-256 与固定清单一致后复制到 root-owned 运行目录。手工信任设置、账号和代理绑定不得被默认下载源覆盖。

维护服务与运行服务使用同一个 `/var/lib/vm2api-gemini/maintenance.lock`。维护服务取得排他锁后再检查是否空闲；运行服务对新的变更请求持有共享锁。`maintenance.pending` 表示上次维护未完成，不能手工删除来绕过恢复。

## 管理 API

- `GET /api/panel/gemini/maintenance`：维护服务可用性、安装目录、当前 CLI/原生版本、兼容目录、诊断结果及最近任务。
- `POST /api/panel/gemini/maintenance/jobs`：`{action, release_id?}`。版本更新使用页面列出的精确 release_id；其他操作不提交目录或命令。

响应使用面板 `{ok,data}` 包装。不可用状态会区分权限、bootstrap、超时和传输失败；提交任务失败不能当作安装成功。维护结果不包含子进程原始 stdout/stderr、Google 凭据或兑换码。

Google 返回地区资格限制、OAuth 过期或代理错误时，仍按真实错误处理。恢复宿主不能保证这些外部条件恢复，也不会自动切换账号或代理。

## systemd / Compose 挂载回归

在本地 Docker Desktop 的 Linux amd64 / cgroup v2 环境，准备含 systemd、Python 3、util-linux、passwd 的测试镜像，并预先缓存 `node:24-bookworm-slim`。测试镜像可用以下最小 Dockerfile 构建：

```dockerfile
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd python3 util-linux passwd && rm -rf /var/lib/apt/lists/*
```

运行 `python3 -B test/deploy/gemini-maintenance-systemd-smoke.py --broker-image YOUR_TEST_IMAGE`。脚本不构建/拉取镜像，不挂载宿主目录或 Docker socket；只在独立容器内挂载私有 cgroup2，运行时禁用外部网络，并清理本次创建的容器和卷。构建测试镜像时的 APT 下载不属于生产部署。

负对照会证实旧配置重建目录后，未重建的网关失去状态访问。修复阶段保留同一个网关容器，检查 broker stop/start 和 restart 后状态恢复、目录 inode 不变，以及网关 ID、PID、StartedAt 均未改变。
