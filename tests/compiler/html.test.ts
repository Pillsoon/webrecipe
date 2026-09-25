import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startSsrFixture } from '../../fixtures/ssr.js'
import { startSpaFixture } from '../../fixtures/spa.js'
import type { FixtureServer } from '../../fixtures/harness.js'
import { StaticSiteResolver } from '../../src/sites.js'
import { record } from '../../src/recorder/index.js'
import { compileHtmlRecipe } from '../../src/compiler/html.js'
import { isRefused, type CompileResult } from '../../src/compiler/types.js'
import type { Recipe } from '../../src/recipes/schema.js'
import { PolitenessLayer } from '../../src/net/politeness.js'
import { HttpHtmlStrategy } from '../../src/executor/strategies/http-html.js'
import type { BrowserPlan } from '../../src/executor/strategies/browser.js'
import type { Task } from '../../src/types.js'
import { validate } from '../../src/validator/index.js'
import { readBody } from '../../src/recorder/body.js'
import type { Trace } from '../../src/recorder/types.js'

let ssr: FixtureServer
let spa: FixtureServer

const plan: BrowserPlan = {
  url: (o, t) => `${o}/search?q=${encodeURIComponent(String(t.input.query))}`,
  itemSelector: 'li.result',
  fields: { id: '@data-id', title: 'a.title', url: 'a.title@href' },
}
const task: Task = { id: 'h1', site: 'siteA', intent: 'search', input: { query: 'rust' } }

beforeAll(async () => { ssr = await startSsrFixture(); spa = await startSpaFixture() })
afterAll(async () => { await ssr.close(); await spa.close() })

/** The recipe, or a failure that names why the compiler refused. */
function compiled(result: CompileResult): Recipe {
  if (isRefused(result)) throw new Error(`compiler refused: ${result.refused}`)
  return result
}

describe('compileHtmlRecipe', () => {
  it('compiles an html recipe when the raw navigation response already contains the items', async () => {
    const trace = await record(plan, task, new StaticSiteResolver({ siteA: ssr.url }))
    const recipe = compiled(compileHtmlRecipe(trace, plan))
    expect(recipe.strategy.type).toBe('http-html')
    expect(recipe.request.path).toBe('/search')
    expect(recipe.request.query).toEqual({ q: '{{query}}' })
    expect(recipe.output).toMatchObject({ type: 'html', items: { selector: 'li.result' } })
  })

  it('refuses when the items only appear after JS has run', async () => {
    const spaTask: Task = { ...task, site: 'siteC' }
    const trace = await record(plan, spaTask, new StaticSiteResolver({ siteC: spa.url }))
    expect(compileHtmlRecipe(trace, plan)).toEqual({
      refused: 'items are not in the raw html; only the rendered dom has them',
    })
  })

  it('produces a recipe that runs without a browser', async () => {
    const trace = await record(plan, task, new StaticSiteResolver({ siteA: ssr.url }))
    const recipe = compiled(compileHtmlRecipe(trace, plan))
    const strategy = new HttpHtmlStrategy(
      new PolitenessLayer({ minIntervalMs: 0 }),
      new StaticSiteResolver({ siteA: ssr.url }),
    )
    const result = await strategy.execute(recipe, task)
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.meta.browserLaunches).toBe(0)
  })
})

describe('html recipe fingerprint', () => {
  it('validates against its own response, so the recipe survives repeated runs', async () => {
    const trace = await record(plan, task, new StaticSiteResolver({ siteA: ssr.url }))
    const recipe = compiled(compileHtmlRecipe(trace, plan))
    const strategy = new HttpHtmlStrategy(
      new PolitenessLayer({ minIntervalMs: 0 }),
      new StaticSiteResolver({ siteA: ssr.url }),
    )

    for (const query of ['rust', 'engineer', 'typescript']) {
      const result = await strategy.execute(recipe, { ...task, input: { query } })
      const outcome = validate(recipe, {
        status: result.status!, payload: result.payload, items: result.items,
      })
      expect(outcome.reasons).toEqual([])
    }
  }, 60_000)

  it('detects drift once the markup is renamed in v2', async () => {
    const trace = await record(plan, task, new StaticSiteResolver({ siteA: ssr.url }))
    const recipe = compiled(compileHtmlRecipe(trace, plan))
    const strategy = new HttpHtmlStrategy(
      new PolitenessLayer({ minIntervalMs: 0 }),
      new StaticSiteResolver({ siteA: ssr.url }),
    )

    ssr.setVersion('v2')
    const result = await strategy.execute(recipe, task)
    const outcome = validate(recipe, {
      status: result.status!, payload: result.payload, items: result.items,
    })
    ssr.setVersion('v1')

    expect(outcome.valid).toBe(false)
  }, 60_000)
})

describe('verification refuses vacuous agreement', () => {
  it('rejects when the browser plan finds items but extracts no values', async () => {
    const blindPlan: BrowserPlan = {
      ...plan,
      fields: { title: '.does-not-exist', url: '.does-not-exist@href' },
    }
    const trace = await record(blindPlan, task, new StaticSiteResolver({ siteA: ssr.url }))
    expect(compileHtmlRecipe(trace, blindPlan)).toEqual({
      refused: 'equivalence: recipe and browser both yield 8 items, but they differ',
    })
  }, 60_000)
})

describe('recipes replay the request that was made, not the redirect target', () => {
  it('templates the url the plan asked for', async () => {
    const trace = await record(plan, task, new StaticSiteResolver({ siteA: ssr.url }))
    // Pretend the server bounced the request somewhere value-specific.
    const redirected = {
      ...trace,
      requests: trace.requests.map((r) =>
        r.resourceType === 'document'
          ? { ...r, url: `${ssr.url}/normalised/rust-results` }
          : r),
    }
    const recipe = compiled(compileHtmlRecipe(redirected, plan))
    expect(recipe.request.path).toBe('/search')
    expect(recipe.request.query).toEqual({ q: '{{query}}' })
  }, 60_000)
})

describe('compiling from an XHR that returns HTML', () => {
  it('uses an html data request when the navigation does not carry the items', async () => {
    const trace = await record(plan, task, new StaticSiteResolver({ siteA: ssr.url }))
    const navUrl = trace.requests.find((r) => r.resourceType === 'document')!.url
    const navBody = readBody(trace.requests.find((r) => r.resourceType === 'document')!)!

    // The navigation carries nothing; a separate XHR returns the rows as a
    // bare table fragment, the way remoteok.com answers a search.
    const rows = navBody.slice(navBody.indexOf('<ul id="results">'), navBody.indexOf('</ul>') + 5)
    const spliced: Trace = {
      ...trace,
      requests: [
        { ...trace.requests[0]!, body: '<html><body><div id="app"></div></body></html>', bodyPath: null, resourceType: 'document' },
        {
          ...trace.requests[0]!,
          url: `${ssr.url}/fragment?q=rust`,
          resourceType: 'xhr',
          contentType: 'text/html; charset=utf-8',
          body: rows,
          bodyPath: null,
          bodySize: rows.length,
          domChanged: true,
        },
      ],
    }

    const recipe = compiled(compileHtmlRecipe(spliced, plan))
    expect(recipe.request.path).toBe('/fragment')
    expect(recipe.request.query).toEqual({ q: '{{query}}' })
  }, 60_000)

  it('still prefers the navigation when it carries the items', async () => {
    const trace = await record(plan, task, new StaticSiteResolver({ siteA: ssr.url }))
    expect(compiled(compileHtmlRecipe(trace, plan)).request.path).toBe('/search')
  }, 60_000)
})
