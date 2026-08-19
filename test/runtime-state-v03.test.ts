import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserAgentRuntime } from '../src/runtime.ts'
import { ExperienceMemoryStore } from '../src/memory.ts'
import type {
  AgentPlan,
  AgentPolicy,
  BrowserAction,
  BrowserObservation,
  BrowserToolAdapter,
  PolicyContext,
  TaskContract,
  ToolExecutionResult,
} from '../src/types.ts'

const ORIGIN = 'http://127.0.0.1:4178'
const PLAN: AgentPlan = {
  revision: 1,
  steps: [{ id: 'inspect', description: 'Inspect evidence', successCriteria: 'READY is visible', status: 'pending' }],
}

test('enforces the task origin allowlist on the initial observation', async () => {
  const result = await new BrowserAgentRuntime(finishPolicy(), tools({
    observe: async () => observation('https://outside.example/report', 'READY'),
  })).run(task('initial-origin-guard'))

  assert.equal(result.status, 'blocked')
  assert.equal(result.verification.passed, false)
  assert.match(result.answer, /ORIGIN_NOT_ALLOWED/)
  assert.ok(result.trajectory.some((event) => event.type === 'stage.failed'
    && JSON.stringify(event.payload).includes('ORIGIN_NOT_ALLOWED')))
  assert.equal(result.trajectory.at(-1)?.type, 'run.finished')
})

test('enforces the task origin allowlist after every action observation', async () => {
  let observations = 0
  const result = await new BrowserAgentRuntime(actionPolicy({ kind: 'observe', id: 'inspect' }), tools({
    observe: async () => ++observations === 1
      ? observation(`${ORIGIN}/`, 'pending')
      : observation('https://outside.example/report', 'READY'),
  })).run(task('post-action-origin-guard'))

  assert.equal(result.status, 'blocked')
  assert.equal(result.verification.passed, false)
  const toolFinished = result.trajectory.findIndex((event) => event.type === 'tool.finished')
  const originFailure = result.trajectory.findIndex((event) => event.type === 'stage.failed'
    && JSON.stringify(event.payload).includes('ORIGIN_NOT_ALLOWED'))
  assert.ok(toolFinished >= 0)
  assert.ok(originFailure > toolFinished)
  assert.equal(result.trajectory.at(-1)?.type, 'run.finished')
})

test('passes deep-cloned, deeply frozen state to an untrusted policy', async () => {
  const frozenChecks: boolean[] = []
  const inputTask = { ...task('immutable-policy-state'), memoryTags: ['report'] }
  const policy: AgentPolicy = {
    async createPlan(context) {
      inspectAndAttemptMutation(context, frozenChecks)
      return PLAN
    },
    async nextAction(context) {
      inspectAndAttemptMutation(context, frozenChecks)
      assert.equal(context.plan?.steps[0]?.status, 'pending')
      return { kind: 'finish', id: 'premature', answer: 'tampered completion' }
    },
  }
  const store = new ExperienceMemoryStore([{
    id: 'safe-memory',
    tags: ['report'],
    lesson: 'Use visible evidence.',
    status: 'promoted',
    confidence: 0.9,
  }])
  const result = await new BrowserAgentRuntime(policy, tools(), undefined, store).run(inputTask)

  assert.equal(result.status, 'blocked')
  assert.equal(result.verification.passed, false)
  assert.equal(inputTask.objective, 'Find visible READY evidence')
  assert.deepEqual(inputTask.successCriteria.textIncludes, ['READY'])
  assert.ok(frozenChecks.length >= 10)
  assert.ok(frozenChecks.every(Boolean))
})

test('turns verifier exceptions into stage.failed and run.finished', async () => {
  const malformedObservation = {
    ...observation(),
    text: { unexpected: 'non-string adapter payload' } as unknown as string,
  }
  const result = await new BrowserAgentRuntime(finishPolicy(), tools({
    observe: async () => malformedObservation,
  })).run(task('verifier-exception'))

  assert.equal(result.status, 'failed')
  assert.equal(result.verification.passed, false)
  assert.match(result.answer, /verify failed/)
  assert.ok(result.trajectory.some((event) => event.type === 'stage.failed'
    && JSON.stringify(event.payload).includes('"stage":"verify"')))
  assert.equal(result.trajectory.at(-1)?.type, 'run.finished')
})

test('records tool.finished before a subsequent observe failure', async () => {
  let observations = 0
  const result = await new BrowserAgentRuntime(actionPolicy({ kind: 'observe', id: 'inspect' }), tools({
    observe: async () => {
      if (++observations === 1) return observation(`${ORIGIN}/`, 'pending')
      throw new Error('observation adapter failed')
    },
  })).run(task('tool-outcome-order'))

  assert.equal(result.status, 'failed')
  const toolFinished = result.trajectory.findIndex((event) => event.type === 'tool.finished')
  const observeFailed = result.trajectory.findIndex((event) => event.type === 'stage.failed'
    && JSON.stringify(event.payload).includes('"stage":"observe"'))
  assert.ok(toolFinished >= 0)
  assert.ok(observeFailed > toolFinished)
})

