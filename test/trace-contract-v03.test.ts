import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_TASK_RECOVERIES, MAX_TASK_STEPS, MAX_TASK_TIMEOUT_MS, validateTaskContract } from '../src/contract.ts'
import {
  MAX_TRAJECTORY_EVENTS,
  MAX_TRAJECTORY_INTERACTIVE_ELEMENTS,
  MAX_TRAJECTORY_INTERACTIVE_NAME_LENGTH,
  MAX_TRAJECTORY_OBSERVATION_TEXT_LENGTH,
  MAX_TRAJECTORY_PLAN_STEPS,
  MAX_TRAJECTORY_STRING_LENGTH,
  MAX_TRAJECTORY_TITLE_LENGTH,
  MAX_TRAJECTORY_TOOL_ERROR_LENGTH,
  MAX_TRAJECTORY_URL_LENGTH,
  TrajectoryRecorder,
  redactSensitiveText,
} from '../src/trajectory.ts'
import type { BrowserObservation, TaskContract } from '../src/types.ts'
import { verifyGoal } from '../src/verifier.ts'

const origin = 'https://example.test'

test('redacts structured secrets, authorization credentials and local absolute paths', () => {
  const input = [
    '{"token":"json-token","client_secret":"json-client","password":"json-password"}',
    "{'api_key':'single-quoted-secret'}",
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'Bearer bearer-secret-value',
    'x-api-key=header-secret',
    'sk-1234567890abcdefghijklmnop',
    'C:\\Users\\alice\\private\\result.json',
    'C:/Users/alice/private/result.json',
    '/home/alice/private/result.json',
    '/tmp/browser-agent/output.json',
  ].join('\n')

  const output = redactSensitiveText(input)
  assert.doesNotMatch(output, /json-token|json-client|json-password|single-quoted-secret|dXNlcj|bearer-secret|header-secret|sk-123|alice|browser-agent/)
  assert.match(output, /Authorization: <redacted-secret>/)
  assert.match(output, /<local-path>/)
})

test('bounds trajectory fields, collections and total event count while retaining the terminal event', () => {
  const recorder = new TrajectoryRecorder()
  recorder.record('observation.captured', 'observe', {
    url: `https://example.test/${'u'.repeat(3_000)}`,
    title: 't'.repeat(1_000),
    text: 'x'.repeat(3_000),
    interactive: Array.from({ length: 250 }, (_, index) => ({ role: 'link', name: `${index}-${'n'.repeat(500)}` })),
  })
  recorder.record('plan.created', 'plan', {
    revision: 1,
    steps: Array.from({ length: 150 }, (_, index) => ({ id: `${index}`, description: 'd'.repeat(2_000), successCriteria: 's'.repeat(2_000) })),
  })
  recorder.record('tool.finished', 'act', {
    error: { code: 'INVALID_ACTION', retryable: false, message: 'e'.repeat(2_000) },
    arbitrary: 'g'.repeat(5_000),
  })

  const initial = recorder.snapshot()
  const observation = initial[0]?.payload as BrowserObservation
  const plan = initial[1]?.payload as { steps: Array<{ description: string; successCriteria: string }> }
  const tool = initial[2]?.payload as { error: { message: string }; arbitrary: string }
  assert.ok(observation.url.length <= MAX_TRAJECTORY_URL_LENGTH)
  assert.ok(observation.title.length <= MAX_TRAJECTORY_TITLE_LENGTH)
  assert.ok(observation.text.length <= MAX_TRAJECTORY_OBSERVATION_TEXT_LENGTH)
  assert.equal(observation.interactive.length, MAX_TRAJECTORY_INTERACTIVE_ELEMENTS)
  assert.ok(observation.interactive.every((item) => item.name.length <= MAX_TRAJECTORY_INTERACTIVE_NAME_LENGTH))
  assert.equal(plan.steps.length, MAX_TRAJECTORY_PLAN_STEPS)
  assert.ok(plan.steps.every((step) => step.description.length <= MAX_TRAJECTORY_TOOL_ERROR_LENGTH && step.successCriteria.length <= MAX_TRAJECTORY_TOOL_ERROR_LENGTH))
  assert.ok(tool.error.message.length <= MAX_TRAJECTORY_TOOL_ERROR_LENGTH)
  assert.ok(tool.arbitrary.length <= MAX_TRAJECTORY_STRING_LENGTH)

  for (let index = initial.length; index < MAX_TRAJECTORY_EVENTS + 50; index += 1) recorder.record('observation.captured', 'observe', { index })
  recorder.record('run.finished', 'finalize', { status: 'blocked' })
  const bounded = recorder.snapshot()
  assert.equal(bounded.length, MAX_TRAJECTORY_EVENTS)
  assert.equal(bounded.at(-1)?.type, 'run.finished')
  assert.match(JSON.stringify(bounded.at(-1)?.payload), /trajectoryDroppedEvents/)
})

