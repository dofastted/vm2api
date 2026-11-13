# 文档

- [DEPLOY.md](DEPLOY.md) — 安装与升级（含 `deploy/install.sh` 一键安装 / 更新）
- [nginx-shell.md](nginx-shell.md) — 集群 / 槽运维终端 WebSocket 连不上时查 nginx Upgrade
- [开发验证与 CI](../README.md#开发验证与-ci) — 核心集、指定测试文件、按目录触发与手动全量 / ARM 检查
- [FORMAT.md](FORMAT.md) — 仅格式化改动文件；手动全量 CI 使用同一套 Biome / gofmt / Prettier 配置（LF）
- [API.md](API.md) — `/v1`
- [RISK.md](RISK.md) — 封控拦截（蒸馏 → 硬正则 → 拒答缓存 → 决策模型 → 放行出站）
- [PANEL_API.md](PANEL_API.md) — 管理台 API
- [AFO_INTEGRATION.md](AFO_INTEGRATION.md) — AFO 平台对接的 `/api/v1` 兼容层规格（未实现）
- [redaction/README.md](redaction/README.md) — 可启停内容脱敏：默认关闭；helper 未就绪时阻断，不发明文
- [ISSUE_BACKLOG.md](ISSUE_BACKLOG.md) — open issue 复核后暂不修复的清单（2026-10-28）
- 抄本：[deploy/env.example](deploy/env.example) · [deploy/vm2api.service](deploy/vm2api.service)

总览：[README](../README.md)。版本：[CHANGELOG.md](../CHANGELOG.md)

入门站：[vm2api.fkcodex.com/zh](https://vm2api.fkcodex.com/zh/)（对照 1.3.133）。

Telegram：[t.me/VM2API](https://t.me/VM2API)
