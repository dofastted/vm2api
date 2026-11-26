# advisor 工具

对齐 `src/lib/protocol/crag-whitelist.mjs`、`src/lib/protocol/claude-code-betas.mjs`、`src/lib/protocol/kernel-request.mjs`。日期 2026-11-26。

Anthropic 的服务端工具 `advisor_20260301`：用一个不弱于 executor 的顾问模型，在生成中途给出策略建议。executor 是请求顶层的 `model`，顾问是工具定义里的 `model`。

## 调用方实际发什么

Claude Code（2.1.x，`/advisor`、`--advisor`）发出的工具定义就是这四个键：

```json
{"type": "advisor_20260301", "name": "advisor", "model": "claude-opus-5-5", "defer_loading": true}
```

**没有** `max_uses`、没有 `caching` —— 那些是上游 API 的可选旋钮，真实流量只带 `defer_loading`。按文档补键集时容易只看前者，`defer_loading` 曾因此被白名单丢掉（见下「已修的遗漏」）。

同一轮里 Claude Code 还会往对话里放两样东西，它们与工具定义是一套，不要只处理 `tools`：

- 一条 `{"role": "system"}` 消息，正文以 `# Advisor Tool` 开头的使用指令结尾；
- 一个 `tool_addition` 块引用它：`{"type": "tool_addition", "tool": {"type": "tool_reference", "name": "advisor"}, "cache_control": {...}}`。

注意这里的 `tool_reference` 用 **`name`**，而顶层 `tool_reference` 内容块用的是 `tool_name`。`crag-whitelist.mjs` 用两套键集区分（`INLINE_TOOL_KEYS_BY_TYPE` 与 `BLOCK_KEYS_BY_TYPE`），改任一侧都不要混。

上游还接受三个可选字段：`max_uses`（本请求最多咨询几次，超出时结果块的 `content` 变成 `max_uses_exceeded` 错误对象）、`max_tokens`（单次咨询顾问自身输出的上限，thinking + text，触顶时结果块带 `stop_reason: "max_tokens"`）、`caching`（顾问自己那份 prompt 的缓存断点，形状同 `cache_control`，`ttl` 取 `5m` / `1h`）。

## 网关的校验与清洗

`crag-whitelist.mjs:513-525` 对 advisor 工具的契约字段 **fail-closed**，不满足就 400 `invalid native advisor tool definition`：

- `name` 必须正好是 `advisor`；
- `model` 必须是非空字符串。

上游契约里 advisor **不能带 `input_schema`**；如果调用方或中间网关误带了 `input_schema`，面板侧（`crag-whitelist.mjs` 与 `kernel-request.mjs`）以及 CRAG 侧（`crag-standalone` PR `#31`）会统一将其剥离而非拒绝整轮请求。通过之后按 `ADVISOR_TOOL_KEYS`（`:115-124`）重建，只保留 `type` / `name` / `model` / `max_uses` / `max_tokens` / `caching` / `defer_loading` / `cache_control`。

`kernel-request.mjs:62` 把 `advisor_20260301` 和 `custom` 一起跳过 provider 工具名校验 —— advisor 不参与「托管工具必须用官方名字」那套检查。

响应侧，`advisor_tool_result` 在 `PROVIDER_HISTORY_BLOCK_TYPES` 里放行，所以历史回传不会被剥。

## beta 声明：两条路径来源不同

上游用 `advisor-tool-2026-03-01` 门控这个工具。**两条推理路径各自声明，不要以为只有一处。**

**cli-node（kin-kernel）**：控制面每跳重建协议 beta（`outbound-attempt.mjs` / `go-worker-client.mjs`），调用方的入站 token 不透传，由 `withRequestProtocolBetas` 从 body 重新推导并写入 `body.betas` 交给槽内 `kin-kernel` → `cli-node` 合并进最终出站头。两个触发条件（`claude-code-betas.mjs`）：

