# CRAG KVM 部署与内核更换

Linux amd64 的本机和集群 KVM 槽使用同一套 CRAG V2 签名加密发行包。先准备可用的 KVM 槽，在管理台「内核」页拉取 CRAG 并激活授权，再为目标 VM 选择 CRAG，点击「安装」并确认重启。切回标准内核时选择 cli-node，执行同一操作；更新 CRAG 包后可对选定 VM 执行「重装」。

详情页的单槽切核、内核页安装/重装及批量数据面切换均支持 KVM，不再因 KVM 形态提示不支持。详情页切核只重启 guest 内核，保留虚拟机和磁盘；停止中的 VM 只保存选择，下次启动生效。macOS 原生槽及 CRAG 跨节点迁移仍不支持。

本机和集群 KVM 均可查询 CRAG 授权，并使用 `CRAGU1` 离线通用码激活。自 v1.4.119 起，本机和集群 Linux Docker/KVM 槽共享宿主订阅额度：通过 Authority 确认的 `CRAGR1` 宿主码兑换权益，以 `CRAGS1` 绑定槽位，支持 H1/H2 权益和 H2 回收。面板统一显示订阅状态与剩余可绑定槽位，不按运行时或 CRAG 发行版本拆分额度。`CRAGL1` 和设备兑换码仍仅适用于本机 Linux Docker 槽。KVM 支持不绕过包签名、完整性或授权检查。

新建 Claude KVM 槽会预装完整 CRAG 签名加密包和包内官方 Claude。本机文件位于槽的 `cli-home/.kin/crag-v2/`；集群节点同时包含镜像内副本和持久 `slot-bin` 副本。预装保留当前内核选择，不生成设备身份或激活授权；实际选择 CRAG 仍须通过授权校验。缺少或损坏的 CRAG 包会明确阻止 KVM 安装准备，请先在内核页拉取正式包。

旧 KVM 的配置迁移通过 `/wrap` 内核页逐台执行：识别为 KVM 且没有 CRAG 安装版本记录时，页面显示「重装 CRAG」，即使当前选择的是 cli-node，也可直接发起 CRAG 安装。确认并通过包、授权检查后，沿用现有受锁保护的重装流程，补齐完整运行包，重新生成 `claude_bin`、guest socket 与 CRAG 配置，更新安装版本，再重启并检查健康。版本记录缺失不等于文件一定不存在；不要用全局包版本或 `crag_kernel_version: v2` 协议字段假冒该槽的已安装版本。

切换前会先将授权同步至目标槽，同步失败时保留原内核配置；批量切换也会在更新全局默认前完成所有目标的授权同步。

内核页操作先验证发行包和授权，再暂停该槽调度、等待在途请求结束，停止、替换并重启，健康检查成功后恢复调度。已有手动关闭和凭据限制保留；安装失败时应检查该 VM 的错误和停止状态后再操作。账号、机器身份、设备授权、工作区及 KVM 磁盘沿用原数据。

集群 KVM 的入口和完整发行包放在节点的持久 slot-bin 中，经只读 payload 共享给 guest。发布 kernel.json 时同步 guest 的内核选择，首次启动、重载和双向更换都使用对应入口。Unix socket 留在 guest 的 `/run/kin-guest`，工作目录使用现有 `/run/kin` 共享；授权通过 guest 执行通道写入来宾本地临时目录。集群 KVM 保留 v1.4.119 的授权发布流程，下述受管理的只读投影与严格身份检查增强仅用于本机 KVM。

自 v1.4.082 起，发布 CRAG 配置前先验证并补齐节点 slot-bin 的完整签名包，包括配置引用的官方 Claude；包缺失或校验失败时不发布新配置。同步逐文件核对 SHA256，即使 crag.digest 相同也会修复缺失或损坏的文件，已匹配的二进制不重复替换。旧版受影响的集群 KVM 槽可升级控制面后在内核页重装。

仅管理本机槽时，也可用 `deploy/install.sh crag-update` 更新既有 CRAG 副本，包括本机 KVM；运行核心哈希通过 guest 执行通道读取。该独立脚本仍拒绝包含活动集群 CRAG 槽的安装，集群槽请使用内核页选择目标并重装。此功能不包含 CRAG KVM 的跨节点迁移支持。

## 本机 KVM 授权投影

标准 CRAG 原生授权模块拒绝将 9p/DrvFS 作为设备许可存储。KVM 的 `/run/kin` 是 9p 共享，所以仅允许控制面绑定或增加宿主权益目录挂载不足以让内核启动。

控制面复用现有 guest 执行通道，把完整验签、验证身份和 H2 名册后的本槽 `device.json`、`registration.code` 与公共 `host_id`、`entitlement.code` 通过标准输入传入 guest。guest 在本地 tmpfs 的 `/run/vm2api-crag` 中创建副本，再分别只读绑定到 `/run/kin/crag-license` 和 `/run/kin/crag-host`。设备目录为槽用户所有的 `0700`，设备文件为 `0600`；公共权益由 root 所有。底层副本位于 root 私有目录内，槽用户不能修改。原始兑换码和宿主 Authority 鉴权凭据不会传入 guest。

