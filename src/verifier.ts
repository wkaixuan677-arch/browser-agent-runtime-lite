import type { BrowserObservation, TaskContract, VerificationReport } from './types.ts'

export function verifyGoal(task: TaskContract, observation: BrowserObservation): VerificationReport {
  const checks: VerificationReport['checks'] = []
  if (task.successCriteria.urlIncludes) {
    const expected = task.successCriteria.urlIncludes
    checks.push({
      criterion: `URL path includes ${expected}`,
      passed: urlPathMatches(observation.url, expected),
      evidence: safeUrlEvidence(observation.url),
    })
  }
  for (const expected of task.successCriteria.textIncludes ?? []) {
    checks.push({
      criterion: `Page text includes ${expected}`,
      passed: observation.text.toLowerCase().includes(expected.toLowerCase()),
      evidence: contextSnippet(observation.text, expected),
    })
  }
  return { passed: checks.length > 0 && checks.every((check) => check.passed), checks }
}

function urlPathMatches(value: string, expected: string): boolean {
  const actual = new URL(value)
  if (/^https?:\/\//i.test(expected)) {
    const target = new URL(expected)
    return actual.origin === target.origin && actual.pathname.includes(target.pathname)
  }
  return actual.pathname.includes(expected)
}

function safeUrlEvidence(value: string): string {
  const url = new URL(value)
  return `${url.origin}${url.pathname}`
}

function contextSnippet(text: string, expected: string): string {
  const index = text.toLowerCase().indexOf(expected.toLowerCase())
  if (index < 0) return text.slice(0, 240)
  const start = Math.max(0, index - 80)
  return text.slice(start, index + expected.length + 80)
}

export function visibleBlocker(task: TaskContract, observation: BrowserObservation): string | null {
  return task.blockerText?.find((text) => observation.text.toLowerCase().includes(text.toLowerCase())) ?? null
}
