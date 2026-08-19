import type {
  AgentPolicy,
  BrowserAction,
  BrowserObservation,
  BrowserToolAdapter,
  RunResult,
  TaskContract,
  VerificationReport,
} from './types.ts'
import { validateTaskContract } from './contract.ts'
import { ExperienceMemoryStore, WorkingMemory, actionFingerprint } from './memory.ts'
import { redactSensitiveText, TrajectoryRecorder } from './trajectory.ts'
import { verifyGoal, visibleBlocker } from './verifier.ts'

type RuntimeStage = 'run' | 'open' | 'createPlan' | 'policy.nextAction' | 'tool' | 'observe' | 'verify'
type StageFailureKind = 'timeout' | 'exception' | 'origin' | 'unusable'

class StageFailure extends Error {
  constructor(
    readonly stage: RuntimeStage,
    readonly kind: StageFailureKind,
    message: string,
  ) {
    super(message)
  }
}

export class BrowserAgentRuntime {
  private unusableAfterTimeout = false
  private cancellationRequested = false

  constructor(
    private readonly policy: AgentPolicy,
    private readonly tools: BrowserToolAdapter,
    private readonly recorder = new TrajectoryRecorder(),
    private readonly experienceStore = new ExperienceMemoryStore(),
  ) {}

  async run(taskInput: TaskContract): Promise<RunResult> {
    const task = deepFrozenClone(validateTaskContract(structuredClone(taskInput)))
    this.recorder.reset()
    let verification = emptyVerification()

    this.recorder.record('run.started', 'observe', {
      taskId: task.id,
      objective: task.objective,
      deadlineMs: task.budget.timeoutMs,
    })

    if (this.unusableAfterTimeout) {
      const failure = new StageFailure(
        'run',
        'unusable',
        'This runtime instance cannot be reused after a timed-out operation; create a new runtime instance.',
      )
      this.recordStageFailure(failure, 'finalize')
      return this.finishStageFailure(task, failure, 0, 0, verification)
    }

    const deadline = Date.now() + task.budget.timeoutMs
    const memory = new WorkingMemory()
    let recoveries = 0
    let steps = 0
    let recoveryHint: string | undefined
    let experienceHints: Array<{ id: string; lesson: string; confidence: number }> = []

    try {
      experienceHints = deepFrozenClone(
        this.experienceStore.retrieve(task.memoryTags ?? []).map(({ id, lesson, confidence }) => ({ id, lesson, confidence })),
      )
      await this.executeStage('open', 'observe', deadline, () => this.tools.openPage(task.startUrl))
      let observation = await this.captureObservation(task, deadline)

      this.recorder.record('observation.captured', 'observe', observation)
      verification = await this.verify(task, observation, deadline)

      if (verification.passed) {
        return this.finish(task, 'completed', 'Goal was already satisfied by the initial page evidence.', steps, recoveries, verification)
      }
      const blocker = visibleBlocker(task, observation)
      if (blocker) return this.finish(task, 'blocked', `BLOCKED: ${blocker}`, steps, recoveries, verification)

      this.recorder.record('memory.retrieved', 'plan', { memoryIds: experienceHints.map((memory) => memory.id) })
      const rawPlan = await this.executeStage('createPlan', 'plan', deadline, () => this.policy.createPlan(policySnapshot({
        phase: 'plan',
        task,
        observation,
        failedActionFingerprints: [],
        experienceHints,
      })))
      const plan = deepFrozenClone(rawPlan)
      this.recorder.record('plan.created', 'plan', plan)

      while (steps < task.budget.maxSteps && Date.now() < deadline) {
        const phase = recoveryHint ? 'recover' : 'act'
        const rawAction = await this.executeStage('policy.nextAction', phase, deadline, () => this.policy.nextAction(policySnapshot({
          phase,
          task,
          plan,
          observation,
          failedActionFingerprints: memory.failedActionFingerprints(),
          experienceHints,
          ...(recoveryHint ? { recoveryHint } : {}),
        })))
        const action = deepFrozenClone(rawAction)

        recoveryHint = undefined
        steps += 1
        this.recorder.record('action.selected', phase, action)

        if (action.kind === 'finish') {
          verification = await this.verify(task, observation, deadline)
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
        const outcome = deepFrozenClone(
          await this.executeStage('tool', 'act', deadline, () => this.tools.perform(action)),
        )
        this.recorder.record('tool.finished', 'act', outcome)

        if (outcome.ok || outcome.error.code !== 'ORIGIN_NOT_ALLOWED') {
          observation = await this.captureObservation(task, deadline)
          this.recorder.record('observation.captured', 'observe', observation)
        } else {
          this.recorder.record('observation.reused', 'observe', { reason: 'origin request was blocked before navigation' })
        }

        // Completion is decided from fresh evidence, not from the tool's exit flag.
        // This avoids the contradictory state "blocked + verification.passed" when
        // a tool reports a failure after the page has nevertheless reached the goal.
        verification = await this.verify(task, observation, deadline)
        if (verification.passed) {
          return this.finish(task, 'completed', 'Goal completed with visible page evidence.', steps, recoveries, verification)
        }

        const actionBlocker = visibleBlocker(task, observation)
        if (actionBlocker) {
          return this.finish(task, 'blocked', `BLOCKED: ${actionBlocker}`, steps, recoveries, verification)
        }

        if (!outcome.ok) {
          const repeatCount = memory.recordFailure(action)
          recoveries += 1
          if (!outcome.error.retryable || repeatCount > 1 || recoveries > task.budget.maxRecoveries) {
            return this.finish(task, 'blocked', `BLOCKED: ${outcome.error.code}`, steps, Math.min(recoveries, task.budget.maxRecoveries), verification)
          }
          recoveryHint = `Avoid failed action ${actionFingerprint(action)}. Visible targets: ${observation.interactive.map((item) => item.name).join(', ')}`
          this.recorder.record('recovery.chosen', 'recover', { reason: recoveryHint, recoveries })
          continue
        }
      }

      verification = await this.verify(task, observation, deadline)
      const reason = Date.now() >= deadline ? 'BLOCKED: timeout budget exhausted' : 'BLOCKED: step budget exhausted'
      return this.finish(task, 'blocked', reason, steps, recoveries, verification)
    } catch (error) {
      const failure = asStageFailure(error, 'run')
      if (!(error instanceof StageFailure)) this.recordStageFailure(failure, 'finalize')
      return this.finishStageFailure(task, failure, steps, recoveries, verification)
    }
  }

  private async captureObservation(task: TaskContract, deadline: number): Promise<BrowserObservation> {
    return this.executeStage('observe', 'observe', deadline, async () => {
      const observation = deepFrozenClone(await this.tools.observe())
      assertAllowedObservation(task, observation)
      return observation
    })
  }

  private async verify(
    task: TaskContract,
    observation: BrowserObservation,
    deadline: number,
  ): Promise<VerificationReport> {
    const verification = deepFrozenClone(await this.executeStage(
      'verify',
      'verify',
      deadline,
      async () => verifyGoal(task, observation),
    ))
    this.recorder.record('verification.finished', 'verify', verification)
    return verification
  }

  private async executeStage<T>(
    stage: RuntimeStage,
    phase: string,
    deadline: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const remainingMs = deadline - Date.now()
    this.recorder.record('stage.started', phase, { stage, remainingMs: Math.max(0, remainingMs) })
    if (remainingMs <= 0) {
      const failure = new StageFailure(stage, 'timeout', 'The task timeout budget was exhausted before this stage started.')
      await this.cancelTimedOutWork(failure)
      this.recordStageFailure(failure, phase)
      throw failure
    }

    let timeout: ReturnType<typeof setTimeout> | undefined
    const startedAt = Date.now()
    try {
      const result = await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new StageFailure(stage, 'timeout', `Stage exceeded its remaining ${remainingMs} ms budget.`)), remainingMs)
        }),
      ])
      if (Date.now() >= deadline) {
        throw new StageFailure(stage, 'timeout', `Stage completed after its remaining ${remainingMs} ms budget.`)
      }
      this.recorder.record('stage.finished', phase, { stage, durationMs: Date.now() - startedAt })
      return result
    } catch (error) {
      const failure = error instanceof StageFailure
        ? error
        : new StageFailure(stage, 'exception', errorMessage(error))
      if (failure.kind === 'timeout') await this.cancelTimedOutWork(failure)
      this.recordStageFailure(failure, phase)
      throw failure
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private async cancelTimedOutWork(failure: StageFailure): Promise<void> {
    this.unusableAfterTimeout = true
    if (this.cancellationRequested) return
    this.cancellationRequested = true
    try {
      await Promise.race([
        Promise.resolve(this.tools.cancel?.(`${failure.stage}: ${failure.message}`)).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ])
    } catch {
      // Cancellation is best effort. The runtime remains poisoned even if the
      // adapter cannot cancel, so late work cannot be consumed by another run.
    }
  }

  private recordStageFailure(failure: StageFailure, phase: string): void {
    this.recorder.record('stage.failed', phase, {
      stage: failure.stage,
      code: failureCode(failure.kind),
      message: failure.message,
    })
  }

  private finishStageFailure(
    task: TaskContract,
    failure: StageFailure,
    steps: number,
    recoveries: number,
    verification: VerificationReport,
  ): RunResult {
    const status = failure.kind === 'timeout' || failure.kind === 'origin' ? 'blocked' : 'failed'
    const prefix = status === 'blocked' ? 'BLOCKED' : 'FAILED'
    const reason = failure.kind === 'timeout' ? 'timed out' : failure.kind === 'origin' ? 'blocked' : 'failed'
    return this.finish(task, status, `${prefix}: ${failure.stage} ${reason}: ${failure.message}`, steps, recoveries, verification)
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

function emptyVerification(): VerificationReport {
  return { passed: false, checks: [] }
}

function policySnapshot(context: Parameters<AgentPolicy['createPlan']>[0]): Parameters<AgentPolicy['createPlan']>[0] {
  return deepFrozenClone(context)
}

function deepFrozenClone<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || visited.has(value as object)) return value
  visited.add(value as object)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, visited)
  return Object.freeze(value)
}

function assertAllowedObservation(task: TaskContract, observation: BrowserObservation): void {
  let origin: string
  try {
    origin = new URL(observation.url).origin
  } catch {
    throw new StageFailure('observe', 'exception', 'The browser adapter returned an invalid observation URL.')
  }
  if (!task.allowedOrigins.includes(origin)) {
    throw new StageFailure('observe', 'origin', `ORIGIN_NOT_ALLOWED: observed ${origin}`)
  }
}

function failureCode(kind: StageFailureKind): string {
  if (kind === 'timeout') return 'STAGE_TIMEOUT'
  if (kind === 'origin') return 'ORIGIN_NOT_ALLOWED'
  if (kind === 'unusable') return 'RUNTIME_NOT_REUSABLE'
  return 'STAGE_EXCEPTION'
}

function asStageFailure(error: unknown, fallbackStage: RuntimeStage): StageFailure {
  return error instanceof StageFailure ? error : new StageFailure(fallbackStage, 'exception', errorMessage(error))
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactSensitiveText(message.split('\n')[0]?.slice(0, 240) || 'Unknown runtime error')
}
