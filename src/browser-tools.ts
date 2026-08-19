import type { Page, Route } from 'playwright'
import type { BrowserAction, BrowserObservation, ToolExecutionResult, ToolResult } from './types.ts'

export const MAX_OBSERVATION_TEXT_LENGTH = 8_000

const ORIGIN_GUARD_SETTLE_MS = 25

export class BrowserTools {
  private guardReady?: Promise<void>
  private blockedOrigin: string | undefined
  private readonly allowedOriginSet: ReadonlySet<string>

  constructor(
    private readonly page: Page,
    allowedOrigins: string[],
  ) {
    this.allowedOriginSet = new Set(allowedOrigins.map(normalizeOrigin))
    if (this.allowedOriginSet.size === 0) throw new Error('At least one allowed origin is required')
  }

  async open(url: string): Promise<BrowserObservation> {
    await this.openPage(url)
    return this.observe()
  }

  async openPage(url: string): Promise<void> {
    this.assertAllowed(url)
    await this.ensureOriginGuard()
    await this.page.goto(url, { waitUntil: 'domcontentloaded' })
  }

  async execute(action: BrowserAction): Promise<ToolResult> {
    const safeObservation = await this.observe()
    const outcome = await this.perform(action)
    if (!outcome.ok && outcome.error.code === 'ORIGIN_NOT_ALLOWED') {
      return { ok: false, error: outcome.error, observation: safeObservation }
    }
    const observation = await this.observe()
    return outcome.ok ? { ok: true, observation } : { ok: false, error: outcome.error, observation }
  }

  async perform(action: BrowserAction): Promise<ToolExecutionResult> {
    await this.ensureOriginGuard()
    this.blockedOrigin = undefined
    if (action.kind === 'finish') {
      return { ok: false, error: { code: 'INVALID_ACTION', message: 'Finish is not a browser tool', retryable: false } }
    }
    if (action.kind === 'observe') return { ok: true }
    try {
      if (action.kind === 'click') {
        await this.page.getByRole(action.role, { name: action.name, exact: true }).click({ timeout: 1_500 })
      } else {
        await this.page.getByRole(action.role, { name: action.name, exact: true }).fill(action.text, { timeout: 1_500 })
      }
      // Popup creation and redirect routing can finish on the next event-loop turn
      // after the DOM action itself resolves. Give the context guard a small,
      // bounded window to record the blocked request before reporting success.
      await this.page.waitForTimeout(ORIGIN_GUARD_SETTLE_MS)
      if (this.blockedOrigin) {
        return {
          ok: false,
          error: { code: 'ORIGIN_NOT_ALLOWED', message: `Origin not allowed: ${this.blockedOrigin}`, retryable: false },
        }
      }
      this.assertAllowed(this.page.url())
      return { ok: true }
    } catch (error) {
      const deniedOrigin = this.blockedOrigin ?? deniedOriginFrom(error)
      if (deniedOrigin) {
        return {
          ok: false,
          error: { code: 'ORIGIN_NOT_ALLOWED', message: `Origin not allowed: ${deniedOrigin}`, retryable: false },
        }
      }
      return {
        ok: false,
        error: {
          code: 'TARGET_NOT_FOUND',
          message: error instanceof Error ? compactError(error.message) : 'Target was not found',
          retryable: true,
        },
      }
    }
  }

  async observe(): Promise<BrowserObservation> {
    this.assertAllowed(this.page.url())
    const interactive = await this.page.locator('button, a, input, textarea').evaluateAll((elements) => elements.slice(0, 30).map((element) => ({
      role: element.getAttribute('role') || (element.tagName.toLowerCase() === 'a' ? 'link' : element.tagName.toLowerCase() === 'button' ? 'button' : 'textbox'),
      name: element.getAttribute('aria-label') || element.textContent?.trim() || element.getAttribute('name') || '',
    })))
    const text = (await this.page.locator('body').innerText()).replace(/\s+/g, ' ').trim().slice(0, MAX_OBSERVATION_TEXT_LENGTH)
    return { url: this.page.url(), title: await this.page.title(), text, interactive }
  }

  /**
   * Stops browser work after a runtime timeout. A BrowserTools instance should
   * be treated as single-use after cancellation.
   */
  async cancel(): Promise<void> {
    await Promise.all(this.page.context().pages().map(async (page) => {
      if (!page.isClosed()) await page.close({ runBeforeUnload: false }).catch(() => undefined)
    }))
  }

  private assertAllowed(url: string): void {
    const origin = new URL(url).origin
    if (!this.allowedOriginSet.has(origin)) throw new Error(`Origin not allowed: ${origin}`)
  }

  private async ensureOriginGuard(): Promise<void> {
    if (!this.guardReady) {
      // BrowserContext routing covers the first request of newly opened popup
      // pages, which Page.route cannot guarantee. It also sees redirected HTTP
      // requests before their response body becomes page evidence.
      //
      // Playwright cannot route requests already intercepted by a Service
      // Worker. Callers that require the strongest boundary should create the
      // context with `serviceWorkers: 'block'`; this guard is not a process or
      // network sandbox.
      this.guardReady = this.page.context().route('**/*', (route) => this.guardRoute(route)).then(() => undefined)
    }
    await this.guardReady
  }

  private async guardRoute(route: Route): Promise<void> {
    const request = route.request()
    const url = request.url()
    if (!this.isAllowed(url)) {
      this.blockedOrigin ??= safeOrigin(url)
      await route.abort('blockedbyclient')
      return
    }

    if (!request.isNavigationRequest()) {
      await route.continue()
      return
    }

    // `route.continue()` lets an HTTP redirect be followed below Playwright's
    // routing layer. Fetch a navigation response without following redirects,
    // validate Location, then fulfill the original request. Same-origin
    // redirects are returned to the browser and routed again normally.
    const response = await route.fetch({ maxRedirects: 0 })
    try {
      const location = response.headers()['location']
      if (isRedirectStatus(response.status()) && location) {
        const destination = resolveUrl(location, url)
        if (!destination || !this.isAllowed(destination)) {
          this.blockedOrigin ??= destination ? safeOrigin(destination) : '<invalid-origin>'
          await route.abort('blockedbyclient')
          return
        }
      }
      await route.fulfill({ response })
    } finally {
      await response.dispose()
    }
  }

  private isAllowed(url: string): boolean {
    if (url === 'about:blank' || url.startsWith('data:')) return true
    try {
      return this.allowedOriginSet.has(new URL(url).origin)
    } catch {
      return false
    }
  }
}

function compactError(message: string): string {
  return message.split('\n')[0]?.slice(0, 180) || 'Target was not found'
}

function normalizeOrigin(value: string): string {
  const url = new URL(value)
  if (url.origin === 'null') throw new Error(`Invalid allowed origin: ${value}`)
  return url.origin
}

function safeOrigin(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    return '<invalid-origin>'
  }
}

function deniedOriginFrom(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const match = /^Origin not allowed: (\S+)$/.exec(error.message)
  return match?.[1]
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function resolveUrl(value: string, base: string): string | undefined {
  try {
    return new URL(value, base).href
  } catch {
    return undefined
  }
}
