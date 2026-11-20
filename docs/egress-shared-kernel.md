# 共享出口的内核参数

折叠出口网络（一个节点一个网桥、一个 helper）把瓶颈从 Docker 地址池移走之后，下一批限制来自内核。本文给出需要抬高的参数、**计算依据**和按节点规模的推荐值。

本文只负责说明依据，**不负责替生产调参**：具体值要按机器实际内存和负载定，改之前读依据、改之后看 `dmesg`。

模式为 `per-vm` 的节点不受影响，按原样运行即可。

## 先确认一个安全前提

```bash
cat /proc/sys/net/bridge/bridge-nf-call-iptables   # 必须是 1
lsmod | grep br_netfilter                          # 必须已加载
```

实测一台 AWS Ubuntu 节点为 `1` 且 `br_netfilter` 已加载（Docker 创建桥接网络时会自己加载并打开）。

这不是性能项，是**隔离前提**。共享网桥上 VM 之间的隔离有两道，都在 iptables 里：

- 我们自己在 `FORWARD` 里的 `-i <bridge> -o <bridge> -j DROP`
- Docker 因 `enable_icc=false` 装的隔离链

桥接流量只有在 `br_netfilter` 加载且本开关为 `1` 时才会进 iptables。开关为 `0` 时两道同时失效，整个节点的 VM 可以直接互相访问，**而且不会有任何日志提示**。

控制面在折叠网桥前会检查这一项，不满足就拒绝启动共享 helper（`bridge_netfilter_disabled`），所以这是会被挡住的、不是悄悄发生的。Docker 在创建桥接网络时通常会自己加载并打开它；若被主机策略或别的 sysctl 配置关掉，需要显式恢复：

```bash
modprobe br_netfilter
sysctl -w net.bridge.bridge-nf-call-iptables=1
# 持久化
echo 'br_netfilter' > /etc/modules-load.d/br_netfilter.conf
echo 'net.bridge.bridge-nf-call-iptables = 1' > /etc/sysctl.d/99-kin-bridge.conf
```

## 首要项：邻居表 `gc_thresh`

```
net.ipv4.neigh.default.gc_thresh1   内核默认 128
net.ipv4.neigh.default.gc_thresh2   内核默认 512
net.ipv4.neigh.default.gc_thresh3   内核默认 1024
```

**先看实际值，不要照抄「默认」**。云镜像常常已经调过：

```bash
sysctl net.ipv4.neigh.default.gc_thresh1 net.ipv4.neigh.default.gc_thresh2 net.ipv4.neigh.default.gc_thresh3
grep -rn gc_thresh /etc/sysctl.conf /etc/sysctl.d/ 2>/dev/null
```

实测一台 AWS Ubuntu 节点（2026-11-20）：`gc_thresh1=128 gc_thresh2=15360 gc_thresh3=16384`，由镜像自带的 `/etc/sysctl.d/50-cloudimg-settings.conf` 设置，**不是** vm2api 装的。这类机器单节点 4093 台 VM 不会撞上。裸装的 Debian / Ubuntu Server 没有这个文件，仍是 1024，必须调。

**为什么 per-VM 架构下没出过问题**：不是机制上不会撞，而是**地址池先耗尽，规模根本到不了那里**。实测同一台节点**没有** `/etc/docker/daemon.json`，Docker 用默认池 `172.17.0.0/12` 切 /16，整机只有 16 个 /16 可用（已占 2 个：`bridge` 和一台 VM 的出口网络）。每 VM 一个网络的话，单节点十几个 VM 就见底了。折叠之后地址池不再是瓶颈，规模可以到几千台，`gc_thresh3` 才成为下一个会撞上的墙。

**依据**：宿主为共享网桥上每个 VM 保留一条邻居表项（IP → MAC），加上网关自身。所以条目数约等于节点上的 VM 数。`gc_thresh3` 是硬上限，超过之后内核直接丢弃新表项，表现为**新 VM 网络不通、已有 VM 间歇丢包**，并在 `dmesg` 里留下：

```
neighbour: arp_cache: neighbor table overflow!
```

**推荐**：按节点 VM 上限的 2～4 倍取，`thresh1 < thresh2 < thresh3`。

| 节点 VM 上限 | `gc_thresh1` | `gc_thresh2` | `gc_thresh3` |
|---|---|---|---|
| 512 | 1024 | 2048 | 4096 |
| 2048 | 2048 | 6144 | 8192 |
| 4096（一个 `/20` 的量级） | 4096 | 12288 | 16384 |

`gc_thresh1` 是「低于此值不回收」，设太高会让陈旧表项一直不清理；取 VM 上限同量级即可。

```bash
sysctl -w net.ipv4.neigh.default.gc_thresh1=4096
sysctl -w net.ipv4.neigh.default.gc_thresh2=12288
sysctl -w net.ipv4.neigh.default.gc_thresh3=16384
```

查看当前用量：

```bash
ip -s neigh show | wc -l
```

## 连接跟踪 `nf_conntrack_max`

