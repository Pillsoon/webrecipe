import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startSpaFixture } from '../../fixtures/spa.js'
import type { FixtureServer } from '../../fixtures/harness.js'
import { StaticSiteResolver } from '../../src/sites.js'
import { WarmBrowserStrategy } from '../../src/executor/strategies/warm-browser.js'
import type { BrowserPlan } from '../../src/executor/strategies/browser.js'
import type { Recipe } from '../../src/recipes/schema.js'
import type { Task } from '../../src/types.js'

let server: FixtureServer
let strategy: WarmBrowserStrategy

const plan: BrowserPlan = {
  url: (origin, task) => `${origin}/search?q=${encodeURIComponent(String(task.input.query))}`,
  itemSelector: 'li.result',
  fields: { id: '@data-id', title: '' },
}

const recipe = {} as Recipe
const task = (query: string): Task => ({ id: query, site: 'siteC', intent: 'search', input: { query } })

beforeAll(async () => {
  server = await startSpaFixture()
  strategy = new WarmBrowserStrategy(new StaticSiteResolver({ siteC: server.url }), { siteC: { search: plan } })
})
afterAll(async () => { await strategy.close(); await server.close() })

describe('WarmBrowserStrategy', () => {
  it('returns the same items a cold browser would', async () => {
    const result = await strategy.execute(recipe, task('rust'))
    expect(result.items.length).toBeGreaterThan(0)
    expect(String(result.items[0]!.title)).toContain('rust')
  }, 60_000)

  it('reports the launch on the call that starts the browser, and none after', async () => {
    // Its own pool, because the shared one above is already warm by the time
    // this runs — which is exactly how the old assertion that a warm strategy
    // "never reports a launch" stayed green while being false.
    const fresh = new WarmBrowserStrategy(
      new StaticSiteResolver({ siteC: server.url }), { siteC: { search: plan } },
    )
    try {
      const first = await fresh.execute(recipe, task('engineer'))
      const second = await fresh.execute(recipe, task('typescript'))
      expect(first.meta.browserLaunches).toBe(1)
      expect(second.meta.browserLaunches).toBe(0)
      expect(first.meta.strategy).toBe('warm-browser')
    } finally {
      await fresh.close()
    }
  }, 90_000)

  it('reports no launch once the pool is warm, however many tasks it runs', async () => {
    // The speed claim belongs to the benchmark: comparing wall clock against a
    // cold browser inside a parallel test run measures machine load, not the pool.
    const launches = []
    for (const q of ['designer', 'analyst', 'manager']) {
      launches.push((await strategy.execute(recipe, task(q))).meta.browserLaunches)
    }
    expect(launches).toEqual([0, 0, 0])
  }, 90_000)

  it('still counts navigations and requests, because the page work is real', async () => {
    const result = await strategy.execute(recipe, task('rust'))
    expect(result.meta.pageNavigations).toBeGreaterThanOrEqual(1)
    expect(result.meta.networkRequests).toBeGreaterThan(1)
  }, 60_000)

  it('does not carry state between tasks', async () => {
    await strategy.execute(recipe, task('rust'))
    const other = await strategy.execute(recipe, task('elixir'))
    expect(other.items.every((i) => String(i.title).includes('elixir'))).toBe(true)
  }, 60_000)
})
