import type { TaskContract } from './types.ts'
import { parseUrlMatchCriterion } from './verifier.ts'

export const MAX_TASK_TIMEOUT_MS = 30 * 60 * 1_000
export const MAX_TASK_STEPS = 1_000
export const MAX_TASK_RECOVERIES = 100

export function validateTaskContract(task: TaskContract): TaskContract {
  if (typeof task.id !== 'string' || !task.id.trim()) throw new Error('Task id is required')
  if (typeof task.objective !== 'string' || !task.objective.trim()) throw new Error('Task objective is required')

  const startUrl = parseHttpUrl(task.startUrl, 'Start URL')
  const allowedOrigins = validateAllowedOrigins(task.allowedOrigins)
  if (!allowedOrigins.has(startUrl.origin)) throw new Error('Start URL origin is not allowed')

  const urlCriterion = task.successCriteria?.urlIncludes
  const textCriteria = task.successCriteria?.textIncludes
  if (!urlCriterion && !textCriteria?.length) throw new Error('At least one success criterion is required')
  if (urlCriterion !== undefined) {
    const parsedCriterion = parseUrlMatchCriterion(urlCriterion)
    if (parsedCriterion.origin !== null && !allowedOrigins.has(parsedCriterion.origin)) {
      throw new Error('Absolute URL success criterion origin is not allowed')
    }
  }
  if (textCriteria !== undefined) {
    if (!Array.isArray(textCriteria) || textCriteria.length === 0) throw new Error('Text success criteria must not be empty')
    if (textCriteria.some((criterion) => typeof criterion !== 'string' || !criterion.trim())) {
      throw new Error('Text success criteria must contain only non-empty strings')
    }
  }
  if (task.blockerText?.some((criterion) => typeof criterion !== 'string' || !criterion.trim())) {
    throw new Error('Blocker text must contain only non-empty strings')
  }

  const { maxSteps, maxRecoveries, timeoutMs } = task.budget ?? {}
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_TASK_STEPS) {
    throw new Error(`Task maxSteps must be an integer between 1 and ${MAX_TASK_STEPS}`)
  }
  if (!Number.isSafeInteger(maxRecoveries) || maxRecoveries < 0 || maxRecoveries > MAX_TASK_RECOVERIES || maxRecoveries > maxSteps) {
    throw new Error(`Task maxRecoveries must be an integer between 0 and min(maxSteps, ${MAX_TASK_RECOVERIES})`)
  }
  if (!Number.isFinite(timeoutMs) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TASK_TIMEOUT_MS) {
    throw new Error(`Task timeoutMs must be an integer between 100 and ${MAX_TASK_TIMEOUT_MS}`)
  }
  return task
}

function parseHttpUrl(value: string, label: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} is not a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${label} must use HTTP or HTTPS`)
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`)
  return parsed
}

function validateAllowedOrigins(values: string[]): Set<string> {
  if (!Array.isArray(values) || values.length === 0) throw new Error('At least one allowed origin is required')
  const origins = new Set<string>()
  for (const value of values) {
    const parsed = parseHttpUrl(value, 'Allowed origin')
    if (parsed.origin !== value.replace(/\/$/, '') || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('Allowed origins must be canonical origins without paths, queries or fragments')
    }
    origins.add(parsed.origin)
  }
  return origins
}
