import assert from 'node:assert/strict'
import test from 'node:test'
import type { Browser, BrowserContext } from 'playwright'
import { BrowserAgentRuntime } from '../src/runtime.ts'
import { BrowserTools } from '../src/browser-tools.ts'
import { ScriptedPolicy } from '../src/policy.ts'
import { startFixtureServer } from '../src/fixture-server.ts'
import { ExperienceMemoryStore } from '../src/memory.ts'
import { happyActions, recoveryActions, reportPlan, reportTask } from '../src/scenarios.ts'
import type { BrowserAction } from '../src/types.ts'
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

test('injects only promoted experience memories', () => {
  const store = new ExperienceMemoryStore([
    { id: 'candidate', tags: ['search'], lesson: 'unverified', status: 'candidate', confidence: 0.9 },
    { id: 'safe', tags: ['search'], lesson: 'verified', status: 'promoted', confidence: 0.7 },
    { id: 'harmful', tags: ['search'], lesson: 'do not use', status: 'quarantined', confidence: 1 },
  ])
  assert.deepEqual(store.retrieve(['search']).map((memory) => memory.id), ['safe'])
})

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
