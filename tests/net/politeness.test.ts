import { describe, it, expect, vi } from 'vitest'
import { PolitenessLayer } from '../../src/net/politeness.js'

function harness(responses: Record<string, { status: number; body: string; headers?: Record<string, string> }>) {
  let clock = 0
  const sleeps: number[] = []
  const calls: string[] = []

  const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
    calls.push(url)
    const r = responses[url] ?? { status: 404, body: '' }
    return new Response(r.body, { status: r.status, headers: r.headers ?? {} })
  })

  const layer = new PolitenessLayer({
    userAgent: 'test-agent',
    minIntervalMs: 1000,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      clock += ms
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })

  return { layer, sleeps, calls, fetchImpl, advance: (ms: number) => (clock += ms) }
}

describe('PolitenessLayer', () => {
  it('spaces consecutive requests to the same host by minIntervalMs', async () => {
    const h = harness({
      'https://a.test/robots.txt': { status: 404, body: '' },
      'https://a.test/one': { status: 200, body: 'x' },
      'https://a.test/two': { status: 200, body: 'y' },
    })
    await h.layer.fetch('https://a.test/one')
    await h.layer.fetch('https://a.test/two')
    expect(h.sleeps).toContain(1000)
  })

  it('does not make different hosts wait for each other', async () => {
    const h = harness({
      'https://a.test/robots.txt': { status: 404, body: '' },
      'https://b.test/robots.txt': { status: 404, body: '' },
      'https://a.test/x': { status: 200, body: 'x' },
      'https://b.test/x': { status: 200, body: 'y' },
    })
    await h.layer.fetch('https://a.test/x')
    await h.layer.fetch('https://b.test/x')
    expect(h.sleeps).not.toContain(1000)
  })

  it('raises the interval to Crawl-delay when robots.txt asks for more', async () => {
    const h = harness({
      'https://slow.test/robots.txt': { status: 200, body: 'User-agent: *\nCrawl-delay: 30' },
      'https://slow.test/a': { status: 200, body: 'a' },
      'https://slow.test/b': { status: 200, body: 'b' },
    })
    await h.layer.fetch('https://slow.test/a')
    await h.layer.fetch('https://slow.test/b')
    expect(h.sleeps).toContain(30_000)
  })

  it('backs off for the number of seconds Retry-After names, then retries', async () => {
    let served = 0
    const h = harness({ 'https://r.test/robots.txt': { status: 404, body: '' } })
    h.fetchImpl.mockImplementation(async (url: string) => {
      if (String(url).endsWith('robots.txt')) return new Response('', { status: 404 })
      served += 1
      return served === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '7' } })
        : new Response('ok', { status: 200 })
    })
    const res = await h.layer.fetch('https://r.test/x')
    expect(h.sleeps).toContain(7000)
    expect(res.status).toBe(200)
    expect(res.body).toBe('ok')
  })

  it('sends the configured User-Agent on every request', async () => {
    const h = harness({
      'https://a.test/robots.txt': { status: 404, body: '' },
      'https://a.test/x': { status: 200, body: 'x' },
    })
    await h.layer.fetch('https://a.test/x')
    const init = h.fetchImpl.mock.calls.at(-1)?.[1]!
    expect((init.headers as Record<string, string>)['user-agent']).toBe('test-agent')
  })

  it('reports whether robots.txt permits a path', async () => {
    const h = harness({
      'https://x.test/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /search' },
    })
    expect(await h.layer.isAllowed('https://x.test/search?q=1')).toBe(false)
    expect(await h.layer.isAllowed('https://x.test/crates/serde')).toBe(true)
  })

  it('fetches robots.txt once per host', async () => {
    const h = harness({
      'https://x.test/robots.txt': { status: 200, body: 'User-agent: *\nDisallow:' },
      'https://x.test/a': { status: 200, body: 'a' },
      'https://x.test/b': { status: 200, body: 'b' },
    })
    await h.layer.fetch('https://x.test/a')
    await h.layer.fetch('https://x.test/b')
    expect(h.calls.filter((u) => u.endsWith('robots.txt'))).toHaveLength(1)
  })

  it('counts downloaded bytes', async () => {
    const h = harness({
      'https://a.test/robots.txt': { status: 404, body: '' },
      'https://a.test/x': { status: 200, body: 'hello' },
    })
    const res = await h.layer.fetch('https://a.test/x')
    expect(res.bytesDownloaded).toBe(5)
  })
})

describe('PolitenessLayer measurement and loopback', () => {
  it('reports how long it made the caller wait', async () => {
    const h = harness({
      'https://a.test/robots.txt': { status: 404, body: '' },
      'https://a.test/one': { status: 200, body: 'x' },
      'https://a.test/two': { status: 200, body: 'y' },
    })
    const first = await h.layer.fetch('https://a.test/one')
    const second = await h.layer.fetch('https://a.test/two')
    expect(first.waitedMs).toBe(0)
    expect(second.waitedMs).toBe(1000)
  })

  it('does not throttle loopback hosts, which are our own fixtures', async () => {
    const h = harness({
      'http://127.0.0.1:9/robots.txt': { status: 404, body: '' },
      'http://127.0.0.1:9/a': { status: 200, body: 'a' },
      'http://127.0.0.1:9/b': { status: 200, body: 'b' },
    })
    await h.layer.fetch('http://127.0.0.1:9/a')
    const second = await h.layer.fetch('http://127.0.0.1:9/b')
    expect(second.waitedMs).toBe(0)
    expect(h.sleeps).not.toContain(1000)
  })
})

describe('bounded waiting', () => {
  it('aborts a response that never arrives', async () => {
    const { createServer } = await import('node:http')
    const server = createServer(() => {})
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as import('node:net').AddressInfo
    try {
      await expect(new PolitenessLayer({ timeoutMs: 50 }).fetch(`http://127.0.0.1:${address.port}/hang`)).rejects.toThrow(/timeout|aborted/i)
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it('fails explicitly instead of waiting hours for Retry-After', async () => {
    const h = harness({
      'https://r.test/robots.txt': {status:404,body:''},
      'https://r.test/x': {status:429,body:'',headers:{'retry-after':'3600'}},
    })
    await expect(h.layer.fetch('https://r.test/x')).rejects.toThrow('retry later')
    expect(h.sleeps).not.toContain(3_600_000)
  })
})
