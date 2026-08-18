import type { BrowserObservation, TaskContract, VerificationReport } from './types.ts'

export function verifyGoal(task: TaskContract, observation: BrowserObservation): VerificationReport {
  const checks: VerificationReport['checks'] = []
  if (task.successCriteria.urlIncludes) {
    checks.push({
      criterion: `URL includes ${task.successCriteria.urlIncludes}`,
      passed: observation.url.includes(task.successCriteria.urlIncludes),
      evidence: observation.url,
    })
  }
  for (const expected of task.successCriteria.textIncludes ?? []) {
    checks.push({
      criterion: `Page text includes ${expected}`,
      passed: observation.text.toLowerCase().includes(expected.toLowerCase()),
      evidence: observation.text.slice(0, 240),
    })
  }
  return { passed: checks.length > 0 && checks.every((check) => check.passed), checks }
}

export function visibleBlocker(task: TaskContract, observation: BrowserObservation): string | null {
  return task.blockerText?.find((text) => observation.text.toLowerCase().includes(text.toLowerCase())) ?? null
}
