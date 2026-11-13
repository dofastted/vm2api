# 格式

本地和 GitHub Actions 的手动全量检查使用同一套配置，换行统一为 **LF**。日常 CI 不以全仓格式检查作为必过条件；仅在手动运行 `ci` 工作流并设置 `full=true` 时执行全仓格式检查，详见 [开发验证与 CI](../README.md#开发验证与-ci)。

提交前只格式化本次修改的文件。例如，在仓库根目录处理本次涉及的 Node / JSON 文件：

```bash
npx biome format --write package.json scripts/run-isolated-tests.mjs
npx biome format package.json scripts/run-isolated-tests.mjs
```

前端文件在 `web/` 下使用项目 Prettier 配置，例如 `pnpm -C web exec prettier --write package.json`；检查时把 `--write` 换成 `--check`。Go 文件使用 `gofmt -w`，显式列出本次修改的 `.go` 文件。保持已有文件编码，不擅自将非 UTF-8 文件转码；新增文件使用 UTF-8（无 BOM）。

`npm run format` / `npm run format:check` 是原有全仓工具，只有明确需要全仓处理时才使用。`format` 会依次：Biome 写 `src/` `test/` `scripts/*.mjs` 等配置范围 → `gofmt -w worker` → Prettier 写 `web/`；它不会格式化 `api-kernel/` 和 `redact/`。

## 谁格式化哪一块

| 路径                                                | 工具         | 配置                                                                                           | 手动全量 CI（`full=true`）                |
| --------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `src/` `test/` `scripts/**/*.mjs`、根目录 JSON 配置 | Biome 2.5.11 | [`biome.json`](../biome.json)：2 空格、行宽 120、单引号、按需分号、LF                          | `ci`：`npx biome format`                  |
| `worker/` `api-kernel/` `redact/`                   | gofmt        | 语言默认                                                                                       | `ci`：`gofmt -l worker api-kernel redact` |
| `web/`                                              | Prettier 3   | [`web/.prettierrc`](../web/.prettierrc)：行宽 80、无分号、LF、import 排序、Tailwind class 排序 | `ci`：`pnpm -C web format:check`          |

Biome **不**包含 `web/`。不要对 Node 源码跑 Prettier，也不要对 `web/` 跑 Biome。

Rust 内核不跑 rustfmt 门禁。

## 换行

- [`.gitattributes`](../.gitattributes)：`* text=auto eol=lf`（二进制 ELF / wrap-cli 除外）
- [`.editorconfig`](../.editorconfig)：`end_of_line = lf`
- Biome `lineEnding: lf`；Prettier `endOfLine: lf`
- 本机仓库：`git config core.autocrlf false` 且 `git config core.eol lf`

Windows / WSL 不要开 `core.autocrlf=true`，否则工作区会变成 CRLF，`git status` 出现几百个假改动。已有 CRLF 只针对本次涉及的文本文件按对应格式配置处理，不对全仓执行恢复或换行归一化。

## 编辑器

`web/.vscode/settings.json` 把 TS/TSX 默认格式化设成 Prettier，`files.eol` 为 `\n`。根目录 `.vscode/` 不进 git。