test('validates finite bounded timeouts and non-empty success text', () => {
  assert.doesNotThrow(() => validateTaskContract(task()))
  for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, 99, MAX_TASK_TIMEOUT_MS + 1, 1_000.5]) {
    assert.throws(() => validateTaskContract(task({ budget: { maxSteps: 2, maxRecoveries: 0, timeoutMs } })), /timeoutMs/)
  }
  assert.throws(() => validateTaskContract(task({ successCriteria: { textIncludes: ['   '] } })), /non-empty/)
  assert.throws(() => validateTaskContract(task({ successCriteria: { urlIncludes: '/report', textIncludes: ['ok', ''] } })), /non-empty/)
  assert.throws(() => validateTaskContract(task({ budget: { maxSteps: MAX_TASK_STEPS + 1, maxRecoveries: 0, timeoutMs: 5_000 } })), /maxSteps/)
  assert.throws(() => validateTaskContract(task({ budget: { maxSteps: 2, maxRecoveries: 3, timeoutMs: 5_000 } })), /maxRecoveries/)
  assert.throws(() => validateTaskContract(task({ budget: { maxSteps: MAX_TASK_STEPS, maxRecoveries: MAX_TASK_RECOVERIES + 1, timeoutMs: 5_000 } })), /maxRecoveries/)
})

test('rejects unsafe or ambiguous URL success conditions', () => {
  const unsafe = [
    'javascript:alert(1)',
    'https://user:password@example.test/report',
    'https://example.test/report#done',
    '/reports/../admin',
    '/report/%2e%2e/admin',
    '/report?token=secret',
    '//example.test/report',
    '/report*',
  ]
  for (const urlIncludes of unsafe) {
    assert.throws(() => validateTaskContract(task({ successCriteria: { urlIncludes } })), /URL success criterion|unsafe|credentials|fragment|traversal|secret/i)
  }
  assert.throws(
    () => validateTaskContract(task({ successCriteria: { urlIncludes: 'https://other.test/report' } })),
    /origin is not allowed/,
  )
})

test('matches URL criteria by origin, path boundaries and structured query rather than raw includes', () => {
  const pathTask = validateTaskContract(task({ successCriteria: { urlIncludes: '/report' } }))
  assert.equal(verifyGoal(pathTask, observation('https://example.test/report')).passed, true)
  assert.equal(verifyGoal(pathTask, observation('https://example.test/report/42?next=/report')).passed, true)
  assert.equal(verifyGoal(pathTask, observation('https://example.test/reporting')).passed, false)
  assert.equal(verifyGoal(pathTask, observation('https://example.test/?next=/report')).passed, false)
  assert.equal(verifyGoal(pathTask, observation('https://other.test/report')).passed, false)

  const absoluteTask = validateTaskContract(task({ successCriteria: { urlIncludes: 'https://example.test/report?status=ready' } }))
  const passed = verifyGoal(absoluteTask, observation('https://example.test/report?status=ready'))
  assert.equal(passed.passed, true)
  assert.match(passed.checks[0]?.evidence ?? '', /example\.test\/report/)
  assert.equal(verifyGoal(absoluteTask, observation('https://example.test/report?next=status%3Dready')).passed, false)
  assert.equal(verifyGoal(absoluteTask, observation('https://example.test/report?status=ready&extra=1')).passed, false)
  assert.equal(verifyGoal(absoluteTask, observation('https://other.test/report?status=ready')).passed, false)
})

test('text verification evidence contains the actual visible matched text', () => {
  const report = verifyGoal(task({ successCriteria: { textIncludes: ['Report Ready'] } }), {
    ...observation('https://example.test/'),
    text: 'Status: REPORT READY for version 4.2.',
  })
  assert.equal(report.passed, true)
  assert.match(report.checks[0]?.evidence ?? '', /REPORT READY/)
})

function task(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    id: 'contract-v03',
    objective: 'Verify the report.',
    startUrl: `${origin}/`,
    allowedOrigins: [origin],
    successCriteria: { urlIncludes: '/report' },
    budget: { maxSteps: 2, maxRecoveries: 0, timeoutMs: 5_000 },
    ...overrides,
  }
}

function observation(url: string): BrowserObservation {
  return { url, title: 'Report', text: '', interactive: [] }
}
