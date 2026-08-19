export type GoalStatus = 'in_progress' | 'completed' | 'blocked' | 'failed'

export type TaskContract = {
  id: string
  objective: string
  startUrl: string
  allowedOrigins: string[]
  successCriteria: {
    urlIncludes?: string
    textIncludes?: string[]
  }
  blockerText?: string[]
  memoryTags?: string[]
  budget: {
    maxSteps: number
    maxRecoveries: number
    timeoutMs: number
  }
}

export type PlanStep = {
  id: string
  description: string
  successCriteria: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
}

export type AgentPlan = {
  revision: number
  steps: PlanStep[]
}

export type BrowserAction =
  | { kind: 'observe'; id: string }
  | { kind: 'click'; id: string; role: 'button' | 'link'; name: string }
  | { kind: 'type'; id: string; role: 'textbox'; name: string; text: string }
  | { kind: 'finish'; id: string; answer: string }

export type BrowserObservation = {
  url: string
  title: string
  text: string
  interactive: Array<{ role: string; name: string }>
}

export type PolicyPhase = 'plan' | 'act' | 'recover'

export type PolicyContext = {
  phase: PolicyPhase
  task: TaskContract
  plan?: AgentPlan
  observation?: BrowserObservation
  failedActionFingerprints: string[]
  recoveryHint?: string
  experienceHints: Array<{ id: string; lesson: string; confidence: number }>
}

export interface AgentPolicy {
  createPlan(context: PolicyContext): Promise<AgentPlan>
  nextAction(context: PolicyContext): Promise<BrowserAction>
}

export type ToolError = {
  code: 'TARGET_NOT_FOUND' | 'INVALID_ACTION' | 'ORIGIN_NOT_ALLOWED' | 'TOOL_TIMEOUT'
  message: string
  retryable: boolean
}

export type ToolResult =
  | { ok: true; observation: BrowserObservation }
  | { ok: false; error: ToolError; observation: BrowserObservation }

export type VerificationReport = {
  passed: boolean
  checks: Array<{ criterion: string; passed: boolean; evidence: string }>
}

export type TrajectoryEvent = {
  seq: number
  type: string
  phase: string
  payload: unknown
}

export type RunResult = {
  taskId: string
  status: Exclude<GoalStatus, 'in_progress'>
  answer: string
  steps: number
  recoveries: number
  verification: VerificationReport
  trajectory: TrajectoryEvent[]
}

export type ExperienceStatus = 'candidate' | 'validated' | 'promoted' | 'deprecated' | 'quarantined'

export type ExperienceMemory = {
  id: string
  tags: string[]
  lesson: string
  status: ExperienceStatus
  confidence: number
}
