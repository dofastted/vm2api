# 槽位伴生浏览器桌面

给 Docker 槽配一个可选的浏览器桌面：独立容器跑 Xvfb + fluxbox + Chromium + x11vnc，
与槽容器**共享网络命名空间**，浏览器流量走槽位出口（同一出口 IP、同一 DNS-over-TCP 重定向，
UDP/QUIC 被槽位出口规则丢弃，不会旁路泄露）。面板槽位详情的「桌面」页签直接在网页里操作这个浏览器，
不需要 SSH 隧道或额外的远程桌面服务。

## 使用场景

- **在槽位出口 IP 上完成网页侧操作**：账号首次登录、浏览器内人机验证、OAuth 授权页、
  邮箱验证码、账单 / 订阅页查看。这些操作若在运维者本机或另一台机器上完成，网页侧看到的 IP、
  时区与槽位 API 流量不一致；伴生桌面让网页侧与 API 侧同源。
- **排查出口问题**：直接在槽位出口上打开目标网站，确认是出口被拦还是客户端问题。
- **集群节点槽**：远端 VPS 上的槽同样适用，面板经节点的 Docker Engine API 连接，无需在节点上开端口。

## 开启方式

- 面板：槽位详情 →「桌面」页签（与「运维」同级，仅管理员）→ 打开开关，再点「打开桌面」。
- API：`POST /api/panel/vms/:id/desktop` `{"enabled": true}`；建槽时 `POST /api/panel/vms/create` 带 `"desktop": true`。

只有管理员可用（浏览器资料里有登录态）。GPT 槽、KVM 槽、macOS 原生节点不支持。

## 设计要点

| 项 | 做法 |
|---|---|
| 网络 | `NetworkMode: container:<槽容器 id>`，不发布任何端口 |
| 隔离 | 只读 rootfs、`cap-drop ALL`、`no-new-privileges`，独立内存（默认 1.5G，`KIN_DESKTOP_MEMORY`）与 pids 配额，不占槽位预算 |
| 访问通道 | x11vnc 只监听容器私有 `/tmp` 下的 unix socket；面板经 Engine API 非 TTY `docker exec socat` 透传 RFB，再由票据 WebSocket 交给 noVNC |
| X 显示 | Xvfb `-nolisten local` 不开抽象 socket（抽象 socket 随网络命名空间与槽共享）；显示号避开槽内已占用的号 |
| 持久化 | 浏览器资料在命名卷 `<槽容器>-desktop-home`，关闭桌面保留，删除 / 重置槽位时清除 |
| 镜像 | `ghcr.io/<owner>/kin-desktop:debian-12`（`docker/kin-desktop/`），`KIN_DESKTOP_IMAGE` 可覆盖；首次开启时按需拉取 |
| 槽位重启 | 加入网络命名空间发生在容器启动时；槽位启动 / 重载与每次打开桌面时比较启动时间，必要时重启或重建伴生容器 |

## 注意

- Chromium 在 `cap-drop ALL` 下无法启用自身沙箱，以 `--no-sandbox` 运行，隔离边界是容器本身。
- 槽位因空闲退出等原因被 Docker 自动重启后，伴生容器会暂时失去网络，下次打开桌面时自动恢复。
- 桌面里的浏览器指纹是 Debian Chromium 的真实指纹，不做伪装；时区取槽位 `timezone`。
