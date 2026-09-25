import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startXhrFixture } from '../../fixtures/xhr.js'
import type { FixtureServer } from '../../fixtures/harness.js'
import { PolitenessLayer } from '../../src/net/politeness.js'
import { StaticSiteResolver } from '../../src/sites.js'
import { HttpJsonStrategy, buildUrl } from '../../src/executor/strategies/http-json.js'
import type { Recipe } from '../../src/recipes/schema.js'
import type { Task } from '../../src/types.js'

let server: FixtureServer
let strategy: HttpJsonStrategy

const recipe: Recipe = {
  site: 'siteB', intent: 'search',
  inputs: { query: { type: 'string' } },
  strategy: { type: 'http-json' },
  request: { method: 'GET', path: '/api/search', query: { q: '{{query}}' } },
  output: { type: 'json', items: { path: '$.results', fields: { id: '$.id', title: '$.title' } } },
  validation: { status: 200, required: ['id', 'title'], minItems: 1 },
  fingerprint: { endpoint: '/api/search', hash: 'x', responseFields: [] },
  fallback: { type: 'browser' },
}

const task: Task = { id: 't1', site: 'siteB', intent: 'search', input: { query: 'rust' } }

beforeAll(async () => {
  server = await startXhrFixture()
  strategy = new HttpJsonStrategy(
    new PolitenessLayer({ minIntervalMs: 0 }),
    new StaticSiteResolver({ siteB: server.url }),
  )
})
afterAll(async () => { await server.close() })

describe('HttpJsonStrategy', () => {
  it('returns items extracted at the recipe path with the recipe field names', async () => {
    const result = await strategy.execute(recipe, task)
    expect(result.items.length).toBeGreaterThan(0)
    expect(Object.keys(result.items[0]!).sort()).toEqual(['id', 'title'])
    expect(String(result.items[0]!.title)).toContain('rust')
  })

  it('never launches a browser and makes exactly one request', async () => {
    const result = await strategy.execute(recipe, task)
    expect(result.meta.strategy).toBe('http-json')
    expect(result.meta.browserLaunches).toBe(0)
    expect(result.meta.pageNavigations).toBe(0)
    expect(result.meta.networkRequests).toBe(1)
  })

  it('records latency and downloaded bytes', async () => {
    const result = await strategy.execute(recipe, task)
    expect(result.meta.bytesDownloaded).toBeGreaterThan(0)
    expect(result.meta.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.meta.llmTokens).toBeGreaterThan(0)
  })

  // A moved endpoint must not pass silently. It no longer throws here: the
  // status is reported so the validator can say why and the executor can tell a
  // refusal from rot, and the validator's minItems rule is what now fails it.
  it('returns the status and no items when the endpoint has moved, so the validator can say why', async () => {
    server.setVersion('v2')
    const result = await strategy.execute(recipe, task)
    expect(result.status).toBe(404)
    expect(result.items).toHaveLength(0)
    server.setVersion('v1')
  })

  it('substitutes a detail id into the path', async () => {
    const detail: Recipe = {
      ...recipe, intent: 'detail',
      inputs: { id: { type: 'string' } },
      request: { method: 'GET', path: '/api/item', query: { id: '{{id}}' } },
      output: { type: 'json', items: { path: '$.result', fields: { id: '$.id', title: '$.title' } } },
      validation: { status: 200, required: ['id'], minItems: 1 },
    }
    const result = await strategy.execute(detail, { id: 't2', site: 'siteB', intent: 'detail', input: { id: '100' } })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.id).toBe('100')
  })
})

describe('buildUrl with a third-party origin', () => {
  it('uses the site origin when the recipe names none', () => {
    expect(buildUrl('https://site.test', recipe, task)).toBe('https://site.test/api/search?q=rust')
  })

  it('uses the recipe origin when the data request lives on another host', () => {
    const thirdParty: Recipe = {
      ...recipe,
      request: { ...recipe.request, origin: 'https://abc-dsn.algolia.net' },
    }
    expect(buildUrl('https://site.test', thirdParty, task))
      .toBe('https://abc-dsn.algolia.net/api/search?q=rust')
  })

  it('rejects an input that would carry the request off the recipe origin', () => {
    const detail: Recipe = {
      ...recipe, intent: 'detail',
      inputs: { id: { type: 'string' } },
      request: { method: 'GET', path: '/{{id}}' },
    }
    const evil: Task = { id: 't3', site: 'siteB', intent: 'detail', input: { id: '/evil.example/x' } }
    expect(() => buildUrl('https://site.test', detail, evil)).toThrow(/evil\.example/)
  })

  it('still resolves inside the site origin for an ordinary input carrying slashes', () => {
    const detail: Recipe = {
      ...recipe, intent: 'detail',
      inputs: { id: { type: 'string' } },
      request: { method: 'GET', path: '/{{id}}' },
    }
    const mux: Task = { id: 't4', site: 'siteB', intent: 'detail', input: { id: 'github.com/gorilla/mux' } }
    expect(buildUrl('https://site.test', detail, mux))
      .toBe('https://site.test/github.com/gorilla/mux')
  })
})

describe('template fields in a json recipe', () => {
  const derived: Recipe = {
    ...recipe,
    output: {
      type: 'json',
      items: { path: '$.results', fields: { id: '$.id', link: '/item/{{id}}' } },
    },
    validation: { status: 200, required: ['id', 'link'], minItems: 1 },
  }

  it('renders a field whose spec is a template over the row', async () => {
    const result = await strategy.execute(derived, task)
    expect(result.items[0]!.link).toBe(`/item/${result.items[0]!.id}`)
  })

  it('still reads a field whose spec is a path', async () => {
    const result = await strategy.execute(derived, task)
    expect(String(result.items[0]!.id)).toMatch(/^\d+$/)
  })
})
