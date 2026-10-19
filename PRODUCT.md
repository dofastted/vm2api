# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

本机管理员。在深色运维控制台里打开某个虚拟机槽位，核对并改写该槽 Claude Code 的种子配置。

## Product Purpose

vm2api 把 Claude / Codex 账号做成可调度的虚拟机槽，并对外提供兼容上游的 API。种子页的成功标准：管理员不用进容器，就能看见当前槽 `settings.json` 里实际生效的配置项，改完能播种，并实时看到遥测开或关。

## Positioning

种子不是一份预设表单。它读当前槽家目录里已经写好的 Claude 配置，按文件内容逐项显示，再把改动写回同一份文件。

## Operating Context

管理员在 `/vm/$id` 的「种子」页签工作。数据来自该槽 `cli-home/.claude/settings.json`、`claude.setting` 和种子策略。遥测进程状态来自槽详情里的实时观测。

## Capabilities and Constraints

- 显示当前槽 `settings.json` 的真实键值，而不是只显示种子策略里的默认串。
- `claude.setting` 以可编辑文本提供，保存时写回并重新播种。
- 遥测开、关状态实时刷新；配置开关和进程是否在跑是两件事。
- 「拒客户端 settings」和「拒客户端身份」按当前策略准确显示，并可切换。
- 平台是现有 React 面板，不另起一套视觉系统。

## Product Principles

- 槽内文件是事实，表单默认值不是。
- 开和关都要能被看见，未知不能伪装成关闭。
- 能改的项和只读观测分开。
- 播种是显式动作，不在切换开关时偷偷写盘。
