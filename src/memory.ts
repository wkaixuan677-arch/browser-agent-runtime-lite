import type { BrowserAction, ExperienceMemory } from './types.ts'

export function actionFingerprint(action: BrowserAction): string {
  if (action.kind === 'click') return `click:${action.role}:${action.name}`
  if (action.kind === 'type') return `type:${action.role}:${action.name}`
  return `${action.kind}:${action.id}`
}

export class WorkingMemory {
  private readonly failures = new Map<string, number>()

  recordFailure(action: BrowserAction): number {
    const fingerprint = actionFingerprint(action)
    const count = (this.failures.get(fingerprint) ?? 0) + 1
    this.failures.set(fingerprint, count)
    return count
  }

  failedActionFingerprints(): string[] {
    return [...this.failures.keys()]
  }

  failureCount(action: BrowserAction): number {
    return this.failures.get(actionFingerprint(action)) ?? 0
  }
}

export class ExperienceMemoryStore {
  constructor(private readonly memories: ExperienceMemory[] = []) {}

  retrieve(tags: string[]): ExperienceMemory[] {
    return this.memories
      .filter((memory) => memory.status === 'promoted')
      .filter((memory) => memory.tags.some((tag) => tags.includes(tag)))
      .sort((left, right) => right.confidence - left.confidence)
      .map((memory) => structuredClone(memory))
  }
}
