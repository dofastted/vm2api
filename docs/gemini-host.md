# Gemini 宿主机候选

「导入 → Gemini」创建宿主机环境。「虚拟机」页将 Gemini 账号显示在同一机架和列表中，管理员可按平台筛选，并从账号详情授权或刷新。不创建 VM、Docker 槽、VM 调度记录或 `vm.json`。默认不启用，仅管理员可操作。服务运行在 Linux amd64 宿主，Docker 控制面通过只读挂载的 Unix socket 目录连接；ARM64 和远端集群不受支持。

## 启用服务与自动安装

1. 反代源码保留在独立 `antigravity-cli-proxy` 仓。供应方使用 `scripts/package-release.sh` 构建 `craggemini` 和 `libagy_bridge.so`，再用该仓的 `scripts/sign-host-payload.sh` 签署预装包。包只含这两个二进制、摘要固定的官方 `agy 1.5.9`、清单和签名。不在 vm2api 提交反代源码、二进制、发行私钥或 OAuth 凭据。
2. 从独立信任渠道设置 `/etc/vm2api/gemini-ed25519.pub`，把已解包的签名载荷放入 root 所有且不可由非 root 写入的绝对目录（例如 `/srv/vm2api-gemini-payload`，不能位于 `/tmp`）。候选包的测试签名不能当成发行签名。不要把签发私钥放到部署机。
3. 宿主需有 `systemd`、`ip`、`nft`、`setpriv`、支持非特权用户命名空间的 `bwrap`、`curl`、`python3`、系统路径可用的 `node`，以及 vm2api 自带的 `kin-egress`。Google 授权需要 IPv4 转发；预留示例的 9 个 UID/GID 与 `198.18.252.0/27`，确认网段无冲突。若宿主有 Docker 的 `iptables` `DOCKER-USER` 链，授权时只临时允许当前环境与绑定 SOCKS5 地址和端口之间的转发，结束后删除规则。其他防火墙仍需允许同一范围的转发；不要调整全局转发策略或开放直连。
4. 现有部署先升级控制面和 Compose 配置，再在宿主运行 `sudo bash deploy/install.sh prepare-gemini --gemini-payload-source /srv/vm2api-gemini-payload`；新安装可直接传同一选项。已用标准路径安装载荷的部署可省略安装源。使用独立 Node 网关时，将网关进程加入 `vm2api` 组，并重启网关让组权限生效。默认 socket 是 `/run/vm2api-gemini/control.sock`，可用 `KIN_GEMINI_HOST_SOCKET` 覆盖。已有自定义 unit 应先迁移，避免两个服务争用 socket；保留原状态目录。
5. 服务不再依赖载荷已安装才能监听。首次在面板创建 Gemini 环境时，自动校验 Ed25519 签名、文件大小、文件摘要和固定的 `agy` 摘要，再将完整载荷原子安装到 `share/gemini/current`。安装失败不创建环境。已安装载荷在重启时复验；不会覆盖损坏的现有载荷，不从不可信地址下载。面板区分服务未连接、缺少安装源和校验失败；宿主可用 `journalctl -u vm2api-gemini.service` 核对日志。

## 导入与验收边界

- 在面板为环境选平台所有的可用 IPv4 SOCKS5 节点。宿主服务使用独立 UID、文件系统隔离和独立网络命名空间；`agy` 无直连规则，只有 `kin-egress` 可向选定 SOCKS5 的地址和端口建立出站连接。首版不接直连、HTTP 代理或域名型代理端点。
- **Google OAuth**：打开 CLI 生成的官方链接，回填授权码或完整回调链接。完整链接的 `state` 必须匹配当前授权尝试。CLI 持有凭据；不在面板填写 Google 密码、访问令牌或刷新令牌。尝试最多 5 分钟；停用或删除可取消等待中的授权。
- **Gemini API Key**：经绑定代理调用 Google 模型列表验证凭据，再以仅宿主服务可读的权限保存。模型列表不是推理验收；该凭据通道不返回账号邮箱、订阅或按模型使用配额。
- 两种方式都在 VM 页显示环境、代理绑定、授权状态、载荷版本和可读取的数据。「刷新数据」经绑定代理读取 Google 响应：OAuth 按可用权限读取账号、项目、订阅、模型、配额及 Credits，API Key 读取模型。没有返回的字段标为未提供，不显示为零。凭据失效时需重新授权或导入；尚未启用 OAuth 自动续票。宿主服务的状态目录不纳入 VM 包或面板备份。
- `0.3.0-rc.1` 已用真实 `agy` 验证受管 PTY 和隔离回环上游 SSE。自动安装和数据读取可用本地夹具验证；真实 Google 换票和 OAuth 推理未验收，不标记推理就绪。
- 可使用非 root 账号运行 `bash test/deploy/gemini-host-egress-smoke.sh /absolute/path/kin-egress`，在一次性 Linux 命名空间用 `iptables` 模拟 Docker 的默认转发丢弃策略，检查选定 SOCKS5 的透明转发、转发器退出后失败和网络清理。该测试不访问 Google 或主机代理池。
- 有测试签名产物时，可在带 Node 和 Python 的一次性 Linux amd64 容器内以 root 运行 `bash test/deploy/gemini-host-install-smoke.sh /path/to/signed-payload /path/to/public-key`。禁用容器网络即可验证 Unix socket 启动、签名失败不建环境、首次创建自动安装和重启持久化。
- 管理员可生成 `Gemini · CRAGAnti` 专用密钥，只能访问 Gemini 会话入口及密钥查询，不会落入 Claude、Codex 或 API 直连。当前二进制的推理桥仅验收过 Gemini API Key provider；即使 Google OAuth 已授权，`/v1/gemini/sessions` 也会返回 `gemini_runtime_not_supported`，不会分配会话或扣费。对外推理还需支持 OAuth 的载荷及逐回合可核销的官方结算；不把订阅等级、Token 数或余额变化当成实扣凭证。
