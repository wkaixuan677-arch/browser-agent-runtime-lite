# 架构说明

```mermaid
flowchart LR
    U[Task Contract] --> P[Agent Policy / Planner]
    P --> A[Semantic Browser Action]
    A --> G{Origin Request Guard}
    G -->|allowed| B[Playwright Tool Adapter]
    G -->|denied before request| X[Blocked]
    B --> O[Page Observation + Evidence]
    O --> V{Goal Verifier}
    V -->|success criteria met| F[Finalize]
    V -->|missing evidence| R[Recovery Controller]
    R -->|within budget| P
    R -->|budget exhausted| X[Partial / Blocked]
    M[(Promoted Memory)] -. safe hint .-> P
    P --> T[(Sanitized Trajectory)]
    A --> T
    V --> T
    R --> T
```

## 核心边界

- Policy 只能提出动作，不能自行宣布任务成功；
- Verifier 根据 Task Contract 与可观察证据决定是否完成；
- Recovery Controller 统一限制步数、失败动作重复和恢复次数；
- 只有 `promoted` Memory 可以被检索并注入 Policy 上下文，候选经验不会直接影响执行；
- Origin Request Guard 在导航请求发出前执行 allowlist 校验，禁止工具先访问再补判；
- Trajectory 只保存脱敏后的规划、动作、证据与恢复事件。

## 一次运行的关键时序

```mermaid
sequenceDiagram
    participant P as Policy
    participant R as Runtime
    participant B as Browser Tool
    participant V as Verifier
    P->>R: semantic action
    R->>B: execute within allowlist
    B-->>R: observation + evidence
    R->>V: verify contract
    alt evidence is sufficient
      V-->>R: completed
      R-->>P: finalize
    else action failed or evidence missing
      V-->>R: recovery reason
      R-->>P: bounded replan
    end
```
