import type { TaskContract } from './types.ts'

export function validateTaskContract(task: TaskContract): TaskContract {
  if (!task.id.trim()) throw new Error('Task id is required')
  if (!task.objective.trim()) throw new Error('Task objective is required')
  const startOrigin = new URL(task.startUrl).origin
  if (!task.allowedOrigins.includes(startOrigin)) throw new Error('Start URL origin is not allowed')
  if (!task.successCriteria.urlIncludes && !task.successCriteria.textIncludes?.length) {
    throw new Error('At least one success criterion is required')
  }
  if (task.budget.maxSteps < 1 || task.budget.maxRecoveries < 0 || task.budget.timeoutMs < 100) {
    throw new Error('Task budget is invalid')
  }
  return task
}
