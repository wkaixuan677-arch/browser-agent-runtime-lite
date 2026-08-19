import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TrajectoryEvent } from './types.ts'

export const MAX_TRAJECTORY_EVENTS = 500
export const MAX_TRAJECTORY_OBSERVATION_TEXT_LENGTH = 2_000
export const MAX_TRAJECTORY_URL_LENGTH = 2_048
export const MAX_TRAJECTORY_TITLE_LENGTH = 512
export const MAX_TRAJECTORY_INTERACTIVE_ELEMENTS = 200
export const MAX_TRAJECTORY_INTERACTIVE_NAME_LENGTH = 256
export const MAX_TRAJECTORY_PLAN_STEPS = 100
export const MAX_TRAJECTORY_TOOL_ERROR_LENGTH = 1_024
export const MAX_TRAJECTORY_STRING_LENGTH = 4_096

const MAX_TRAJECTORY_ARRAY_ITEMS = 200
const MAX_TRAJECTORY_OBJECT_FIELDS = 200
const MAX_SANITIZE_DEPTH = 12

export class TrajectoryRecorder {
  private readonly events: TrajectoryEvent[] = []
  private droppedEvents = 0

  record(type: string, phase: string, payload: unknown = {}): void {
    if (this.events.at(-1)?.type === 'run.finished') return
    const event = { seq: this.events.length + 1, type: limit(redactSensitiveText(type), 128), phase: limit(redactSensitiveText(phase), 128), payload: sanitize(payload) }

    if (this.events.length < MAX_TRAJECTORY_EVENTS - 1) {
      this.events.push(event)
      return
    }

    if (type === 'run.finished') {
      const terminalEvent: TrajectoryEvent = {
        ...event,
        seq: Math.min(this.events.length + 1, MAX_TRAJECTORY_EVENTS),
        payload: addDroppedEventCount(event.payload, this.droppedEvents),
      }
      if (this.events.length === MAX_TRAJECTORY_EVENTS) this.events[MAX_TRAJECTORY_EVENTS - 1] = terminalEvent
      else this.events.push(terminalEvent)
      return
    }

    this.droppedEvents += 1
    const truncationEvent: TrajectoryEvent = {
      seq: MAX_TRAJECTORY_EVENTS,
      type: 'trajectory.truncated',
      phase: 'record',
      payload: { droppedEvents: this.droppedEvents },
    }
    if (this.events.length === MAX_TRAJECTORY_EVENTS) this.events[MAX_TRAJECTORY_EVENTS - 1] = truncationEvent
    else this.events.push(truncationEvent)
  }

  reset(): void {
    this.events.length = 0
    this.droppedEvents = 0
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
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 180)
}

function addDroppedEventCount(payload: unknown, droppedEvents: number): unknown {
  if (droppedEvents === 0) return payload
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), trajectoryDroppedEvents: droppedEvents }
  }
  return { payload, trajectoryDroppedEvents: droppedEvents }
}

function sanitize(value: unknown): unknown {
  return sanitizeValue(value, undefined, undefined, 0, new WeakSet<object>())
}

function sanitizeValue(
  value: unknown,
  parent: Record<string, unknown> | undefined,
  key: string | undefined,
  depth: number,
  ancestors: WeakSet<object>,
): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return '<truncated-depth>'
  if (typeof value === 'string') {
    if (key && isSensitiveKey(key)) return '<redacted-secret>'
    if (key === 'text' && parent?.kind === 'type') return '<redacted-input>'
    return limit(redactSensitiveText(value), maximumStringLength(key, parent))
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return '<circular-reference>'
    ancestors.add(value)
    const maximum = key === 'interactive'
      ? MAX_TRAJECTORY_INTERACTIVE_ELEMENTS
      : key === 'steps'
        ? MAX_TRAJECTORY_PLAN_STEPS
        : MAX_TRAJECTORY_ARRAY_ITEMS
    const sanitized = value.slice(0, maximum).map((item) => sanitizeValue(item, undefined, undefined, depth + 1, ancestors))
    ancestors.delete(value)
    return sanitized
  }
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) return '<circular-reference>'
    ancestors.add(value)
    const record = value as Record<string, unknown>
    const entries = Object.entries(record)
      .slice(0, MAX_TRAJECTORY_OBJECT_FIELDS)
      .map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, record, childKey, depth + 1, ancestors)])
    ancestors.delete(value)
    return Object.fromEntries(entries)
  }
  return value
}

