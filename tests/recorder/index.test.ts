import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startXhrFixture } from '../../fixtures/xhr.js'
import type { FixtureServer } from '../../fixtures/harness.js'
import { StaticSiteResolver } from '../../src/sites.js'
import { record } from '../../src/recorder/index.js'
import type { BrowserPlan } from '../../src/executor/strategies/browser.js'
import type { Task } from '../../src/types.js'

let server: FixtureServer
let plan: BrowserPlan
const task: Task = { id: 'r1', site: 'siteB', intent: 'search', input: { query: 'rust' } }

beforeAll(async () => {
  server = await startXhrFixture()
  plan = {
    url: (origin, t) => `${origin}/search?q=${encodeURIComponent(String(t.input.query))}`,
    itemSelector: 'li.result',
    fields: { id: '@data-id', title: '' },
  }
})
afterAll(async () => { await server.close() })

describe('record', () => {
  it('captures every request the page made, decoys included', async () => {
    const trace = await record(plan, task, new StaticSiteResolver({ siteB: server.url }))
    const paths = trace.requests.map((r) => new URL(r.url).pathname)
    expect(paths).toContain('/api/search')
    expect(paths).toContain('/analytics/collect')
    expect(paths).toContain('/api/feature-flags')
    expect(paths).toContain('/api/autocomplete')
  })

  it('records a navigate action and ties requests to it', async () => {
    const trace = await record(plan, task, new StaticSiteResolver({ siteB: server.url }))
    expect(trace.actions[0]!.type).toBe('navigate')
    const search = trace.requests.find((r) => new URL(r.url).pathname === '/api/search')!
    expect(search.afterAction).toBe(0)
  })

  it('captures response bodies for JSON responses', async () => {
    const trace = await record(plan, task, new StaticSiteResolver({ siteB: server.url }))
    const search = trace.requests.find((r) => new URL(r.url).pathname === '/api/search')!
    expect(search.contentType).toMatch(/json/)
    expect(JSON.parse(search.body!).results.length).toBeGreaterThan(0)
  })

  it('marks the request that was followed by a DOM change', async () => {
    const trace = await record(plan, task, new StaticSiteResolver({ siteB: server.url }))
    const search = trace.requests.find((r) => new URL(r.url).pathname === '/api/search')!
    const flags = trace.requests.find((r) => new URL(r.url).pathname === '/api/feature-flags')!
    expect(search.domChanged).toBe(true)
    expect(flags.domChanged).toBe(false)
  })

  it('keeps the final rendered HTML', async () => {
    const trace = await record(plan, task, new StaticSiteResolver({ siteB: server.url }))
    expect(trace.finalHtml).toContain('li class="result"')
  })
})
