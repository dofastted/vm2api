# Gemini 宿主机候选

「导入 → Gemini」管理宿主机环境，不创建 VM、Docker 槽、VM 调度记录或 `vm.json`。候选默认不启用，仅管理员可操作。需要原生 Linux amd64；Docker 控制面、ARM64 和远端集群不在支持范围。

## 预装与启用

1. 反代源码保留在独立 `antigravity-cli-proxy` 仓。供应方使用 `scripts/package-release.sh` 构建 `craggemini` 和 `libagy_bridge.so`，再用该仓的 `scripts/sign-host-payload.sh` 签署预装包。包只含这两个二进制、摘要固定的官方 `agy 1.5.9`、清单和签名。不在 vm2api 提交反代源码、二进制、发行私钥或 OAuth 凭据。
2. 从独立信任渠道配置 Ed25519 发行公钥。用 `node scripts/install-gemini-payload.mjs --source <已解包目录> --public-key <公钥> --dest <新安装目录>` 校验签名和三个文件后安装。服务启动会复验全包；不会在导入或推理时下载、升级或混用 CLI。候选包的测试签名不能当成发行签名。
3. 宿主需满足 `deploy/gemini-host.service.example` 的前置条件：`ip`、`nft`、`setpriv`、支持非特权用户命名空间的 `bwrap`、`python3`、`node`、`kin-egress`，以及开通 IPv4 转发。预留示例的 9 个 UID/GID 与 `198.18.252.0/27`，确认与现有网段无冲突，并允许该受管网段转发至指定 SOCKS5 节点；不要为此放开其他网段。服务代码、载荷目录和签名公钥必须由 root 所有且不可由非 root 写入，部署目录不要用符号链接。
4. 按示例安装宿主服务，把网关进程加入指定组，给网关配置 `KIN_GEMINI_HOST_SOCKET=/run/vm2api-gemini/control.sock`。Unix socket 不对公网开放。未配置或校验失败时，面板显示不可用；原有渠道不受影响。

## 导入与验收边界

- 在面板为环境选平台所有的可用 IPv4 SOCKS5 节点。宿主服务使用独立 UID、文件系统隔离和独立网络命名空间；`agy` 无直连规则，只有 `kin-egress` 可向选定 SOCKS5 的地址和端口建立出站连接。首版不接直连、HTTP 代理或域名型代理端点。
- 发起 Google 授权，打开 CLI 生成的官方链接，回填浏览器显示的授权码。CLI 处理换票并持有凭据；不在面板填写 Google 密码、API Key 或访问令牌。每次尝试最多 5 分钟；停用或删除可取消仍在等待的授权。宿主服务的状态目录不纳入当前 VM 包或面板备份。
- 候选已用真实 `agy` 验证受管 PTY，以及隔离回环测试上游下的原生 SSE。官方登录链接可生成；真实 Google 换票、刷新和 OAuth 推理分支未验收。`0.3.0-rc.1` 不因测试上游走通而标记 OAuth 推理就绪。
- 可使用非 root 账号运行 `bash test/deploy/gemini-host-egress-smoke.sh /absolute/path/kin-egress`，在一次性 Linux 命名空间检查选定 SOCKS5 的透明转发、转发器退出后失败和网络清理。该测试不访问 Google 或主机代理池。
- `/v1/gemini/sessions` 命名空间保持付费关闭，鉴权后返回 `gemini_official_billing_unavailable`，不分配会话或扣费。没有逐回合可核销的官方金额，不启用 Gemini 专用调用密钥、对外推理或美元结算；不把订阅等级、Token 数或余额变化当成实扣凭证。
