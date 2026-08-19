import assert from 'node:assert/strict'
import test from 'node:test'
import type { Browser, BrowserContext } from 'playwright'
import { BrowserAgentRuntime } from '../src/runtime.ts'
import { BrowserTools } from '../src/browser-tools.ts'
import { ScriptedPolicy } from '../src/policy.ts'
import { startFixtureServer } from '../src/fixture-server.ts'
import { ExperienceMemoryStore } from '../src/memory.ts'
import { happyActions, recoveryActions, reportPlan, reportTask } from '../src/scenarios.ts'
import type { AgentPolicy, BrowserAction, PolicyContext } from '../src/types.ts'
import { launchBrowser } from '../src/launch-browser.ts'

test('completes only after visible evidence satisfies every criterion', async () => {
  await withRuntime(happyActions(), async (runtime, origin) => {
    const result = await runtime.run(reportTask(origin))
    assert.equal(result.status, 'completed')
    assert.equal(result.verification.passed, true)
    assert.equal(result.steps, 1)
  })
})

test('records a failed action and recovers with a different semantic target', async () => {
  await withRuntime(recoveryActions(), async (runtime, origin) => {
    const result = await runtime.run(reportTask(origin, 'recovery-test'))
    assert.equal(result.status, 'completed')
    assert.equal(result.recoveries, 1)
    assert.equal(result.steps, 2)
    assert.ok(result.trajectory.some((event) => event.type === 'recovery.chosen'))
  })
})

test('rejects premature finish without completion evidence', async () => {
  const actions: BrowserAction[] = [
    { kind: 'finish', id: 'too-early', answer: 'Done' },
    ...happyActions(),
  ]
  await withRuntime(actions, async (runtime, origin) => {
    const result = await runtime.run(reportTask(origin, 'finish-guard'))
    assert.equal(result.status, 'completed')
    assert.equal(result.recoveries, 1)
    assert.equal(result.steps, 2)
  })
})

test('returns an evidence-backed blocked outcome for a visible hard blocker', async () => {
  const fixture = await startFixtureServer()
  const browser = await launchBrowser()
  const context = await browser.newContext()
  try {
    const task = { ...reportTask(fixture.origin, 'blocked-test'), startUrl: `${fixture.origin}/blocked` }
    const runtime = new BrowserAgentRuntime(new ScriptedPolicy(reportPlan, happyActions()), new BrowserTools(await context.newPage(), [fixture.origin]))
    const result = await runtime.run(task)
    assert.equal(result.status, 'blocked')
    assert.match(result.answer, /Access unavailable/)
    assert.equal(result.steps, 0)
  } finally {
    await context.close()
    await browser.close()
    await fixture.close()
  }
})

test('completes with zero policy actions when the initial page already satisfies the contract', async () => {
  await withRuntime([], async (runtime, origin) => {
    const task = { ...reportTask(origin, 'initial-evidence'), startUrl: `${origin}/report` }
    const result = await runtime.run(task)
    assert.equal(result.status, 'completed')
    assert.equal(result.steps, 0)
    assert.equal(result.verification.passed, true)
  })
})

test('detects a hard blocker that appears after a successful action', async () => {
  const action: BrowserAction = { kind: 'click', id: 'open-blocked', role: 'link', name: 'Open blocked demo' }
  await withRuntime([action], async (runtime, origin) => {
    const result = await runtime.run(reportTask(origin, 'post-action-blocker'))
    assert.equal(result.status, 'blocked')
    assert.match(result.answer, /Access unavailable/)
    assert.equal(result.steps, 1)
  })
})

test('injects only promoted experience memories', () => {
  const store = new ExperienceMemoryStore([
    { id: 'candidate', tags: ['search'], lesson: 'unverified', status: 'candidate', confidence: 0.9 },
    { id: 'safe', tags: ['search'], lesson: 'verified', status: 'promoted', confidence: 0.7 },
    { id: 'harmful', tags: ['search'], lesson: 'do not use', status: 'quarantined', confidence: 1 },
  ])
  assert.deepEqual(store.retrieve(['search']).map((memory) => memory.id), ['safe'])
})

test('injects promoted experience into policy context and records its id', async () => {
  const fixture = await startFixtureServer()
  const browser = await launchBrowser()
  const context = await browser.newContext()
  const policy = new RecordingPolicy(new ScriptedPolicy(reportPlan, happyActions()))
  const store = new ExperienceMemoryStore([
    { id: 'candidate', tags: ['report'], lesson: 'not validated', status: 'candidate', confidence: 1 },
    { id: 'promoted', tags: ['report'], lesson: 'use the visible report link', status: 'promoted', confidence: 0.8 },
  ])
  try {
    const runtime = new BrowserAgentRuntime(policy, new BrowserTools(await context.newPage(), [fixture.origin]), undefined, store)
    const result = await runtime.run(reportTask(fixture.origin, 'memory-injection'))
    assert.deepEqual(policy.hintIds, ['promoted'])
    assert.ok(result.trajectory.some((event) => event.type === 'memory.retrieved' && JSON.stringify(event.payload).includes('promoted')))
  } finally {
    await context.close()
    await browser.close()
    await fixture.close()
  }
})

test('blocks a cross-origin request before navigation leaves the allowlist', async () => {
  const fixture = await startFixtureServer()
  const external = await startFixtureServer()
  const browser = await launchBrowser()
  const context = await browser.newContext()
  try {
    const task = {
      ...reportTask(fixture.origin, 'origin-guard'),
      startUrl: `${fixture.origin}/external-link?target=${encodeURIComponent(`${external.origin}/report`)}`,
    }
    const action: BrowserAction = { kind: 'click', id: 'leave-site', role: 'link', name: 'Leave site' }
    const runtime = new BrowserAgentRuntime(new ScriptedPolicy(reportPlan, [action]), new BrowserTools(await context.newPage(), [fixture.origin]))
    const result = await runtime.run(task)
    assert.equal(result.status, 'blocked')
    assert.match(result.answer, /ORIGIN_NOT_ALLOWED/)
    const toolEvent = result.trajectory.find((event) => event.type === 'tool.finished')
    assert.match(JSON.stringify(toolEvent?.payload), /ORIGIN_NOT_ALLOWED/)
  } finally {
    await context.close()
    await browser.close()
    await fixture.close()
    await external.close()
  }
})

class RecordingPolicy implements AgentPolicy {
  hintIds: string[] = []

  constructor(private readonly delegate: AgentPolicy) {}

  async createPlan(context: PolicyContext) {
    this.hintIds = context.experienceHints.map((hint) => hint.id)
    return this.delegate.createPlan(context)
  }

  async nextAction(context: PolicyContext) {
    return this.delegate.nextAction(context)
  }
}

async function withRuntime(
  actions: BrowserAction[],
  assertion: (runtime: BrowserAgentRuntime, origin: string) => Promise<void>,
): Promise<void> {
  const fixture = await startFixtureServer()
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  try {
    browser = await launchBrowser()
    context = await browser.newContext()
    const runtime = new BrowserAgentRuntime(new ScriptedPolicy(reportPlan, actions), new BrowserTools(await context.newPage(), [fixture.origin]))
    await assertion(runtime, fixture.origin)
  } finally {
    await context?.close()
    await browser?.close()
    await fixture.close()
  }
}