function maximumStringLength(key?: string, parent?: Record<string, unknown>): number {
  if (key === 'url' || key === 'startUrl') return MAX_TRAJECTORY_URL_LENGTH
  if (key === 'title') return MAX_TRAJECTORY_TITLE_LENGTH
  if (key === 'text' && isObservation(parent)) return MAX_TRAJECTORY_OBSERVATION_TEXT_LENGTH
  if (key === 'name' && parent && typeof parent.role === 'string') return MAX_TRAJECTORY_INTERACTIVE_NAME_LENGTH
  if (key === 'message' && isToolError(parent)) return MAX_TRAJECTORY_TOOL_ERROR_LENGTH
  if (key === 'objective' || key === 'description' || key === 'successCriteria' || key === 'answer' || key === 'lesson' || key === 'recoveryHint') {
    return MAX_TRAJECTORY_TOOL_ERROR_LENGTH
  }
  if (key === 'id' || key === 'taskId' || key === 'code' || key === 'criterion') return 256
  return MAX_TRAJECTORY_STRING_LENGTH
}

function isObservation(value?: Record<string, unknown>): boolean {
  return Boolean(value && typeof value.url === 'string' && typeof value.title === 'string' && Array.isArray(value.interactive))
}

function isToolError(value?: Record<string, unknown>): boolean {
  return Boolean(value && typeof value.code === 'string' && typeof value.retryable === 'boolean')
}

function isSensitiveKey(key: string): boolean {
  return /^(?:api[_-]?key|x[_-]?api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|password|passwd|secret|credential)s?$/i.test(key)
}

function limit(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  const suffix = '…<truncated>'
  return `${value.slice(0, Math.max(0, maximum - suffix.length))}${suffix}`
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(https?:\/\/)[^@\s/]+@/gi, '$1<redacted-userinfo>@')
    .replace(/file:\/\/\/[^\s"'<>]+/gi, '<file-url>')
    .replace(/\b[A-Za-z]:[\\/][^"'\r\n<>|]+/g, '<local-path>')
    .replace(/(?<![:\w])\/(?:home|Users|tmp|var|etc|opt|mnt|workspace|workspaces|srv|app)(?:\/[^\s"'<>;,\])}]+)+/g, '<local-path>')
    .replace(/\bhttps?:\/\/[^\s"'<>?]+\?[^\s"'<>]*/gi, (url) => `${url.slice(0, url.indexOf('?'))}?<redacted-query>`)
    .replace(/\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s,;]+/gi, 'Authorization: <redacted-secret>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted-secret>')
    .replace(/\bBasic\s+[A-Za-z0-9+/=_-]+/gi, 'Basic <redacted-secret>')
    .replace(/("(?:api[_-]?key|x[_-]?api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|password|passwd|secret|credential)s?"\s*:\s*")[^"]*(")/gi, '$1<redacted-secret>$2')
    .replace(/('(?:api[_-]?key|x[_-]?api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|password|passwd|secret|credential)s?'\s*:\s*')[^']*(')/gi, '$1<redacted-secret>$2')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,})\b/g, '<redacted-secret>')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted-secret>')
    .replace(/\b(api[_-]?key|x[_-]?api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|password|passwd|secret|credential)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2<redacted-secret>')
    .replace(/\b(?:AGENTV4_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)(\s*[:=]\s*)[^\s,;]+/gi, (match, separator: string) => `${match.slice(0, match.indexOf(separator))}${separator}<redacted-secret>`)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '<redacted-email>')
}
