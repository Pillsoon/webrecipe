import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startXhrFixture } from '../../fixtures/xhr.js'
import type { FixtureServer } from '../../fixtures/harness.js'
import { StaticSiteResolver } from '../../src/sites.js'
import { RecipeRegistry } from '../../src/recipes/registry.js'
import { SelfHealer, diffRecipes } from '../../src/healing/index.js'
import { record } from '../../src/recorder/index.js'
import { HeuristicCompiler } from '../../src/compiler/heuristic.js'
import { isRefused, type CompileResult } from '../../src/compiler/types.js'
import type { Recipe } from '../../src/recipes/schema.js'
import type { BrowserPlan } from '../../src/executor/strategies/browser.js'
import type { Task } from '../../src/types.js'

let server: FixtureServer
let registry: RecipeRegistry
let dir: string

const plan: BrowserPlan = {
  url: (o, t) => `${o}/search?q=${encodeURIComponent(String(t.input.query))}`,
  itemSelector: 'li.result',
  fields: { id: '@data-id', title: '' },
}
const task: Task = { id: 'h1', site: 'siteB', intent: 'search', input: { query: 'rust' } }

beforeEach(async () => {
  server = await startXhrFixture()
  dir = await mkdtemp(join(tmpdir(), 'fwa-h-'))
  registry = new RecipeRegistry(dir)
})
afterEach(async () => { await server.close(); await rm(dir, { recursive: true, force: true }) })

/** The recipe, or a failure that names why the compiler refused. */
function compiled(result: CompileResult): Recipe {
  if (isRefused(result)) throw new Error(`compiler refused: ${result.refused}`)
  return result
}

describe('diffRecipes', () => {
  it('reports nothing for an identical recipe', async () => {
    const trace = await record(plan, task, new StaticSiteResolver({ siteB: server.url }))
    const recipe = compiled(await new HeuristicCompiler().compile(trace))
    expect(diffRecipes(recipe, recipe)).toEqual([])
  })

  it('names the endpoint move', async () => {
    const trace = await record(plan, task, new StaticSiteResolver({ siteB: server.url }))
    const before = compiled(await new HeuristicCompiler().compile(trace))
    const after = { ...before, request: { ...before.request, path: '/api/v2/search' } }
    expect(diffRecipes(before, after).join()).toMatch(/\/api\/search.*\/api\/v2\/search/)
  })

  it('treats a first-ever recipe as a creation', async () => {
    const trace = await record(plan, task, new StaticSiteResolver({ siteB: server.url }))
    const recipe = compiled(await new HeuristicCompiler().compile(trace))
    expect(diffRecipes(null, recipe).join()).toMatch(/new recipe/i)
  })
})

describe('SelfHealer', () => {
  it('learns a recipe the first time a task falls back with none', async () => {
    const healer = new SelfHealer({
      registry, sites: new StaticSiteResolver({ siteB: server.url }), plans: { siteB: { search: plan } },
    })
    const out = await healer.heal({ task, recipe: null, reasons: ['no recipe registered'] })
    // The visit healing makes is a real browser visit. Reported as nothing, the
    // one run that pays for learning looks as cheap as the ones that reuse it.
    expect(out.meta).not.toBeNull()
    expect(out.meta!.browserLaunches).toBe(1)
    expect(out.meta!.networkRequests).toBeGreaterThan(0)
    expect(out.meta!.bytesDownloaded).toBeGreaterThan(0)
    expect(out.healed).toBe(true)
    expect(out.recipe!.request.path).toBe('/api/search')
    expect((await registry.load('siteB', 'search'))!.request.path).toBe('/api/search')
  }, 60_000)

  it('rewrites the recipe after the endpoint moves in v2', async () => {
    const sites = new StaticSiteResolver({ siteB: server.url })
    const healer = new SelfHealer({ registry, sites, plans: { siteB: { search: plan } } })

    await healer.heal({ task, recipe: null, reasons: ['bootstrap'] })
    const before = (await registry.load('siteB', 'search'))!
    expect(before.request.path).toBe('/api/search')

    server.setVersion('v2')
    const out = await healer.heal({ task, recipe: before, reasons: ['404'] })

    expect(out.healed).toBe(true)
    expect((await registry.load('siteB', 'search'))!.request.path).toBe('/api/v2/search')
    expect(out.changes.join()).toMatch(/v2/)
  }, 60_000)

  it('archives the superseded recipe rather than discarding it', async () => {
    const sites = new StaticSiteResolver({ siteB: server.url })
    const healer = new SelfHealer({ registry, sites, plans: { siteB: { search: plan } } })
    await healer.heal({ task, recipe: null, reasons: ['bootstrap'] })
    server.setVersion('v2')
    await healer.heal({ task, recipe: await registry.load('siteB', 'search'), reasons: ['404'] })
    expect(await registry.versions('siteB', 'search')).toHaveLength(1)
  }, 60_000)

  it('reports failure without writing anything when there is no browser plan', async () => {
    const healer = new SelfHealer({ registry, sites: new StaticSiteResolver({ siteB: server.url }), plans: {} })
    const out = await healer.heal({ task, recipe: null, reasons: ['x'] })
    expect(out.healed).toBe(false)
    expect(await registry.load('siteB', 'search')).toBeNull()
  })
})

describe('SelfHealer gives up on a pair it cannot compile', () => {
  it('does not re-record a pair whose trace never compiles', async () => {
    let recordings = 0
    const countingPlan: BrowserPlan = {
      ...plan,
      url: (o, t) => { recordings += 1; return plan.url(o, t) },
    }
    const healer = new SelfHealer({
      registry,
      sites: new StaticSiteResolver({ siteB: server.url }),
      plans: { siteB: { search: countingPlan } },
      // An impossible field contract: the payload can never satisfy it.
      compiler: new HeuristicCompiler(['id', 'title', 'nonexistent']),
    })

    const first = await healer.heal({ task, recipe: null, reasons: ['x'] })
    const second = await healer.heal({ task, recipe: null, reasons: ['x'] })

    expect(first.healed).toBe(false)
    expect(second.healed).toBe(false)
    expect(recordings).toBe(1)

    // Both compilers' reasons, so the json one is not lost behind the html
    // one, which reports little more than that the page is rendered.
    expect(first.refused).toBe(
      'json: inferred 2 of 3 expected fields; '
      + 'html: items are not in the raw html; only the rendered dom has them',
    )
    // The pair was given up on, not un-refused: the second call re-records
    // nothing and still answers why.
    expect(second.refused).toBe(first.refused)
  }, 60_000)
})
