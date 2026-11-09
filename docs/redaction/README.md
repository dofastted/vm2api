# vm2api Node 脱敏插件设计

本目录是 **vm2api 当前仓库内的权威设计资料**。目标是在现有 **Node 请求清洗链路**中接入可开启/关闭的关键元素脱敏，并提供 **Web 控制面板**进行配置、保存和状态展示。

当前状态：**默认关闭，helper/Node 边界已用 replay 验证。** `node scripts/redaction-replay.mjs` 对 V01、V03、V05、V06、V07、V10、V15、V17 为 9/9 通过（真实 `kin-redact`，无上游厂商）。这不覆盖真实 kernel/CLI/Codex ELF 抓包，也不覆盖 V02 面板、V04 并发保存、V18 continuation、V20 日志落盘。

## 阅读顺序

| 文件 | 内容 |
| --- | --- |
| [prd.md](prd.md) | 用户目标、Node 清洗/面板范围与本轮设计验收 |
| [design.md](design.md) | 清洗阶段、开关、关键元素、状态隔离、各协议和 Web 面板契约 |
| [implement.md](implement.md) | 实施文件、步骤及 V01–V22 验收场景 |
| [evidence.md](evidence.md) | 参考归档身份与当前源码证据 |
| [verification.md](verification.md) | 已执行的核心 smoke、文档检查和未验证范围 |

## 接入方案

- **Node 是唯一清洗入口和策略所有者**：先识别原始身份/用途，完成既有协议清洗，再调用共享的内容脱敏阶段；发送前仍复核最终 Node 正文，防止 persona 重渲染引回原值。
- **关键元素可选择**：凭据/秘密、个人信息、自定义敏感词和 RE2 规则。协议 ID、签名、schema 结构和二进制内容不做盲目替换。
- **总开关默认关闭**：`routing.redaction.enabled`。关闭不清空配置、不影响既有安全清洗；已开始的请求保持自己的策略，避免截断恢复中的流。
- **Web 面板属于必交付内容**：现有设置 → 协议增加内容脱敏区，复用草稿、保存/放弃、错误保留和刷新持久化流程，不另造插件安装页。
- **复用本地 Go 算法**：Node 调用受控本机 helper，不迁入 AgentDock 的插件框架，不改供应商出口；开启后处理不可用即阻断，不回落明文。

signed thinking 保留厂商原文/标签，不透明还原；不安全签名历史或跨代 continuation 返回明确错误。图片像素、opaque 加密内容和认证/路由元数据不属于正文脱敏承诺。

## 来源与验证

参考源码来自 `D:\AgentDock\deliverables\redact-analysis`，其原 ZIP 和校验文件保持原样。已隔离运行参考核心，验证文本/中文词、嵌套工具参数和跨三个 SSE 事件、六个写入片段的往返还原；这不代表新 Node 插件或 Web 面板已运行。

`FILES.sha256` 标识本目录设计文档，不包含自身。Trellis 的本地任务文件只记录任务状态并链接到这里，不是第二份独立维护的设计。后续修改和提交均在当前仓库完成，不再发布到 AgentDock 项目。
