# 典型案例：Agent 为什么需要证据、恢复与路由

这三个案例用于解释 Browser Agent Runtime 的核心工程判断。公开仓库提供可重复的本地机制演示；其中完整 Hard 数据来自脱敏聚合实验，不能在本仓库复现私有原始轨迹。

## 案例一：进程结束，但任务没有完成

**问题**：Agent 打开页面后直接输出 `finish`。进程正常退出，但没有取得任务要求的可见文本或 URL 证据。

**处理**：Runtime 不接受 Policy 自行宣布成功。每次 `finish` 都必须经过 `verifyGoal`；证据不足时进入恢复流程，预算耗尽后返回 `BLOCKED`，而不是伪造 `COMPLETED`。

**公开验证**：测试覆盖 `premature finish`、0 步终止、最终回答与证据不一致等情况。

## 案例二：工具失败后重复同一动作

**问题**：点击没有产生页面变化，Agent 继续在相同状态执行相同动作，形成循环并消耗 Token。

**处理**：Runtime 为失败动作生成指纹，记录恢复次数，并禁止在同一状态无限重复。超过 `maxRecoveries` 或截止时间后，输出带原因的终止轨迹。

**公开验证**：`bounded-recovery` 演示注入一次瞬时失败，第二次采用不同恢复路径完成任务；测试同时验证恢复预算有界。

## 案例三：Multi-Agent 不应默认全量启用

**观察**：完整 12 条单目标 Hard 配对复跑中，Single 与 Multi 均为 `12/12`；Single 总步骤/Token 为 `37 / 336,659`，Multi 为 `69 / 858,477`。

**结论**：在 Single 已达到成功率天花板的任务上，Multi 没有成功率收益，却带来约 `2.55×` Token 开销。因此下一阶段应实现难度与风险识别：简单任务走 Single，复杂任务才升级为 Multi。

**边界**：这是动态路由的实验依据，不是本仓库已经实现或验证动态路由收益的声明。完整公开口径见 [Agent Eval Lab 实验卡](https://github.com/coolwkx/agent-eval-lab/blob/main/docs/HARD_SUITE_EXPERIMENT_CARD.md)。

## 面试时如何概括

> 我把“模型说完成”改成“系统验证完成”，再用失败指纹和预算约束恢复；实验还发现 Multi-Agent 并非越多越好，所以后续架构重点是按任务难度动态路由，而不是默认堆 Agent。