本机 `CRAGU1` 通用授权也通过同一个受管理的投影发布，只传入已验证的通用许可，不生成设备绑定或消耗宿主订阅额度，保留原有离线授权语义。已使用受管理投影的本机槽可在 U1 与 S1 间切换，仍须通过目标发行包和对应授权检查。

启动、重启和授权推理前会核对并同步副本。主动变更订阅前先关闭并发发布并阻断已有 guest 副本；同步按槽串行执行，以 `sync-pending` 阻断中间状态，文件原子替换完成后才开放。撤回、过期、身份不符和同步失败时不放行新的推理请求。Authority 已提交而 guest 同步失败时会明确报错，不伪造回滚；修复 guest 连接后可再次启动或重试授权请求。H2 的停机动作本身不释放名额；删除需确认运行实例已销毁，按需回收需核实目标确已停止且没有正在启动或安装的操作。

本机 S1 订阅授权要求记录中的 `fingerprint.guest_machine_id`、持久 `machine-id` 文件和 guest 的 `/etc/machine-id` 一致，使用 32 位小写十六进制且不为全零。发现旧槽身份记录不一致时会拒绝授权，不自动改写机器身份。guest 需要 Python 3、tmpfs 和 root guest 执行通道；正常槽用户仍不获得 root 权限。就绪检查在 guest 内执行实际 bootstrap 的 `--license-capabilities`，并验证只读许可挂载及订阅机器身份。

同源管理员在内核页确认指定发行时，缺少许可的槽可绑定已激活的宿主订阅。兼容的许可继续使用；载荷密钥不符时不自动重签、不停槽。宿主码兑换与槽位绑定分开处理，绑定失败不会撤销已经到账的额度。安装沿用受锁保护的排空、安装和重启流程，保留原磁盘、身份与账号数据；无需重建 guest 镜像。guest 重启后临时副本由控制面重新验证并发布。

从 v1.4.119 原有发布流程升级时，已经运行的本机 guest 可能在许可目录上保留没有管理标记的临时挂载。新流程会拒绝自动接管这类挂载。此时须完整停止并重新启动该槽位，让 guest 重启清理旧临时挂载；仅重启或重装内核不足以完成迁移。无需删除授权、修改目录权限或重建磁盘，重新启动后会发布当前有效授权。

本机 KVM 的宿主订阅进程计入统一的运行额度；其 relay 缺失、不可连接或健康响应不能证明内部令牌认证时，计为未知。无法确认在额度内时拒绝新的宿主授权请求，不把未知运行情况当作零占用。

## AppArmor 与原生 Claude 启动权限

Ubuntu 24.04 等启用了 `kernel.apparmor_restrict_unprivileged_userns=1` 的 guest 中，CRAG V2 健康检查可能正常，但实际请求仍报 `Claude native launch failed (guest identity requires user/mount namespaces and bind-mount permissions): Permission denied`。原生 Claude 的 guest identity 需要创建用户、挂载命名空间并执行 bind mount；AppArmor 的默认非特权用户命名空间策略可能阻止这些操作。

KVM guest 的启动准备会为 CRAG V2 加载具备 `userns,` 权限的 `vm2api-crag` 命名 unconfined profile，并通过 `kin-kernel.service` 的 `AppArmorProfile` 绑定，使原生 Claude 子进程继承该策略。策略保存在 `/etc/apparmor.d/vm2api-crag`，systemd 配置保存在 `/etc/systemd/system/kin-kernel.service.d/50-vm2api-crag-userns.conf`。全局用户命名空间限制、服务运行用户、capabilities 和发行包保持原样；该处理仅作用于目标 KVM guest。

新建 guest 在启动准备阶段应用配置。已有磁盘的槽升级控制面后，可通过内核重启、重载或重装应用当前版本的准备逻辑，无需重建磁盘或重新执行 cloud-init；CRAG V2 槽从停止状态启动时也会在确认运行就绪前完成准备。普通健康轮询不会触发权限修改或强制重启。

如果 guest 未启用 AppArmor 或未启用上述用户命名空间限制，准备逻辑直接跳过。管理员设置的其他 `AppArmorProfile` 及非本工具管理的同名配置会保留，所需的命名空间权限应由管理员自行配置。受限制的 guest 缺少 `apparmor_parser`、AppArmor 4 ABI 或 `apparmor.service`，以及策略校验或加载失败时，会明确报错；已有槽的重启流程在准备成功前不会终止运行中的内核。切回其他数据面时，仅移除工具管理的 systemd 绑定，保留已加载策略，避免影响仍使用该策略的进程。
