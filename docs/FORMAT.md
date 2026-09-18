# 格式

本地和 GitHub Actions 用同一套。全文 **LF**。提交前跑：

```bash
npm run format
npm run format:check
```

`format` 会依次：Biome 写 `src/` `test/` `scripts/*.mjs` → `gofmt -w worker` → Prettier 写 `web/`。

## 谁格式化哪一块

| 路径 | 工具 | 配置 | CI |
|---|---|---|---|
| `src/` `test/` `scripts/*.mjs` | Biome 2.5.11 | [`biome.json`](../biome.json)：2 空格、行宽 120、单引号、按需分号、LF | `unit`：`npx biome format` |
| `worker/` | gofmt | 语言默认 | `worker`：`gofmt -l worker` |
| `web/` | Prettier 3 | [`web/.prettierrc`](../web/.prettierrc)：行宽 80、无分号、LF、import 排序、Tailwind class 排序 | `web`：`pnpm format:check` |

Biome **不**包含 `web/`。不要对 Node 源码跑 Prettier，也不要对 `web/` 跑 Biome。

Rust 内核不跑 rustfmt 门禁。

## 换行

- [`.gitattributes`](../.gitattributes)：`* text=auto eol=lf`（二进制 ELF / wrap-cli 除外）
- [`.editorconfig`](../.editorconfig)：`end_of_line = lf`
- Biome `lineEnding: lf`；Prettier `endOfLine: lf`
- 本机仓库：`git config core.autocrlf false` 且 `git config core.eol lf`

Windows / WSL 不要开 `core.autocrlf=true`，否则工作区会变成 CRLF，`git status` 出现几百个假改动。检出后若仍是 CRLF：`git checkout -- .`

## 编辑器

`web/.vscode/settings.json` 把 TS/TSX 默认格式化设成 Prettier，`files.eol` 为 `\n`。根目录 `.vscode/` 不进 git。
