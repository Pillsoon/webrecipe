import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startSpaFixture } from '../../fixtures/spa.js'
import type { FixtureServer } from '../../fixtures/harness.js'

let server: FixtureServer
beforeAll(async () => { server = await startSpaFixture() })
afterAll(async () => { await server.close() })

describe('spa fixture', () => {
  it('serves a near-empty shell for every route', async () => {
    for (const path of ['/', '/search?q=rust', '/item/100']) {
      const html = await (await fetch(`${server.url}${path}`)).text()
      expect(html).toContain('id="root"')
      expect(html.length).toBeLessThan(600)
      expect(html).not.toContain('Senior')
    }
  })

  it('returns results under results[].title in v1', async () => {
    const body = await (await fetch(`${server.url}/api/query?q=rust`)).json()
    expect(body.results[0]).toHaveProperty('title')
    expect(body.results[0]).not.toHaveProperty('name')
  })

  it('renames the schema to items[].name in v2 at the same endpoint', async () => {
    server.setVersion('v2')
    const body = await (await fetch(`${server.url}/api/query?q=rust`)).json()
    expect(body).not.toHaveProperty('results')
    expect(body.items[0]).toHaveProperty('name')
    server.setVersion('v1')
  })

  it('serves lazy detail separately', async () => {
    const body = await (await fetch(`${server.url}/api/detail?id=100`)).json()
    expect(body.result.body.length).toBeGreaterThan(0)
  })
})
