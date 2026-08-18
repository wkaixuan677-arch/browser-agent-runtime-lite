import type { AgentPolicy, BrowserAction, BrowserObservation, RunResult, TaskContract, VerificationReport } from './types.ts'
import { validateTaskContract } from './contract.ts'
import { BrowserTools } from './browser-tools.ts'
import { WorkingMemory, actionFingerprint } from './memory.ts'
import { TrajectoryRecorder } from './trajectory.ts'
import { verifyGoal, visibleBlocker } from './verifier.ts'

export class BrowserAgentRuntime {
  constructor(
    private readonly policy: AgentPolicy,
    private readonly tools: BrowserTools,
    private readonly recorder = new TrajectoryRecorder(),
  ) {}

  async run(taskInput: TaskContract): Promise<RunResult> {
    const task = validateTaskContract(taskInput)
    const memory = new WorkingMemory()
    let observation = await this.tools.open(task.startUrl)
    let verification = verifyGoal(task, observation)
    let recoveries = 0
    let steps = 0
    let recoveryHint: string | undefined

    this.recorder.record('run.started', 'observe', { taskId: task.id, objective: task.objective })
    this.recorder.record('observation.captured', 'observe', observation)

    const blocker = visibleBlocker(task, observation)
    if (blocker) return this.finish(task, 'blocked', `BLOCKED: ${blocker}`, steps, recoveries, verification)

    const plan = await this.policy.createPlan({ phase: 'plan', task, observation, failedActionFingerprints: [] })
    this.recorder.record('plan.created', 'plan', plan)

    const deadline = Date.now() + task.budget.timeoutMs
    while (steps < task.budget.maxSteps && Date.now() < deadline) {
      const phase = recoveryHint ? 'recover' : 'act'
      const action = await this.policy.nextAction({
        phase,
        task,
        plan,
        observation,
        failedActionFingerprints: memory.failedActionFingerprints(),
        ...(recoveryHint ? { recoveryHint } : {}),
      })
      recoveryHint = undefined
      steps += 1
      this.recorder.record('action.selected', phase, action)

      if (action.kind === 'finish') {
        verification = verifyGoal(task, observation)
        this.recorder.record('verification.finished', 'verify', verification)
        if (verification.passed) return this.finish(task, 'completed', action.answer, steps, recoveries, verification)
        recoveries += 1
        if (recoveries > task.budget.maxRecoveries) {
          return this.finish(task, 'blocked', 'BLOCKED: completion evidence is missing', steps, recoveries - 1, verification)
        }
        recoveryHint = 'The finish request was rejected because the success criteria are not visible.'
        this.recorder.record('recovery.chosen', 'recover', { reason: recoveryHint })
        continue
      }

      this.recorder.record('tool.started', 'act', { actionId: action.id, kind: action.kind })
      const outcome = await this.tools.execute(action)
      observation = outcome.observation
      this.recorder.record('tool.finished', 'act', outcome)

      if (!outcome.ok) {
        const repeatCount = memory.recordFailure(action)
        recoveries += 1
        if (!outcome.error.retryable || repeatCount > 1 || recoveries > task.budget.maxRecoveries) {
          verification = verifyGoal(task, observation)
          return this.finish(task, 'blocked', `BLOCKED: ${outcome.error.code}`, steps, Math.min(recoveries, task.budget.maxRecoveries), verification)
        }
        recoveryHint = `Avoid failed action ${actionFingerprint(action)}. Visible targets: ${observation.interactive.map((item) => item.name).join(', ')}`
        this.recorder.record('recovery.chosen', 'recover', { reason: recoveryHint, recoveries })
        continue
      }

      verification = verifyGoal(task, observation)
      this.recorder.record('verification.finished', 'verify', verification)
      if (verification.passed) {
        return this.finish(task, 'completed', 'Goal completed with visible page evidence.', steps, recoveries, verification)
      }
    }

    verification = verifyGoal(task, observation)
    const reason = Date.now() >= deadline ? 'BLOCKED: timeout budget exhausted' : 'BLOCKED: step budget exhausted'
    return this.finish(task, 'blocked', reason, steps, recoveries, verification)
  }

  private finish(
    task: TaskContract,
    status: RunResult['status'],
    answer: string,
    steps: number,
    recoveries: number,
    verification: VerificationReport,
  ): RunResult {
    this.recorder.record('run.finished', 'finalize', { status, answer, steps, recoveries, verification })
    return { taskId: task.id, status, answer, steps, recoveries, verification, trajectory: this.recorder.snapshot() }
  }
}
