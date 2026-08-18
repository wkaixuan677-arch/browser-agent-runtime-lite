import type { AgentPlan, BrowserAction, TaskContract } from './types.ts'

export const reportPlan: AgentPlan = {
  revision: 1,
  steps: [
    { id: 'inspect', description: 'Inspect visible targets', successCriteria: 'A report entry is visible', status: 'in_progress' },
    { id: 'open', description: 'Open the report', successCriteria: 'The report page is loaded', status: 'pending' },
    { id: 'verify', description: 'Verify report evidence', successCriteria: 'Version 4.2 is visible', status: 'pending' },
  ],
}

export function reportTask(origin: string, id = 'report-demo'): TaskContract {
  return {
    id,
    objective: 'Open the reliability report and verify its version.',
    startUrl: `${origin}/`,
    allowedOrigins: [origin],
    successCriteria: { urlIncludes: '/report', textIncludes: ['Report ready', 'Version 4.2'] },
    blockerText: ['Access unavailable'],
    budget: { maxSteps: 4, maxRecoveries: 2, timeoutMs: 15_000 },
  }
}

export function happyActions(): BrowserAction[] {
  return [{ kind: 'click', id: 'open-report', role: 'link', name: 'Open report' }]
}

export function recoveryActions(): BrowserAction[] {
  return [
    { kind: 'click', id: 'wrong-target', role: 'link', name: 'Missing report' },
    { kind: 'click', id: 'recovered-target', role: 'link', name: 'Open report' },
  ]
}
