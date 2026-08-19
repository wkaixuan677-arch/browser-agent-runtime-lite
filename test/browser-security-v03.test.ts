import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import type { Browser, BrowserContext } from 'playwright'
import { BrowserTools, MAX_OBSERVATION_TEXT_LENGTH } from '../src/browser-tools.ts'
import { launchBrowser } from '../src/launch-browser.ts'
import { ScriptedPolicy } from '../src/policy.ts'
import { BrowserAgentRuntime } from '../src/runtime.ts'
import type { AgentPlan, BrowserAction, RunResult, TaskContract } from '../src/types.ts'

const CROSS_ORIGIN_SECRET = 'CROSS_ORIGIN_SUCCESS_EVIDENCE'

test('context guard blocks the first request of a target=_blank popup', async () => {
  await withSecurityFixture('/popup', { kind: 'click', id: 'open-popup', role: 'link', name: 'Open external popup' }, async ({ result, externalHits }) => {
    assertBlockedWithoutExternalEvidence(result, externalHits)
  })
})

test('context guard blocks the cross-origin destination of an allowed 302 redirect', async () => {
  await withSecurityFixture('/redirect-page', { kind: 'click', id: 'follow-redirect', role: 'link', name: 'Follow redirect' }, async ({ result, externalHits }) => {
    assertBlockedWithoutExternalEvidence(result, externalHits)
  })
})

test('keeps bounded page evidence beyond the old 2,000-character verifier cutoff', async () => {
  const fixture = await startSecurityFixture()
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  try {
    browser = await launchBrowser()
    context = await browser.newContext({ serviceWorkers: 'block' })
    const tools = new BrowserTools(await context.newPage(), [fixture.safeOrigin])
    const observation = await tools.open(`${fixture.safeOrigin}/long-evidence`)

    assert.ok(observation.text.length > 2_000)
    assert.ok(observation.text.length <= MAX_OBSERVATION_TEXT_LENGTH)
    assert.match(observation.text, /TAIL_SUCCESS_EVIDENCE/)
  } finally {
    await context?.close()
    await browser?.close()
    await fixture.close()
  }
})

async function withSecurityFixture(
  path: string,
  action: BrowserAction,
  assertion: (value: { result: RunResult; externalHits: number }) => Promise<void>,
): Promise<void> {
  const fixture = await startSecurityFixture()
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  try {
    browser = await launchBrowser()
    // BrowserContext routing cannot intercept requests already owned by a
    // Service Worker, so the security-focused adapter setup blocks them.
    context = await browser.newContext({ serviceWorkers: 'block' })
    const tools = new BrowserTools(await context.newPage(), [fixture.safeOrigin])
    const runtime = new BrowserAgentRuntime(new ScriptedPolicy(plan, [action]), tools)
    const result = await runtime.run(taskFor(`${fixture.safeOrigin}${path}`, fixture.safeOrigin))
    await assertion({ result, externalHits: fixture.externalHits() })
  } finally {
    await context?.close()
    await browser?.close()
    await fixture.close()
  }
}

function assertBlockedWithoutExternalEvidence(result: RunResult, externalHits: number): void {
  assert.equal(result.status, 'blocked', JSON.stringify(result, null, 2))
  assert.equal(result.verification.passed, false)
  assert.match(result.answer, /ORIGIN_NOT_ALLOWED/)
  assert.equal(externalHits, 0, 'the disallowed server must not receive the popup or redirect request')
  assert.ok(result.trajectory.some((event) => event.type === 'tool.finished' && JSON.stringify(event.payload).includes('ORIGIN_NOT_ALLOWED')))
  assert.ok(result.verification.checks.every((check) => !check.passed && check.evidence.startsWith('No match for ')))
}

const plan: AgentPlan = {
  revision: 1,
  steps: [{ id: 'guard', description: 'Try the visible navigation target', successCriteria: 'Only allowed-origin evidence may complete the task', status: 'pending' }],
}

function taskFor(startUrl: string, allowedOrigin: string): TaskContract {
  return {
    id: `origin-security-${new URL(startUrl).pathname.slice(1)}`,
    objective: 'Verify that navigation cannot import evidence from an untrusted origin.',
    startUrl,
    allowedOrigins: [allowedOrigin],
    successCriteria: { textIncludes: [CROSS_ORIGIN_SECRET] },
    budget: { maxSteps: 1, maxRecoveries: 0, timeoutMs: 5_000 },
  }
}

async function startSecurityFixture(): Promise<{
  safeOrigin: string
  externalHits: () => number
  close: () => Promise<void>
}> {
  let externalHitCount = 0
  const external = createServer((_request, response) => {
    externalHitCount += 1
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<main>${CROSS_ORIGIN_SECRET}</main>`)
  })
  const externalOrigin = await listen(external)

  const safe = createServer((request, response) => {
    if (request.url === '/popup') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<a href="${externalOrigin}/secret" target="_blank">Open external popup</a>`)
      return
    }
    if (request.url === '/redirect-page') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<a href="/redirect">Follow redirect</a>')
      return
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { location: `${externalOrigin}/secret` })
      response.end()
      return
    }
    if (request.url === '/long-evidence') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<main>${'visible '.repeat(450)}TAIL_SUCCESS_EVIDENCE</main>`)
      return
    }
    response.writeHead(404)
    response.end('Not found')
  })
  const safeOrigin = await listen(safe)

  return {
    safeOrigin,
    externalHits: () => externalHitCount,
    close: async () => {
      await Promise.all([closeServer(safe), closeServer(external)])
    },
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
