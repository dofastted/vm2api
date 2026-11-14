# CRAG KVM 部署与内核更换

Linux amd64 的本机和集群 KVM 槽使用同一套 CRAG V2 签名加密发行包。先准备可用的 KVM 槽，在管理台「内核」页拉取 CRAG 并激活授权，再为目标 VM 选择 CRAG，点击「安装」并确认重启。切回标准内核时选择 cli-node，执行同一操作；更新 CRAG 包后可对选定 VM 执行「重装」。

详情页的单槽切核、内核页安装/重装及批量数据面切换均支持 KVM，不再因 KVM 形态提示不支持。详情页切核只重启 guest 内核，保留虚拟机和磁盘；停止中的 VM 只保存选择，下次启动生效。macOS 原生槽及 CRAG 跨节点迁移仍不支持。

本机和集群 KVM 均可查询 CRAG 授权，并使用 `CRAGU1` 离线通用码激活；`CRAGL1` 设备注册码仍仅适用于本机 Linux Docker 槽。KVM 支持不绕过包签名、完整性或授权检查。

新建 Claude KVM 槽会预装完整 CRAG 签名加密包和包内官方 Claude。本机文件位于槽的 `cli-home/.kin/crag-v2/`；集群节点同时包含镜像内副本和持久 `slot-bin` 副本。预装保留当前内核选择，不生成设备身份或激活授权；实际选择 CRAG 仍须通过授权校验。缺少或损坏的 CRAG 包会明确阻止 KVM 安装准备，请先在内核页拉取正式包。

旧 KVM 的配置迁移通过 `/wrap` 内核页逐台执行：识别为 KVM 且没有 CRAG 安装版本记录时，页面显示「重装 CRAG」，即使当前选择的是 cli-node，也可直接发起 CRAG 安装。确认并通过包、授权检查后，沿用现有受锁保护的重装流程，补齐完整运行包，重新生成 `claude_bin`、guest socket 与 CRAG 配置，更新安装版本，再重启并检查健康。版本记录缺失不等于文件一定不存在；不要用全局包版本或 `crag_kernel_version: v2` 协议字段假冒该槽的已安装版本。

切换前会先将通用授权同步至目标槽，同步失败时保留原内核配置；批量切换也会在更新全局默认前完成所有目标的授权同步。

内核页操作先验证发行包和授权，再暂停该槽调度、等待在途请求结束，停止、替换并重启，健康检查成功后恢复调度。已有手动关闭和凭据限制保留；安装失败时应检查该 VM 的错误和停止状态后再操作。账号、机器身份、设备授权、工作区及 KVM 磁盘沿用原数据。

集群 KVM 的入口和完整发行包放在节点的持久 slot-bin 中，经只读 payload 共享给 guest。发布 kernel.json 时同步 guest 的内核选择，首次启动、重载和双向更换都使用对应入口。Unix socket 留在 guest 的 `/run/kin-guest`，授权与工作目录使用现有 `/run/kin` 共享。

自 v1.4.082 起，发布 CRAG 配置前先验证并补齐节点 slot-bin 的完整签名包，包括配置引用的官方 Claude；包缺失或校验失败时不发布新配置。同步逐文件核对 SHA256，即使 crag.digest 相同也会修复缺失或损坏的文件，已匹配的二进制不重复替换。旧版受影响的集群 KVM 槽可升级控制面后在内核页重装。

仅管理本机槽时，也可用 `deploy/install.sh crag-update` 更新既有 CRAG 副本，包括本机 KVM；运行核心哈希通过 guest 执行通道读取。该独立脚本仍拒绝包含活动集群 CRAG 槽的安装，集群槽请使用内核页选择目标并重装。此功能不包含 CRAG KVM 的跨节点迁移支持。

## AppArmor 与原生 Claude 启动权限

Ubuntu 24.04 等启用了 `kernel.apparmor_restrict_unprivileged_userns=1` 的 guest 中，CRAG V2 健康检查可能正常，但实际请求仍报 `Claude native launch failed (guest identity requires user/mount namespaces and bind-mount permissions): Permission denied`。原生 Claude 的 guest identity 需要创建用户、挂载命名空间并执行 bind mount；AppArmor 的默认非特权用户命名空间策略可能阻止这些操作。

KVM guest 的启动准备会为 CRAG V2 加载具备 `userns,` 权限的 `vm2api-crag` 命名 unconfined profile，并通过 `kin-kernel.service` 的 `AppArmorProfile` 绑定，使原生 Claude 子进程继承该策略。策略保存在 `/etc/apparmor.d/vm2api-crag`，systemd 配置保存在 `/etc/systemd/system/kin-kernel.service.d/50-vm2api-crag-userns.conf`。全局用户命名空间限制、服务运行用户、capabilities 和发行包保持原样；该处理仅作用于目标 KVM guest。

新建 guest 在启动准备阶段应用配置。已有磁盘的槽升级控制面后，可通过内核重启、重载或重装应用当前版本的准备逻辑，无需重建磁盘或重新执行 cloud-init；CRAG V2 槽从停止状态启动时也会在确认运行就绪前完成准备。普通健康轮询不会触发权限修改或强制重启。

如果 guest 未启用 AppArmor 或未启用上述用户命名空间限制，准备逻辑直接跳过。管理员设置的其他 `AppArmorProfile` 及非本工具管理的同名配置会保留，所需的命名空间权限应由管理员自行配置。受限制的 guest 缺少 `apparmor_parser`、AppArmor 4 ABI 或 `apparmor.service`，以及策略校验或加载失败时，会明确报错；已有槽的重启流程在准备成功前不会终止运行中的内核。切回其他数据面时，仅移除工具管理的 systemd 绑定，保留已加载策略，避免影响仍使用该策略的进程。
