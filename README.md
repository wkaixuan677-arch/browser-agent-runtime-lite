# Browser Agent Runtime Lite

**An evidence-gated `plan → act → verify → recover` runtime with deterministic local Playwright demos.**

An Agent process stopping is not proof that the user's goal was completed. This clean-room reference implementation makes completion depend on visible browser evidence and keeps recovery strictly bounded.

> Independent personal project. This repository contains no employer code, internal prompts, private trajectories, credentials, or production data. It is not an employer-endorsed or production deployment.

## What it demonstrates

- Immutable task contracts with origin allowlists and execution budgets.
- Structured plans with explicit success criteria.
- Semantic browser actions using role and accessible name.
- A verifier that can reject premature `finish` decisions.
- Bounded recovery that prevents repeating the same failed action.
- Lifecycle-gated experience memory: only `promoted` entries are injectable.
- Sanitized, ordered trajectory events for debugging and evaluation.
- Three offline scenarios: success, recoverable failure, and explicit blocker.

```text
Task Contract
     ↓
   PLAN
     ↓
    ACT ──tool error──→ RECOVER ──bounded retry──┐
     ↓                                           │
   VERIFY ──missing evidence─────────────────────┘
     ↓
  FINALIZE
```

## Quick start

Requirements: Node.js 22+.

```bash
npm install
npx playwright install chromium
npm run demo
```

Expected summary:

```text
happy-path: COMPLETED | steps=1 recoveries=0
bounded-recovery: COMPLETED | steps=2 recoveries=1
explicit-blocked: BLOCKED | steps=0 recoveries=0
```

No API key is required. The browser opens a temporary local fixture served on `127.0.0.1`; no real website or external model is contacted.

For local development you may reuse an installed browser with `AGENT_BROWSER_CHANNEL=msedge` or `AGENT_BROWSER_CHANNEL=chrome`. CI always installs a pinned Playwright Chromium build.

## Why this is an Agent runtime

The policy proposes actions, but it does not own the success decision. `BrowserAgentRuntime` sends every result through `verifyGoal`. A `finish` action without the required URL and page text is rejected and consumes the recovery budget. Tool failures are recorded as action fingerprints so the same failed semantic target is not retried indefinitely.

Core interfaces are exported from [`src/index.ts`](src/index.ts):

- `TaskContract`
- `AgentPolicy`
- `BrowserAction`
- `VerificationReport`
- `ExperienceMemory`
- `RunResult`

The default demo uses `ScriptedPolicy` so the architecture is reproducible and reviewable without hiding behavior behind an API call. A real LLM adapter is intentionally a future extension.

## Test

```bash
npm run check
```

The tests cover evidence-gated completion, semantic-target recovery, premature-finish rejection, visible blocker handling, and Memory lifecycle gating. CI runs type checking, tests, and the complete local demo.

## Security boundaries

- Only explicitly allowed origins may be opened.
- Every browser run uses a fresh temporary context.
- The fixture accepts no login or personal data.
- The runtime does not bypass CAPTCHA, login walls, or access controls.
- Steps, recoveries, and elapsed time are bounded.
- Trajectory payloads remove local filesystem paths.

See [SECURITY.md](SECURITY.md) for reporting guidance.

## Limitations

- This is a small reference runtime, not a production browser automation service.
- The included policy is deterministic and does not prove LLM quality.
- The verifier currently supports URL and visible-text criteria only.
- The Memory example demonstrates lifecycle gating, not semantic retrieval quality.
- Real-web robustness, human evaluation, and multi-model generalization are not claimed.

## Roadmap

- Add a provider-neutral LLM adapter with structured outputs.
- Add screenshot evidence and stronger action-result verification.
- Export JSONL trajectories and a small evaluation report.
- Add reproducible real-web tasks that require no authentication.

The author's full 12-task Hard-suite evaluation is currently running in a separate private research prototype. No pending result is attributed to this repository.

## License and contributions

Released under the [MIT License](LICENSE). Contributions are welcome after reading [CONTRIBUTING.md](CONTRIBUTING.md).
