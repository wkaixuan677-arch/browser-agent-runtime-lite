import { redactSensitiveText } from './trajectory.ts'
import type { BrowserObservation, TaskContract, VerificationReport } from './types.ts'

const URL_CRITERION_BASE = 'https://criterion.invalid'
const MAX_URL_CRITERION_LENGTH = 2_048
const MAX_EVIDENCE_LENGTH = 320

export type UrlMatchCriterion = {
  origin: string | null
  pathname: string
  query: ReadonlyArray<readonly [string, string]>
}

export function parseUrlMatchCriterion(value: string): UrlMatchCriterion {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error('URL success criterion must be a non-empty, trimmed string')
  }
  if (value.length > MAX_URL_CRITERION_LENGTH) throw new Error('URL success criterion is too long')
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value) || value.includes('\\') || value.includes('*')) {
    throw new Error('URL success criterion contains unsafe characters')
  }
  if (/%(?:2e|2f|5c)/i.test(value)) throw new Error('URL success criterion contains an unsafe encoded path segment')
  if (value.startsWith('//') || value.startsWith('?') || value.startsWith('#')) {
    throw new Error('URL success criterion must identify a path or an absolute HTTP(S) URL')
  }

  const isAbsolute = /^[a-z][a-z\d+.-]*:/i.test(value)
  let parsed: URL
  try {
    parsed = new URL(isAbsolute ? value : (value.startsWith('/') ? value : `/${value}`), URL_CRITERION_BASE)
  } catch {
    throw new Error('URL success criterion is not parseable')
  }

  if (isAbsolute && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL success criterion must use HTTP or HTTPS')
  }
  if (parsed.username || parsed.password) throw new Error('URL success criterion must not contain credentials')
  if (parsed.hash) throw new Error('URL success criterion must not contain a fragment')
  if (value.split(/[?#]/, 1)[0]?.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new Error('URL success criterion contains a traversal segment')
  }
  for (const key of parsed.searchParams.keys()) {
    if (isSensitiveQueryKey(key)) throw new Error('URL success criterion must not contain secret-bearing query parameters')
  }

  return {
    origin: isAbsolute ? parsed.origin : null,
    pathname: normalizePathname(parsed.pathname),
    query: [...parsed.searchParams.entries()],
  }
}

export function verifyGoal(task: TaskContract, observation: BrowserObservation): VerificationReport {
  const checks: VerificationReport['checks'] = []
  if (task.successCriteria.urlIncludes) {
    const expected = parseUrlMatchCriterion(task.successCriteria.urlIncludes)
    const match = matchStructuredUrl(observation.url, expected, task.allowedOrigins)
    checks.push({
      criterion: describeUrlCriterion(expected),
      passed: match.passed,
      evidence: match.evidence,
    })
  }
  for (const expected of task.successCriteria.textIncludes ?? []) {
    const match = findCaseInsensitive(observation.text, expected)
    checks.push({
      criterion: `Page text contains ${expected}`,
      passed: match !== null,
      evidence: match === null
        ? `No match for ${limit(redactSensitiveText(expected), 120)} in the visible page text.`
        : contextSnippet(observation.text, match.index, match.length),
    })
  }
  return { passed: checks.length > 0 && checks.every((check) => check.passed), checks }
}

function matchStructuredUrl(value: string, expected: UrlMatchCriterion, allowedOrigins: readonly string[]): { passed: boolean; evidence: string } {
  let actual: URL
  try {
    actual = new URL(value)
  } catch {
    return { passed: false, evidence: 'Observed URL is invalid.' }
  }
  if (actual.protocol !== 'http:' && actual.protocol !== 'https:') {
    return { passed: false, evidence: `Observed unsupported URL protocol ${actual.protocol}` }
  }

  const allowedOriginPassed = allowedOrigins.some((origin) => {
    try {
      return new URL(origin).origin === actual.origin
    } catch {
      return false
    }
  })
  const originPassed = allowedOriginPassed && (expected.origin === null || actual.origin === expected.origin)
  const pathPassed = pathMatches(actual.pathname, expected.pathname)
  const queryPassed = queryMatches(actual.searchParams, expected.query)
  const passed = originPassed && pathPassed && queryPassed
  const observed = limit(redactSensitiveText(`${actual.origin}${normalizePathname(actual.pathname)}`), MAX_EVIDENCE_LENGTH)
  if (!passed) return { passed: false, evidence: `Observed structured URL ${observed}; required ${describeUrlCriterion(expected)}.` }

  const queryNote = expected.query.length > 0
    ? ` with query keys ${[...new Set(expected.query.map(([key]) => key))].join(', ')}`
    : ''
  return { passed: true, evidence: `Matched ${observed}${queryNote}.` }
}

function pathMatches(actualPathname: string, expectedPathname: string): boolean {
  const actual = normalizePathname(actualPathname)
  const expected = normalizePathname(expectedPathname)
  if (expected === '/') return actual === '/'
  return actual === expected || actual.startsWith(`${expected}/`)
}

function queryMatches(actual: URLSearchParams, expected: UrlMatchCriterion['query']): boolean {
  if (expected.length === 0) return true
  const actualEntries = [...actual.entries()].sort(compareQueryEntries)
  const expectedEntries = [...expected].sort(compareQueryEntries)
  return actualEntries.length === expectedEntries.length
    && actualEntries.every(([key, value], index) => key === expectedEntries[index]?.[0] && value === expectedEntries[index]?.[1])
}

function compareQueryEntries(left: readonly [string, string], right: readonly [string, string]): number {
  return left[0].localeCompare(right[0]) || left[1].localeCompare(right[1])
}

function normalizePathname(pathname: string): string {
  if (pathname === '/') return pathname
  return pathname.replace(/\/+$/, '') || '/'
}

function describeUrlCriterion(expected: UrlMatchCriterion): string {
  const location = `${expected.origin ?? ''}${expected.pathname}`
  const queryKeys = [...new Set(expected.query.map(([key]) => key))]
  return queryKeys.length === 0 ? `URL matches ${location}` : `URL matches ${location} with query keys ${queryKeys.join(', ')}`
}

function findCaseInsensitive(text: string, expected: string): { index: number; length: number } | null {
  const index = text.toLocaleLowerCase().indexOf(expected.toLocaleLowerCase())
  return index < 0 ? null : { index, length: expected.length }
}

function contextSnippet(text: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - 80)
  const end = Math.min(text.length, index + matchLength + 80)
  return limit(redactSensitiveText(text.slice(start, end)), MAX_EVIDENCE_LENGTH)
}

function isSensitiveQueryKey(key: string): boolean {
  return /^(?:api[_-]?key|x[_-]?api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|password|passwd|secret|credential)s?$/i.test(key)
}

function limit(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  const suffix = '…<truncated>'
  return `${value.slice(0, maximum - suffix.length)}${suffix}`
}

export function visibleBlocker(task: TaskContract, observation: BrowserObservation): string | null {
  return task.blockerText?.find((text) => text.length > 0 && observation.text.toLocaleLowerCase().includes(text.toLocaleLowerCase())) ?? null
}
