import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startXhrFixture } from '../../fixtures/xhr.js'
import { startSpaFixture } from '../../fixtures/spa.js'
import type { FixtureServer } from '../../fixtures/harness.js'
import { StaticSiteResolver } from '../../src/sites.js'
import { record } from '../../src/recorder/index.js'
import { scoreRequests, pickDataRequest } from '../../src/analyzer/score.js'
import type { Trace } from '../../src/recorder/types.js'
import type { Task } from '../../src/types.js'

let xhr: FixtureServer
let spa: FixtureServer
let xhrTrace: Trace
let spaTrace: Trace

beforeAll(async () => {
  xhr = await startXhrFixture()
  spa = await startSpaFixture()

  const xhrTask: Task = { id: 'x', site: 'siteB', intent: 'search', input: { query: 'rust' } }
  xhrTrace = await record(
    { url: (o, t) => `${o}/search?q=${t.input.query}`, itemSelector: 'li.result', fields: { id: '@data-id' } },
    xhrTask, new StaticSiteResolver({ siteB: xhr.url }),
  )

  const spaTask: Task = { id: 's', site: 'siteC', intent: 'search', input: { query: 'rust' } }
  spaTrace = await record(
    { url: (o, t) => `${o}/search?q=${t.input.query}`, itemSelector: 'li.result', fields: { id: '@data-id' } },
    spaTask, new StaticSiteResolver({ siteC: spa.url }),
  )
}, 60_000)

afterAll(async () => { await xhr.close(); await spa.close() })

describe('scoreRequests', () => {
  it('ranks the real search endpoint above every decoy', () => {
    const ranked = scoreRequests(xhrTrace)
    expect(new URL(ranked[0]!.request.url).pathname).toBe('/api/search')
  })

  it('scores autocomplete below search even though both are JSON and both echo the input', () => {
    const ranked = scoreRequests(xhrTrace)
    const search = ranked.find((r) => new URL(r.request.url).pathname === '/api/search')!
    const auto = ranked.find((r) => new URL(r.request.url).pathname === '/api/autocomplete')!
    expect(search.score).toBeGreaterThan(auto.score)
  })

  it('gives no score to analytics and tracking', () => {
    const ranked = scoreRequests(xhrTrace)
    const paths = ranked.map((r) => new URL(r.request.url).pathname)
    expect(paths).not.toContain('/analytics/collect')
    expect(paths).not.toContain('/tracking/event')
  })

  it('explains itself through signals', () => {
    const top = scoreRequests(xhrTrace)[0]!
    expect(top.signals).toContain('json-response')
    expect(top.signals).toContain('contains-input')
    expect(top.signals).toContain('dom-changed')
  })

  it('finds the data request on a SPA too', () => {
    expect(new URL(pickDataRequest(spaTrace)!.request.url).pathname).toBe('/api/query')
  })

  it('returns null when a trace has no data candidates at all', () => {
    expect(pickDataRequest({ ...xhrTrace, requests: [] })).toBeNull()
  })
})
