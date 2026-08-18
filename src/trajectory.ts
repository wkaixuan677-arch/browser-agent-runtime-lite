import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TrajectoryEvent } from './types.ts'

export class TrajectoryRecorder {
  private readonly events: TrajectoryEvent[] = []

  record(type: string, phase: string, payload: unknown = {}): void {
    this.events.push({ seq: this.events.length + 1, type, phase, payload: sanitize(payload) })
  }

  snapshot(): TrajectoryEvent[] {
    return structuredClone(this.events)
  }

  async save(taskId: string, directory = '.artifacts'): Promise<string> {
    await mkdir(directory, { recursive: true })
    const relativePath = join(directory, `${safeName(taskId)}.trajectory.json`)
    await writeFile(relativePath, `${JSON.stringify(this.events, null, 2)}\n`, 'utf8')
    return relativePath.replaceAll('\\', '/')
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function sanitize(value: unknown): unknown {
  const serialized = JSON.stringify(value)
  if (!serialized) return value
  return JSON.parse(serialized.replace(/[A-Za-z]:\\\\[^"\n]+/g, '<local-path>').replace(/file:\/\/\/[^"\n]+/g, '<file-url>'))
}
