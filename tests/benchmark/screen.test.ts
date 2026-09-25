import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startSsrFixture } from '../../fixtures/ssr.js'
import { startRefusingFixture, startStubFixture } from '../../fixtures/refusing.js'
import { screen, formatScreen, largestArray } from '../../src/benchmark/screen.js'
import type { FixtureServer } from '../../fixtures/harness.js'

let honest: FixtureServer
let refusing: FixtureServer
let stub: FixtureServer

beforeAll(async () => {
  honest = await startSsrFixture()
  refusing = await startRefusingFixture()
  stub = await startStubFixture()
})
afterAll(async () => {
  await Promise.all([honest.close(), refusing.close(), stub.close()])
})

describe('largestArray', () => {
  it('finds the longest array at any depth', () => {
    expect(largestArray({ meta: { tags: [1, 2] }, data: { rows: [1, 2, 3, 4] } })).toBe(4)
  })

  it('counts the outer array, not only the nested ones', () => {
    expect(largestArray([{ a: [1] }, { a: [1] }, { a: [1] }])).toBe(3)
  })

  it('reports nothing for a payload with no arrays', () => {
    expect(largestArray({ a: 1, b: 'two' })).toBe(0)
  })
})

describe('bench screen', () => {
  it('reports an honest site as serving both clients the same page', async () => {
    const report = await screen(`${honest.url}/search?q=rust`)

    expect(report.engine.status).toBe(200)
    expect(report.browser.status).toBe(200)
    expect(report.engine.title).toBe('Search')
    expect(report.browser.title).toBe('Search')
    expect(report.carriesBrowserTitle).toBe(true)
    expect(report.differences).toEqual([])
  }, 180_000)

  it('finds the listing in the rendered dom before any plan exists', async () => {
    const report = await screen(`${honest.url}/search?q=rust`)

    expect(report.largestListing).toEqual({ count: 8, signature: 'li.result' })
    // The fixture serves no JSON, so the two numbers disagreeing is what a
    // virtualised list would look like — here they agree that there is no XHR.
    expect(report.largestJsonArray).toBe(0)
  }, 180_000)

  it('catches the site that answers the engine with a 200 challenge page', async () => {
    const report = await screen(`${stub.url}/search?q=rust`)

    expect(report.engine.status).toBe(200)
    expect(report.engine.title).toBe('Verifying your browser')
    expect(report.browser.title).toBe('Search')
    expect(report.carriesBrowserTitle).toBe(false)
    // Both signals, named: the challenge page is a different title and a
    // fraction of the size, and the reader decides what that means.
    expect(report.differences).toEqual(['title mismatch', expect.stringMatching(/^engine body is \d+% of browser$/)])
  }, 180_000)

  it('catches the site that answers the engine with a 403', async () => {
    const report = await screen(`${refusing.url}/search?q=rust`)

    expect(report.engine.status).toBe(403)
    expect(report.browser.status).toBe(200)
    expect(report.differences).toContain('title mismatch')
  }, 180_000)

  it('prints the measured lines, naming the evidence rather than a verdict', async () => {
    const out = formatScreen(await screen(`${stub.url}/search?q=rust`))

    expect(out).toMatch(/engine page differs from browser page: title mismatch, engine body is \d+% of browser/)
    expect(out).toMatch(/render: \d+ms/)
    expect(out).toMatch(/largest listing: 8 × li\.result {3}largest json array: 0/)
  }, 180_000)
})
