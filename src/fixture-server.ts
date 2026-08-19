import { createServer, type Server } from 'node:http'
import { once } from 'node:events'

export async function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (request.url === '/report') {
      response.end(page('Agent Reliability Report', '<h1>Report ready</h1><p>Version 4.2</p>'))
      return
    }
    if (request.url === '/blocked') {
      response.end(page('Blocked demo', '<h1>Access unavailable</h1><p>This deterministic scenario intentionally has no public recovery route.</p>'))
      return
    }
    if (request.url?.startsWith('/external-link')) {
      const target = new URL(request.url, 'http://127.0.0.1').searchParams.get('target') ?? 'https://example.invalid/'
      response.end(page('External navigation', `<h1>Navigation guard</h1><a href="${escapeAttribute(target)}">Leave site</a>`))
      return
    }
    response.end(page('Demo home', '<h1>Runtime demo</h1><a href="/report">Open report</a><a href="/blocked">Open blocked demo</a>'))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
}

async function closeServer(server: Server): Promise<void> {
  server.close()
  await once(server, 'close')
}
