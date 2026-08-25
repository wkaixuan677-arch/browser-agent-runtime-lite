# Changelog

## [0.3.0] - 2026-08-19

- 用同一个任务截止时间约束 `open`、`observe`、`createPlan`、`policy.nextAction` 与 `tool` 阶段；
- 将阶段超时收口为 `blocked`、未预期异常收口为 `failed`，两类情况都生成 `stage.failed` 和 `run.finished` 轨迹；
- 对输入文本、常见 Token/API Key、Bearer 凭据、邮箱、URL 查询参数和本地路径进行轨迹脱敏，并限制观察文本长度；
- 统一记录首屏与动作后的观察和验证状态，补充超时、异常、脱敏及预算耗尽回归测试。
- 将 Task Contract 和 Policy 上下文深冻结，Runtime 对每次观察复核来源，防止策略篡改任务或使用越界证据伪造完成；
- 使用 BrowserContext 请求守卫覆盖 popup 首请求与跨域重定向，并明确 Service Worker 与非网络沙箱边界；
- 超时后调用浏览器取消入口并禁止复用当前 Runtime，工具结果会在后置观察前先写入轨迹；
- 将 npm 包标记为私有，明确该仓库是可运行的参考实现，不承诺稳定 SDK API。
- 将 CI 使用的 GitHub Actions 固定到已核验的提交，降低上游标签漂移风险。

## [0.2.0] - 2026-08-19

- 将 `promoted` Memory 真正检索并注入 Policy 上下文，同时记录可审计的 Memory ID；
- 在网络请求发出前拦截跨域导航，补齐首屏完成和动作后阻断判定；
- 加强 URL 路径校验与命中证据片段，扩充关键边界测试；
- 统一 CI、依赖更新、作品集导航与公开限制说明。

## [0.1.0] - 2026-08-19

- 发布证据门控的 Plan–Act–Verify–Recover 最小运行时；
- 增加语义浏览器工具、Task Contract、有限恢复和 Memory 生命周期门控；
- 提供三类确定性本地场景、自动测试、架构图、演示 GIF 与面试材料。

[0.1.0]: https://github.com/coolwkx/browser-agent-runtime-lite/releases/tag/v0.1.0
[0.2.0]: https://github.com/coolwkx/browser-agent-runtime-lite/compare/v0.1.0...v0.2.0
[0.3.0]: https://github.com/coolwkx/browser-agent-runtime-lite/compare/v0.2.0...v0.3.0