test('allows fresh completion evidence to win over a failed tool exit flag', async () => {
  let observations = 0
  const result = await new BrowserAgentRuntime(actionPolicy({ kind: 'observe', id: 'inspect' }), tools({
    observe: async () => ++observations === 1
      ? observation(`${ORIGIN}/`, 'pending')
      : observation(`${ORIGIN}/report`, 'READY'),
    perform: async () => ({
      ok: false,
      error: { code: 'TARGET_NOT_FOUND', message: 'stale tool status', retryable: false },
    }),
  })).run(task('evidence-wins'))

  assert.equal(result.status, 'completed')
  assert.equal(result.verification.passed, true)
  assert.match(result.answer, /visible page evidence/)
})

test('uses a fresh empty verification report for every run', async () => {
  const runtime = new BrowserAgentRuntime(finishPolicy(), tools({
    openPage: async () => { throw new Error('browser unavailable') },
  }))
  const first = await runtime.run(task('fresh-verification-1'))
  const second = await runtime.run(task('fresh-verification-2'))

  assert.equal(second.status, 'failed')
  assert.deepEqual(second.verification, { passed: false, checks: [] })
  assert.notEqual(first.verification, second.verification)
  assert.notEqual(first.verification.checks, second.verification.checks)
})

test('checks the deadline after await, cancels timed-out work, and poisons the runtime', async () => {
  let cancellations = 0
  let opens = 0
  const adapter = tools({
    openPage: async () => {
      opens += 1
      const until = Date.now() + 140
      while (Date.now() < until) {
        // Deliberately block the event loop so Promise.race alone cannot enforce
        // the deadline. The post-await clock check must catch this overrun.
      }
    },
    cancel: () => {
      cancellations += 1
    },
  })
  const runtime = new BrowserAgentRuntime(finishPolicy(), adapter)
  const shortTask = { ...task('post-await-timeout'), budget: { maxSteps: 1, maxRecoveries: 0, timeoutMs: 100 } }

  const first = await runtime.run(shortTask)
  const second = await runtime.run({ ...shortTask, id: 'poisoned-runtime-reuse' })

  assert.equal(first.status, 'blocked')
  assert.match(first.answer, /open timed out/)
  assert.equal(cancellations, 1)
  assert.equal(second.status, 'failed')
  assert.match(second.answer, /cannot be reused/)
  assert.equal(opens, 1)
  assert.ok(second.trajectory.some((event) => event.type === 'stage.failed'
    && JSON.stringify(event.payload).includes('RUNTIME_NOT_REUSABLE')))
})

function inspectAndAttemptMutation(context: PolicyContext, frozenChecks: boolean[]): void {
  frozenChecks.push(
    Object.isFrozen(context),
    Object.isFrozen(context.task),
    Object.isFrozen(context.task.successCriteria),
    Object.isFrozen(context.task.successCriteria.textIncludes),
    Object.isFrozen(context.observation),
    Object.isFrozen(context.experienceHints),
    Object.isFrozen(context.experienceHints[0]),
  )
  try { context.task.objective = 'mutated objective' } catch {}
  try { context.task.successCriteria.textIncludes?.splice(0, 1, 'pending') } catch {}
  try { if (context.observation) context.observation.text = 'READY' } catch {}
  try { if (context.experienceHints[0]) context.experienceHints[0].lesson = 'unsafe mutation' } catch {}
  try { if (context.plan?.steps[0]) context.plan.steps[0].status = 'completed' } catch {}
}

function task(id: string): TaskContract {
  return {
    id,
    objective: 'Find visible READY evidence',
    startUrl: `${ORIGIN}/`,
    allowedOrigins: [ORIGIN],
    successCriteria: { textIncludes: ['READY'] },
    budget: { maxSteps: 1, maxRecoveries: 0, timeoutMs: 1_000 },
  }
}

function observation(url = `${ORIGIN}/`, text = 'pending'): BrowserObservation {
  return { url, title: 'Fixture', text, interactive: [] }
}

function finishPolicy(): AgentPolicy {
  return actionPolicy({ kind: 'finish', id: 'finish', answer: 'done' })
}

function actionPolicy(action: BrowserAction): AgentPolicy {
  return {
    async createPlan() {
      return PLAN
    },
    async nextAction() {
      return action
    },
  }
}

function tools(overrides: {
  openPage?: (url: string) => Promise<void>
  observe?: () => Promise<BrowserObservation>
  perform?: (action: BrowserAction) => Promise<ToolExecutionResult>
  cancel?: (reason?: string) => Promise<void> | void
} = {}): BrowserToolAdapter {
  return {
    openPage: overrides.openPage ?? (async () => undefined),
    observe: overrides.observe ?? (async () => observation()),
    perform: overrides.perform ?? (async () => ({ ok: true })),
    ...(overrides.cancel ? { cancel: overrides.cancel } : {}),
  }
}
