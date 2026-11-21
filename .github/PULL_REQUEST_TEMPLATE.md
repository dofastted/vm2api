<!--
提交前确认两件事：

1. 目标分支（base）必须是 `dev`。功能与修复 PR 一律指向 `dev`；`main` 只接受
   `dev → main` 的发版 PR 或 `hotfix/<slug>`，tag 只打在 `main` 上。
   base 选错不用重开 PR：点标题下方的 base 下拉框改成 `dev` 即可。
2. 分支从 `origin/dev` 切出，命名 `feat|fix|chore/<slug>`，不要叠在别的任务分支上。

完整规则见 docs/DEVELOPMENT.md。

The base branch must be `dev`, branched from `origin/dev`. `main` only takes release
PRs from `dev` or `hotfix/<slug>`. If you opened this against `main`, switch the base
with the dropdown above — there is no need to reopen the PR.
-->

## 问题与结果

<!-- 改之前是什么行为，改之后是什么行为。关联 issue 写 `Fixes #1234`。 -->

## 实现

<!-- 关键改动与取舍，不必逐文件罗列。涉及协议、数据库迁移或兼容性时写明。 -->

## 验证

<!--
写实际跑过的命令和结果，例如：

- 后端 `npm run test:ci`，加上本次改动涉及的测试文件
- 前端 `pnpm -C web test:ci`、TypeScript 检查与生产构建
- 改动文件的格式检查（方法见 docs/FORMAT.md）

没跑的项写明原因。不要靠重试或忽略失败制造绿灯。
-->
