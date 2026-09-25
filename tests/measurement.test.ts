import { describe, it, expect } from 'vitest'
import { ExecutionFailure, measureResult, costSink } from '../src/measurement.js'
import { emptyMeta } from '../src/types.js'
import { PolitenessLayer } from '../src/net/politeness.js'
import { HttpJsonStrategy } from '../src/executor/strategies/http-json.js'
import type { Recipe } from '../src/recipes/schema.js'

const recipe: Recipe = { site: 's', intent: 'list', inputs: {}, strategy: { type: 'http-json' },
  fingerprint: { endpoint: '/items', hash: '', responseFields: [] }, fallback: { type: 'browser' }, request: { method: 'GET', path: '/items' }, validation: { status: 200, required: [], minItems: 1 },
  output: { type: 'json', items: { path: '$.items', fields: { title: '$.title' } } } }
const task = { id: 't', site: 's', intent: 'list' as const, input: {} }

describe('task cost measurement', () => {
  it('counts robots, retry and redirect bodies even when HTTP ultimately succeeds', async () => {
    const bodies = ['User-agent: *\nAllow: /', 'retry', 'redirect', '{"items":[{"title":"ok"}]}']
    let calls = 0
    const net = new PolitenessLayer({ sleep: async () => {}, minIntervalMs: 0,
      fetchImpl: (async () => {
        const i = calls++
        return new Response(bodies[i], i === 1 ? { status: 429, headers: { 'retry-after': '1' } }
          : i === 2 ? { status: 302, headers: { location: '/final' } } : {})
      }) as typeof fetch,
    })
    const out = await new HttpJsonStrategy(net, { origin: () => 'https://site.test' }).execute(recipe, task)
    expect(calls).toBe(4)
    expect(out.meta.networkRequests).toBe(4)
    expect(out.meta.bytesDownloaded).toBe(bodies.join('').length)
    expect(out.meta.politenessWaitMs).toBe(1000)
    expect(out.items).toEqual([{ title: 'ok' }])
  })

  it('retains costs of a thrown nested attempt before another attempt answers', async () => {
    const out = await measureResult('browser', async () => {
      try {
        await measureResult('http-json', async () => {
          costSink()({ networkRequests: 1, bytesDownloaded: 8 })
          throw new Error('read failed')
        })
      } catch {}
      costSink()({ browserLaunches: 1, networkRequests: 3, bytesDownloaded: 100 })
      return { meta: emptyMeta('warm-browser') }
    })
    expect(out.meta).toMatchObject({ networkRequests: 4, bytesDownloaded: 108, browserLaunches: 1 })
  })

  it('keeps simultaneous tasks isolated and measures time outside attempts', async () => {
    const run = (n: number) => measureResult('http-json', async () => {
      const charge = costSink()
      await new Promise(r => setTimeout(r, 30))
      charge({ networkRequests: n })
      return { meta: emptyMeta('http-json') }
    })
    const [a,b] = await Promise.all([run(2),run(7)])
    expect(a.meta.networkRequests).toBe(2)
    expect(b.meta.networkRequests).toBe(7)
    expect(a.meta.elapsedMs).toBeGreaterThanOrEqual(25)
  })

  it('preserves measured cost when the entire task throws', async () => {
    try {
      await measureResult('browser', async () => {
        costSink()({ networkRequests: 2, browserLaunches: 1 })
        throw new Error('navigation failed')
      })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionFailure)
      expect((error as ExecutionFailure).meta).toMatchObject({ networkRequests: 2, browserLaunches: 1 })
    }
  })
})

it('preserves redirects while stripping credentials and rewriting POST on 303', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const net = new PolitenessLayer({ minIntervalMs: 0, fetchImpl: (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('robots.txt')) return new Response('')
    if (url.endsWith('/items')) return new Response('', { status: 303, headers: { location: 'https://other.test/final' } })
    return new Response('{"items":[{"title":"ok"}]}')
  }) as typeof fetch })
  await new HttpJsonStrategy(net, { origin: () => 'https://site.test' }).execute({ ...recipe,
    request: { ...recipe.request, method: 'POST', body: 'data', headers: { authorization: 'test-token', 'content-type': 'text/plain' } },
  }, task)
  expect(calls.at(-1)!.init.method).toBe('GET')
  expect(calls.at(-1)!.init.body).toBeUndefined()
  expect(calls.at(-1)!.init.headers).not.toHaveProperty('authorization')
  expect(calls.at(-1)!.init.headers).not.toHaveProperty('content-type')
})
