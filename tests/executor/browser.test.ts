import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startSpaFixture } from '../../fixtures/spa.js'
import type { FixtureServer } from '../../fixtures/harness.js'
import { StaticSiteResolver } from '../../src/sites.js'
import { BrowserStrategy } from '../../src/executor/strategies/browser.js'
import type { Recipe } from '../../src/recipes/schema.js'
import type { Task } from '../../src/types.js'

let server: FixtureServer
let strategy: BrowserStrategy

const recipe: Recipe = {
  site: 'siteC', intent: 'search',
  inputs: { query: { type: 'string' } },
  strategy: { type: 'browser' },
  request: { method: 'GET', path: '/search', query: { q: '{{query}}' } },
  output: { type: 'html', items: { selector: 'li.result', fields: { id: '@data-id', title: '' } } },
  validation: { status: 200, required: ['id'], minItems: 1 },
  fingerprint: { endpoint: '/search', hash: 'x', responseFields: [] },
  fallback: { type: 'browser' },
}

beforeAll(async () => {
  server = await startSpaFixture()
  strategy = new BrowserStrategy(new StaticSiteResolver({ siteC: server.url }), {
    siteC: {
      search: {
        url: (origin, task) => `${origin}/search?q=${encodeURIComponent(String(task.input.query))}`,
        itemSelector: 'li.result',
        fields: { id: '@data-id', title: '' },
      },
    },
  })
})
afterAll(async () => { await server.close() })

describe('BrowserStrategy', () => {
  it('reads results that only exist after JS has run', async () => {
    const task: Task = { id: 't1', site: 'siteC', intent: 'search', input: { query: 'rust' } }
    const result = await strategy.execute(recipe, task)
    expect(result.items.length).toBeGreaterThan(0)
    expect(String(result.items[0]!.title)).toContain('rust')
  })

  it('reports the true cost of using a browser', async () => {
    const task: Task = { id: 't2', site: 'siteC', intent: 'search', input: { query: 'rust' } }
    const result = await strategy.execute(recipe, task)
    expect(result.meta.strategy).toBe('browser')
    expect(result.meta.browserLaunches).toBe(1)
    expect(result.meta.pageNavigations).toBeGreaterThanOrEqual(1)
    expect(result.meta.networkRequests).toBeGreaterThan(1)
    expect(result.meta.bytesDownloaded).toBeGreaterThan(0)
    expect(result.meta.llmTokens).toBeGreaterThan(0)
  })

  it('still works after the v2 schema change, which is the point of a fallback', async () => {
    server.setVersion('v2')
    const task: Task = { id: 't3', site: 'siteC', intent: 'search', input: { query: 'rust' } }
    const result = await strategy.execute(recipe, task)
    expect(result.items.length).toBeGreaterThan(0)
    server.setVersion('v1')
  })
})
