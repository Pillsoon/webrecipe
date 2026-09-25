import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { startFixture } from '../fixtures/harness.js'
import { buildEngine } from '../src/wiring.js'

it('accounts for all assets in both fallback and healing, then only HTTP on reuse', async () => {
  let bytes = 0
  const html = '<!doctype html><link rel="stylesheet" href="/style"><script src="/script"></script><ul><li class="result"><a href="/item">Result</a></li></ul>'
  const assets: Record<string, [string, string]> = {
    '/style': ['text/css', '/*' + 'c'.repeat(4096) + '*/'],
    '/script': ['application/javascript', '/*' + 'j'.repeat(4096) + '*/;fetch("/empty")'],
  }
  const server = await startFixture('measurement', (req, res) => {
    if (req.url === '/empty') { res.writeHead(204); res.end(); return }
    const [type, body] = assets[req.url ?? ''] ?? ['text/html', html]
    bytes += Buffer.byteLength(body)
    res.writeHead(200, { 'content-type': type }); res.end(body)
  })
  const dir = await mkdtemp('/tmp/fwa-measurement-')
  const engine = buildEngine({ recipeDir: dir, origins: { measured: server.url }, plans: {
    measured: { search: { url: (o, t) => `${o}/search?q=${t.input.query}`, itemSelector: 'li.result', fields: { title: 'a', url: 'a@href' } } },
  } })
  const task = { id: 'test', site: 'measured', intent: 'search' as const, input: { query: 'one' } }
  try {
    const started = performance.now()
    const first = await engine.executor.run(task)
    const wall = Math.round(performance.now() - started)
    expect(first.meta.browserLaunches).toBe(2)
    expect(first.meta.networkRequests).toBe(server.requestLog.length)
    expect(first.meta.bytesDownloaded).toBe(bytes)
    expect(first.meta.bytesDownloaded).toBeGreaterThan(16000)
    expect(first.meta.unreadResponseBodies).toBe(0)
    expect(Math.abs(first.meta.elapsedMs! - wall)).toBeLessThan(30)
    const before = server.requestLog.length
    const second = await engine.executor.run(task)
    expect(second.recipeUsed).toBe(true)
    expect(second.meta.browserLaunches).toBe(0)
    expect(second.meta.networkRequests).toBe(1)
    expect(server.requestLog.length - before).toBe(1)
    expect(second.meta.bytesDownloaded).toBe(Buffer.byteLength(html))
  } finally {
    await engine.warm.close(); await server.close(); await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
