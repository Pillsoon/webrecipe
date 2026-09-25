import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startSsrFixture } from '../../fixtures/ssr.js'
import type { FixtureServer } from '../../fixtures/harness.js'

let server: FixtureServer

beforeAll(async () => { server = await startSsrFixture() })
afterAll(async () => { await server.close() })

describe('ssr fixture', () => {
  it('renders search results into the HTML itself', async () => {
    const html = await (await fetch(`${server.url}/search?q=rust`)).text()
    expect(html).toContain('class="result"')
    expect(html).toContain('rust')
  })

  it('serves a detail page', async () => {
    const html = await (await fetch(`${server.url}/item/100`)).text()
    expect(html).toContain('id="detail"')
    expect(html).toContain('100')
  })

  it('paginates', async () => {
    const p1 = await (await fetch(`${server.url}/search?q=&page=1`)).text()
    const p2 = await (await fetch(`${server.url}/search?q=&page=2`)).text()
    expect(p1).not.toEqual(p2)
  })

  it('renames its result markup in v2, which is what breaks a v1 recipe', async () => {
    server.setVersion('v2')
    const html = await (await fetch(`${server.url}/search?q=rust`)).text()
    expect(html).not.toContain('class="result"')
    expect(html).toContain('class="hit"')
    server.setVersion('v1')
  })

  it('404s an unknown id', async () => {
    expect((await fetch(`${server.url}/item/999999`)).status).toBe(404)
  })
})