- `tools` 里有 `type` 以 `advisor_` 开头的工具（如 `advisor_20260301`）；
- 历史里有任何 `advisor_tool_result` 块或 `server_tool_use`（`name === 'advisor'`）块。

第二条是必需的：后续轮次允许把工具从 `tools` 移除，但历史里重放的结果块**只在该 beta 仍被声明时才被接受**。该扫描放在 `output_config` 的 `continue` 之前，否则只能看到带 turn controls 的消息。

**CRAG**：槽内运行时自己声明（crag-standalone 的 `runtime/tui-request-options.mjs`，按 `body.tools` 含 advisor 类型或历史含 `advisor_tool_result` / `server_tool_use` name=advisor 来 `appendBeta`）。所以网关这份声明在 CRAG 路径上冗余但无害（`appendBeta` 去重）。

另外 `defer_loading` 会让 `withRequestProtocolBetas` 同时声明 `advanced-tool-use-2025-11-20`。beta 推导跑在**清洗后**的 body 上（`go-worker-client.mjs` 的 `main` 源自 `prepareCragRequest` 的输出），所以白名单丢掉字段会连带丢掉 beta —— 这是同一个因果，改键集时一起考虑。

## 响应形状

块类型恒为 `advisor_tool_result`，变的是它的 `content`，是个 discriminated union —— **要 switch `content.type`，不要 switch 块类型**：

| `content.type` | 字段 | 何时 |
|---|---|---|
| `advisor_result` | `text`、`stop_reason` | 顾问返回明文（较旧的顾问模型） |
| `advisor_redacted_result` | `encrypted_content`、`stop_reason` | 顾问返回加密内容 —— 当前各代模型都是这个 |
| `advisor_tool_result_error` | `error_code` | 咨询失败：`max_uses_exceeded`、`prompt_too_long`、`too_many_requests`、`overloaded`、`unavailable`、`execution_time_exceeded`、`model_not_found` |

无条件读 `.text` 的代码在现代顾问模型上会拿到空值，因为内容在 `encrypted_content` 下，且**只能原样重放、读不出来**。

## 两个上游约束

**配对**：顾问模型必须不弱于 executor，否则 400。同代或更强才行；具体可接受的组合随模型代次变化，以上游契约为准。

**历史即契约**：多轮里要把整个 `response.content`（含 `advisor_tool_result` 块）原样回传。另外，移除工具或改它的 `model` / `caching` 属于对 `tools` 的编辑，会让历史里已有的 thinking 块失效 —— 在强制执行历史编辑检查的模型上会 400。所以 `caching` 一次设定好，要改或要移除 advisor 就在新会话里做。

## 已修的遗漏

这几个都是「真实请求带某字段、白名单键集漏了它、`pickKeys` 静默丢掉」的同一形状，排查新问题时可作参照：

- `ADVISOR_TOOL_KEYS` 漏 `max_tokens` —— 调用方对顾问开销的上限被静默取消。
- `ADVISOR_TOOL_KEYS` 漏 `defer_loading` —— 真实流量唯一携带的那个字段；同一文件里 `CUSTOM_TOOL_KEYS` 早已放行它，只有 advisor 分支漏了。连带丢掉 `advanced-tool-use` beta。
- `kin-kernel`（独立私有仓库）的 `is_server_tool_type` 是手工前缀白名单，不含 advisor，于是 `#[serde(default)]` 合成的空 `input_schema` 被序列化出站，上游回 `tools.N.advisor_20260301.input_schema: Extra inputs are not permitted`。已改为「只有 custom 工具带 `input_schema`」。**该修复需要重编内核二进制并换 payload pin 才会生效于线上。**

排查 advisor 的 400 时先定位走哪条内核路径：CRAG 侧（crag-standalone）对 advisor 处处 fail-closed、原样透传，不会凭空加字段；会加 `input_schema` 的只有 kin-kernel 那条。
