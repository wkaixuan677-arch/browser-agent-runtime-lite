import type { Page } from 'playwright'
import type { BrowserAction, BrowserObservation, ToolResult } from './types.ts'

export class BrowserTools {
  private guardReady?: Promise<void>
  private blockedOrigin: string | undefined

  constructor(
    private readonly page: Page,
    private readonly allowedOrigins: string[],
  ) {}

  async open(url: string): Promise<BrowserObservation> {
    this.assertAllowed(url)
    await this.ensureOriginGuard()
    await this.page.goto(url, { waitUntil: 'domcontentloaded' })
    return this.observe()
  }

  async execute(action: BrowserAction): Promise<ToolResult> {
    await this.ensureOriginGuard()
    this.blockedOrigin = undefined
    if (action.kind === 'finish') {
      return { ok: false, error: { code: 'INVALID_ACTION', message: 'Finish is not a browser tool', retryable: false }, observation: await this.observe() }
    }
    if (action.kind === 'observe') return { ok: true, observation: await this.observe() }
    const safeObservation = await this.observe()
    try {
      if (action.kind === 'click') {
        await this.page.getByRole(action.role, { name: action.name, exact: true }).click({ timeout: 1_500 })
      } else {
        await this.page.getByRole(action.role, { name: action.name, exact: true }).fill(action.text, { timeout: 1_500 })
      }
      if (this.blockedOrigin) {
        return {
          ok: false,
          error: { code: 'ORIGIN_NOT_ALLOWED', message: `Origin not allowed: ${this.blockedOrigin}`, retryable: false },
          observation: safeObservation,
        }
      }
      this.assertAllowed(this.page.url())
      return { ok: true, observation: await this.observe() }
    } catch (error) {
      if (this.blockedOrigin) {
        return {
          ok: false,
          error: { code: 'ORIGIN_NOT_ALLOWED', message: `Origin not allowed: ${this.blockedOrigin}`, retryable: false },
          observation: safeObservation,
        }
      }
      return {
        ok: false,
        error: {
          code: 'TARGET_NOT_FOUND',
          message: error instanceof Error ? compactError(error.message) : 'Target was not found',
          retryable: true,
        },
        observation: await this.observe(),
      }
    }
  }

  async observe(): Promise<BrowserObservation> {
    this.assertAllowed(this.page.url())
    const interactive = await this.page.locator('button, a, input, textarea').evaluateAll((elements) => elements.slice(0, 30).map((element) => ({
      role: element.getAttribute('role') || (element.tagName.toLowerCase() === 'a' ? 'link' : element.tagName.toLowerCase() === 'button' ? 'button' : 'textbox'),
      name: element.getAttribute('aria-label') || element.textContent?.trim() || element.getAttribute('name') || '',
    })))
    const text = (await this.page.locator('body').innerText()).replace(/\s+/g, ' ').trim().slice(0, 4_000)
    return { url: this.page.url(), title: await this.page.title(), text, interactive }
  }

  private assertAllowed(url: string): void {
    const origin = new URL(url).origin
    if (!this.allowedOrigins.includes(origin)) throw new Error(`Origin not allowed: ${origin}`)
  }

  private async ensureOriginGuard(): Promise<void> {
    if (!this.guardReady) {
      this.guardReady = this.page.route('**/*', async (route) => {
        const url = route.request().url()
        if (this.isAllowed(url)) {
          await route.continue()
          return
        }
        this.blockedOrigin = new URL(url).origin
        await route.abort('blockedbyclient')
      }).then(() => undefined)
    }
    await this.guardReady
  }

  private isAllowed(url: string): boolean {
    if (url === 'about:blank' || url.startsWith('data:')) return true
    try {
      return this.allowedOrigins.includes(new URL(url).origin)
    } catch {
      return false
    }
  }
}

function compactError(message: string): string {
  return message.split('\n')[0]?.slice(0, 180) || 'Target was not found'
}
