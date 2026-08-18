import { chromium, type Browser } from 'playwright'

export async function launchBrowser(): Promise<Browser> {
  const channel = process.env.AGENT_BROWSER_CHANNEL
  if (channel === 'msedge' || channel === 'chrome') {
    return chromium.launch({ headless: true, channel })
  }
  return chromium.launch({ headless: true })
}
