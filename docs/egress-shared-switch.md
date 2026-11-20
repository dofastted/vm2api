# 把一台 VM 切到共享出口

本文是操作手册，按实际节点数据写。设计与权衡见 PR #1351，内核参数见 [egress-shared-kernel.md](egress-shared-kernel.md)。

**前提**：共享模式默认关闭。合并、发版、部署之后不会有任何 VM 自动切过去——每台都要显式切。

## 先判断这台机器该不该切

共享模式解决的是「每代理一个出口网络」耗尽 Docker 地址池。切之前先看实际占用，因为**占住网段的往往不是在跑的 VM**。

```bash
# 出口网络总数，以及其中有几个是零容器的孤儿
docker network ls --format '{{.Name}}' | grep '^kin-eg-' | while read -r n; do
  printf '%-28s 容器=%s 网段=%s\n' "$n" \
    "$(docker network inspect -f '{{len .Containers}}' "$n")" \
    "$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$n")"
done
```

但**零容器不等于孤儿**。实测一台生产控制面（2026-11-20）：15 个出口网络里 12 个零容器，而 `verify` 只判定 **1 个**是残留——另外 11 个的 owner 代理还活着（该机 16 个活代理、9 台 VM、8 个运行容器），只是对应 VM 当前没开机，随时会用上。工具不删它们是对的。

所以收益要按判定结果算，不是按零容器数算：

| 先做 | 该例实测收益 | 风险 |
|---|---|---|
| `egress-maintenance.mjs sweep` 清残留 | 15 → 14 个网络（`/20` 占用 9 → 8） | 低，不碰运行中的 VM |
| 再折叠成共享 | 每节点收敛到 1 个网络 | 高，要重建真实用户的容器 |

清扫的主要价值是**悬空规则**而非网段：该例实得 1 个网络 + 39 个 rundir + 13 条 iptables 链 + 1 个网桥（54 项），其中 12 个网桥早已消失、只剩规则。真正压地址池的是「每代理一个网络」，那只有折叠能解。

**先清理，再决定还要不要折叠。** 清理是无风险的，先做；但别指望它腾出网段。

```bash
node scripts/egress-maintenance.mjs verify --root=/opt/vm2api            # 先看判定
node scripts/egress-maintenance.mjs sweep --root=/opt/vm2api             # dry
node scripts/egress-maintenance.mjs sweep --root=/opt/vm2api --apply
```

## 切之前确认节点前提

```bash
cat /proc/sys/net/bridge/bridge-nf-call-iptables   # 必须是 1
strings -a /opt/vm2api/bin/kin-egress | grep -c 'no route for source'   # 必须 ≥ 1
```

这是**隔离前提**，不是性能项：共享网桥上 VM 之间的隔离两道都在 iptables 里，此开关为 0 时两道同时失效，整节点 VM 可互通且无任何日志。控制面在折叠前会检查并拒绝（`bridge_netfilter_disabled`），所以这是会被挡住的，不是悄悄发生的。细节见内核参数文档。

节点上的 `kin-egress` 二进制也必须是含共享支持的版本。旧版遇到空 `proxy_url` 会报 `unsupported proxy scheme ""` 而拒绝启动——方向是安全的（fail-closed，不泄漏流量），但那台 VM 起不来。

## 一台一台切

```bash
# 全局现状：每个节点上 per-vm / shared 各几台，共享网络容量
node scripts/egress-switch-mode.mjs status --root=/opt/vm2api

# 这台会发生什么、有什么阻碍
node scripts/egress-switch-mode.mjs plan --vm=vm-01 --root=/opt/vm2api

# 落盘（不加 --apply 是 dry run）
node scripts/egress-switch-mode.mjs to-shared --vm=vm-01 --root=/opt/vm2api --apply
```

`to-shared` 只写 VM 记录的 `runtime.egress_mode`，**不动容器**。切完之后：

- `slotNetworkForVm` 对这台 VM 返回 `kin-eg-shared[-<nodeId>]`
- 它现有容器在旧网络上，所以 `slotContainerNetworkMismatch` 为真
- **下次启动时**由既有启动路径重建容器，并在节点锁内分配共享地址、注册路由

所以切换本身不中断，**重启那一刻才中断**。重启这台 VM 让它迁移：

```bash
# 用面板或你平时重启单台 VM 的方式；重建期间该 VM 会话中断
```

地址不由脚本分配，而是启动路径在节点锁内分配——它要同时避开已在网桥上的地址和**正在启动的其他槽位**所预留的地址。脚本在锁外写不了这个保证。

### 切完验证这一台

```bash
# 容器确实在共享网络上，且带固定地址
docker inspect -f '{{.HostConfig.NetworkMode}} {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' kin-vm-01

# helper 的路由表里有这台
cat /opt/vm2api/data/run/egress/eg-shared/egress.json | python3 -m json.tool

# 出网通
docker exec kin-vm-01 curl -s -m 10 -o /dev/null -w '%{http_code}\n' https://api.anthropic.com/
```

确认通了，再切下一台。

## 回滚

单台回滚：

```bash
node scripts/egress-switch-mode.mjs to-per-vm --vm=vm-01 --root=/opt/vm2api --apply
# 然后重启这台 VM
```

回滚会删掉记录里的 `shared_ip`（留着会让它在下次裁剪时仍被当成共享网桥成员），VM 重启后回到自己的 per-VM 网桥。

**整节点回滚**不需要动每台记录——helper 的配置去掉 `routes` 就退回单上游语义。但已经在共享网桥上的 VM 仍需重启才能回到自己的网桥（地址与路由表绑定），这是已知限制。

## 已知边界

- **amd64 的 `kin-egress` 不是从源码编出来的**：`release.yml` 只在 ARM64 分支编 `worker/`；amd64 的 Go helper 来自 `deploy/payload.json` pin 的产物（`node scripts/fetch-payload.mjs`）。所以改了 `worker/internal/egress/` 的代码**并不会进 amd64 二进制**——必须另编产物、发 payload 组件 release、`fetch-payload.mjs --pin <TAG>` 重算清单，才会随下一次发版落到主机。2026-11-20 第一次实机折叠就是栽在这里：源码正确、helper 却报 `unsupported proxy scheme ""`。判断方法：
  ```bash
  strings -a /opt/vm2api/bin/kin-egress | grep -c 'no route for source'   # 0 = 旧产物
  ```
  这条探针对剥过符号的产物同样有效（字符串在 rodata，`-s -w` 不会删）。
- **集群节点需要先升级节点上的 `kin-egress`**：旧版遇到空 `proxy_url` 会拒绝启动（见上文「切之前确认节点前提」）。二进制由控制面在启动共享 helper 前自动推到 `<root>/egress/slot-bin`，但它推的是控制面自己那份——所以控制面必须先部署到含共享支持的版本。
- **节点侧与控制面侧的串行化共用控制面进程内的锁**。控制面是任何节点的唯一写入方，所以这是成立的；但这也意味着**两个控制面同时管同一个节点**会绕过它。本项目的部署形态是单控制面，若将来不是，这里需要改成节点上的锁。
- **一个代理服务多台 VM 时**，路由表是多条指向同一上游 URL——功能正常，但要据此重新算收益：瓶颈是网络数而非 VM 数。
- **`domain_forward` 与共享模式互斥**：观察域名表是 helper 级单表，共享会让一台 VM 的查询改写另一台的目标地址。需要它的 VM 留在 per-vm。