```
net.netfilter.nf_conntrack_max        内核默认随内存，常见 262144
net.netfilter.nf_conntrack_buckets    建议 = max / 4
```

同样先看实际值：实测那台 AWS 节点已是 `1048576`（也来自镜像的 `50-cloudimg-settings.conf`），无需再调。

**依据**：出网走 `nat` 表 REDIRECT，每条连接都会建一个 conntrack 条目；helper 到上游 SOCKS 的连接再占一条。所以每个 VM 的每条并发连接大约消耗 2 条。按每 VM 50 条并发估：

```
4096 VM × 50 并发 × 2 ≈ 410k 条
```

已经超过常见默认值。溢出后新连接被丢弃，`dmesg` 里是：

```
nf_conntrack: table full, dropping packet
```

**推荐**：`1048576`，buckets 取 `262144`。每条 conntrack 条目约 300 字节，1M 条约 300 MB 常驻内存——内存小的机器要按比例下调，不要照抄。

```bash
sysctl -w net.netfilter.nf_conntrack_max=1048576
echo 262144 > /sys/module/nf_conntrack/parameters/hashsize
```

## 本地端口范围 `ip_local_port_range`

```
net.ipv4.ip_local_port_range   默认 32768 60999（约 28k 个）
```

**依据**：helper 到上游的连接由宿主发起，源端口取自这个范围。端口按「源IP:源端口 → 目的IP:目的端口」四元组复用，所以限制是**对同一个上游地址**最多约 28k 条并发。多个 VM 共用同一个 SOCKS 上游地址时会先撞到这里。

注意这一项在折叠前后差别不大（宿主端口空间本来就是共享的），但规模上来后同样会撞。

**推荐**：

```bash
sysctl -w net.ipv4.ip_local_port_range="10240 65535"   # 约 55k
```

不要把下界压到 10240 以下，以免和常用服务端口冲突。

## helper 的描述符上限

helper 容器已经由控制面带上 `--ulimit nofile=1048576:1048576`，**不需要手工配**。记在这里是为了说明依据和它的边界：

- 每条 splice 连接占两个描述符（客户端侧 + 上游侧），再加 DNS 与 DoH 连接
- 实测真实节点上该上限已按 `nofile=1048576` 生效
- 它是**固定值**，不随 VM 数变化：这是容器参数，跟着成员数变会导致每次有 VM 加入就要重建容器，把热重载的意义抵消掉。描述符表是惰性增长的，用不到的上限不花成本

宿主侧需要允许这个值：

```bash
cat /proc/sys/fs/nr_open    # 需 ≥ 1048576，默认正好是 1048576
cat /proc/sys/fs/file-max   # 随内存，通常足够
```

另外，**这个上限只对新建容器生效**。容器摘要不包含 `--ulimit`，所以已经在跑的 helper 不会因为这个改动被重建，会一直用旧上限直到因别的原因重建。

## 一次性落盘

```bash
cat > /etc/sysctl.d/99-kin-shared-egress.conf <<'EOF'
# 共享出口：依据见 docs/egress-shared-kernel.md，按机器内存调整
net.bridge.bridge-nf-call-iptables = 1
net.ipv4.neigh.default.gc_thresh1 = 4096
net.ipv4.neigh.default.gc_thresh2 = 12288
net.ipv4.neigh.default.gc_thresh3 = 16384
net.netfilter.nf_conntrack_max = 1048576
net.ipv4.ip_local_port_range = 10240 65535
EOF
sysctl --system
```

`nf_conntrack` 的 hashsize 不是 sysctl，要在模块参数里持久化：

```bash
echo 'options nf_conntrack hashsize=262144' > /etc/modprobe.d/nf_conntrack.conf
```

## 子网必须对齐前缀边界

不是 sysctl，但同属「节点上才会暴露」的约束，记在这里：Docker 拒绝未对齐到前缀边界的子网。

```
docker network create --subnet 100.64.200.0/20 ...
Error response from daemon: invalid subnet 100.64.200.0/20: it should be 100.64.192.0/20
```

控制面的分配器按「索引 × 步长」计算，产出天然对齐，不需要额外处理。手工创建网络时要注意：`/20` 的第三段必须是 16 的倍数。

## 撞上了怎么判断

```bash
dmesg -T | grep -E 'neighbor table overflow|nf_conntrack: table full'
ip -s neigh show | wc -l                        # 对比 gc_thresh3
cat /proc/sys/net/netfilter/nf_conntrack_count   # 对比 nf_conntrack_max
ss -s                                            # 端口与 socket 总量
```

三类症状和对应参数：

| 症状 | 看 |
|---|---|
| 新 VM 完全不通，老 VM 间歇丢包 | `gc_thresh3` |
| 连接随机失败、重试能成 | `nf_conntrack_max` |
| 并发高时连同一个上游失败 | `ip_local_port_range` |
| 同节点 VM 之间能互相访问 | `bridge-nf-call-iptables`（安全问题，优先处理） |
