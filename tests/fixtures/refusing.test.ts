import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startRefusingFixture, startStubFixture } from '../../fixtures/refusing.js'
import { PolitenessLayer } from '../../src/net/politeness.js'
import type { FixtureServer } from '../../fixtures/harness.js'

let server: FixtureServer

beforeAll(async () => { server = await startRefusingFixture() })
afterAll(async () => { await server.close() })

/** The client hints a real browser sends and the engine's fetch client does not. */
const BROWSER_HINTS = { 'sec-ch-ua': '"HeadlessChrome";v="153"', 'sec-fetch-mode': 'navigate' }

const search = (headers: Record<string, string> = {}) =>
  new PolitenessLayer({ minIntervalMs: 0 }).fetch(`${server.url}/search?q=rust`, { headers })

describe('refusing fixture', () => {
  it('refuses the engine client, which is loc.gov shape', async () => {
    const res = await search()
    expect(res.status).toBe(403)
    expect(res.body).toContain('Forbidden')
  })

  it('serves the real page to a browser, so the fallback stays healthy', async () => {
    const res = await search(BROWSER_HINTS)
    expect(res.status).toBe(200)
    expect(res.body).toContain('class="result"')
    expect(res.body).toContain('rust')
  })

  it('answers both with a 200 challenge page at v2, which is bandcamp shape', async () => {
    server.setVersion('v2')
    try {
      for (const headers of [{}, BROWSER_HINTS]) {
        const res = await search(headers)
        expect(res.status).toBe(200)
        expect(res.body).toContain('<title>Client Challenge</title>')
        expect(res.body).not.toContain('class="result"')
        expect(res.bytesDownloaded).toBeGreaterThan(3 * 1024)
      }
    } finally {
      server.setVersion('v1')
    }
  })
})

describe('stub fixture', () => {
  let stub: FixtureServer

  beforeAll(async () => { stub = await startStubFixture() })
  afterAll(async () => { await stub.close() })

  const get = (headers: Record<string, string> = {}) =>
    new PolitenessLayer({ minIntervalMs: 0 }).fetch(`${stub.url}/search?q=rust`, { headers })

  it('answers the engine client with a 200 challenge page, which is musicbrainz shape', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.body).toContain('<title>Verifying your browser</title>')
    expect(res.body).not.toContain('class="result"')
  })

  it('serves the real page to a browser, so a re-record finds the recipe unchanged', async () => {
    const res = await get(BROWSER_HINTS)
    expect(res.status).toBe(200)
    expect(res.body).toContain('class="result"')
    expect(res.body).toContain('rust')
  })
})
