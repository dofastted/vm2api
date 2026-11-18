# 开发流程

一页说清分支、工作树、验证与发版。CI 细节以 [`.github/workflows/`](../.github/workflows/) 为准，测试命令见 [README「开发验证与 CI」](../README.md#开发验证与-ci)。

## 分支

| 分支 | 用途 | 来源 | 合入方式 |
|---|---|---|---|
| `dev` | 日常集成，仓库默认分支 | — | 任务分支 PR |
| `main` | 只用于发布 | — | `dev` 的发版 PR，或 hotfix PR |
| `feat/<slug>` `fix/<slug>` `chore/<slug>` | 单个任务 | `origin/dev` | PR → `dev` |
| `hotfix/<slug>` | 线上紧急修复 | `origin/main` | PR → `main`，发版后把 `main` 合回 `dev` |

- 一个任务 = 一个分支 = 一个 PR。子任务也从 `origin/dev` 切，PR 目标是 `dev`，不要以其他任务分支为基线。
- 不直接 push `dev` / `main`，不强推共享分支，不改写已推送历史。
- PR 合并后删除远端任务分支。

## 工作树

主工作区固定停在 `dev`，只用来 `fetch` 和看代码，不在里面开发。每个任务单开工作树：

```sh
git fetch origin
git worktree add ../vm2api-wt-<slug> -b feat/<slug> origin/dev
# ……开发、提交、推送、开 PR 到 dev
git worktree remove ../vm2api-wt-<slug> && git branch -d feat/<slug>   # 合并后
```

工作树之间不复制未提交的改动、配置或二进制。

## 验证

本地只跑改动涉及的检查：

- 后端：`npm run test:ci`，加上本次改动的测试文件（`npm run test:unit -- <名称>`）。
- 前端：`pnpm -C web test:ci`，加上改动的测试文件；改了类型或构建配置时跑 `pnpm -C web build`。
- Go：只在改动的模块里跑 `go test ./...`。
- 只改文档时不跑业务测试。格式化只处理改过的文件，见 [FORMAT.md](FORMAT.md)。

全量回归、全仓格式检查和 ARM 构建交给 CI 手动触发（`ci` 工作流的 `full=true` / `arm64=true`），本地不重复。

## CI 触发

| 工作流 | 触发 | 跑什么 |
|---|---|---|
| `ci` | PR → `dev`/`main`；push `dev`；手动 | `changes` 按目录选择：只跑受影响组件的核心集与改动测试；纯文档或 `VERSION` 改动只做收尾 |
| `pr-rerun` | `dev` 的 `ci` 由红转绿 | 重跑因基线坏掉而失败的 PR |
| `release` | push `v*` tag；手动 | 校验 tag 在 `main` 上且等于 `VERSION`，再发附件与镜像 |
| `guest-images` | push `main` 且改动 `docker/kin-os`、`docker/kin-kvm` | 构建 guest 镜像 |

`ci` 始终会启动，再由 `changes` 决定跳过哪些步骤。它是必过检查，所以不能用 `paths-ignore` 跳过整个工作流，否则 PR 会一直挂着等待检查结果。

## 发版

1. 在 `dev` 上开一个 `chore/release-v<VERSION>` 分支，更新 `VERSION`、`CHANGELOG.md`，需要时更新 `deploy/payload.json`，PR 合入 `dev`。
2. 开 PR `dev → main`，用普通 merge（不 squash），保持两条分支历史一致。
3. 在 `main` 的合并提交上打 tag `v<VERSION>` 并推送，`release` 自动执行。
4. 核对附件和镜像，再按部署流程上线。发布与部署是两件事，见 [BUILD.md](BUILD.md)、[DEPLOY.md](DEPLOY.md)。

hotfix 发版时把第 1–2 步换成 `hotfix/<slug>` → `main`，第 3 步之后把 `main` 合回 `dev`。

## 任务流程

- 小改动（单文件、明确的修复）直接在任务分支上完成，不另建流程记录。
- 跨多个文件或需要设计取舍的任务，才建 Trellis 任务（`.trellis/`），一个 Trellis 任务对应一个任务分支。

## 边界与行为准则

**改动范围**
- 只改任务需要的文件，不顺手重构、改名或格式化无关代码。
- 新抽象至少被复用两次才建；不写没人要求的配置项或防御代码。
- 修 bug 先复现、再修根因；不靠重试、默认值、吞异常或改测试让检查变绿。

**分支与历史**
- 不直接 push `dev` / `main`，不强推共享分支，不移动或删除已发布的 tag。
- 别人（含自动化 Agent）推到 PR 分支的提交不覆盖：先 `fetch` 核对，有问题用 revert 并在 PR 留言。
- 提交只暂存本任务改过的文件，不用 `git add .`；工作区里不属于本任务的改动不碰。

**发布与部署**
- 合并、打 tag、发 Release、部署是四个独立动作，各自核对，不互相代替：CI 绿不等于已发布，已发布不等于已部署。
- 发布只从 `main` 打 tag；不为试改动手动触发 `release`。
- 不把明文核心、私钥、产品密钥、`bin/` 产物、本地配置提交进仓库；二进制只通过 `deploy/payload.json` 钉住。
- 不动生产的 `vms/`、`data/`、设备授权和 VM 调度状态，除非任务明确要求。

**汇报**
- 说明实际跑了哪些检查（核心集 / 定向 / 全量 / ARM / 生产），没跑的直接写没跑。
- 有不确定的地方先问，不靠猜测推进；需求完成就停，不追加无关改动。
