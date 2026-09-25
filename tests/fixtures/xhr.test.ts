import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startXhrFixture } from '../../fixtures/xhr.js'
import type { FixtureServer } from '../../fixtures/harness.js'

let server: FixtureServer
beforeAll(async () => { server = await startXhrFixture() })
afterAll(async () => { await server.close() })

describe('xhr fixture', () => {
  it('serves a shell with no results in it', async () => {
    const html = await (await fetch(`${server.url}/search?q=rust`)).text()
    expect(html).toContain('id="app"')
    expect(html).not.toContain('Senior rust')
  })

  it('returns results from the data endpoint', async () => {
    const body = await (await fetch(`${server.url}/api/search?q=rust`)).json()
    expect(Array.isArray(body.results)).toBe(true)
    expect(body.results.length).toBeGreaterThan(0)
    expect(body.results[0]).toHaveProperty('title')
  })

  it('serves decoy endpoints that must not be mistaken for the data request', async () => {
    const flags = await (await fetch(`${server.url}/api/feature-flags`)).json()
    expect(flags).not.toHaveProperty('results')

    const auto = await (await fetch(`${server.url}/api/autocomplete?prefix=ru`)).json()
    expect(auto.suggestions.length).toBeGreaterThan(0)
    expect(auto).not.toHaveProperty('results')

    expect((await fetch(`${server.url}/analytics/collect`)).status).toBe(204)
  })

  it('moves the data endpoint to /api/v2/search in v2', async () => {
    server.setVersion('v2')
    expect((await fetch(`${server.url}/api/search?q=rust`)).status).toBe(404)
    const body = await (await fetch(`${server.url}/api/v2/search?q=rust`)).json()
    expect(body.results.length).toBeGreaterThan(0)
    server.setVersion('v1')
  })

  it('serves detail as JSON', async () => {
    const body = await (await fetch(`${server.url}/api/item?id=100`)).json()
    expect(body.result.id).toBe('100')
  })
})

describe('xhr fixture detail page', () => {
  it('serves a shell for /item/:id with the record only in the XHR', async () => {
    const html = await (await fetch(`${server.url}/item/100`)).text()
    expect(html).toContain('id="app"')
    expect(html).not.toContain('Senior')
  })
})

describe('xhr fixture pagination', () => {
  it('returns different records for different pages', async () => {
    const p1 = await (await fetch(`${server.url}/api/search?q=&page=1`)).json()
    const p2 = await (await fetch(`${server.url}/api/search?q=&page=2`)).json()
    expect(p1.results[0].id).not.toBe(p2.results[0].id)
  })
})
