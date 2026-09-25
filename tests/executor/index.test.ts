import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Executor, BLOCK_COOLDOWN_MS } from '../../src/executor/index.js'
import { buildEngine } from '../../src/wiring.js'
import { startRefusingFixture } from '../../fixtures/refusing.js'
import { PLANS } from '../../benchmark/plans.js'
import { HttpHtmlStrategy } from '../../src/executor/strategies/http-html.js'
import { HttpJsonStrategy } from '../../src/executor/strategies/http-json.js'
import { PolitenessLayer } from '../../src/net/politeness.js'
import { StaticSiteResolver } from '../../src/sites.js'
import { RecipeRegistry } from '../../src/recipes/registry.js'
import { computeFingerprint } from '../../src/recipes/fingerprint.js'
import { jsonSignature } from '../../src/executor/extract.js'
import { emptyMeta, type Result, type Strategy, type Task } from '../../src/types.js'
import type { Recipe } from '../../src/recipes/schema.js'

const payload = { results: [{ id: '1', title: 'a' }] }
const jsonOutput = { type: 'json' as const, items: { path: '$.results', fields: { id: '$.id', title: '$.title' } } }

const recipe: Recipe = {
  site: 'siteB', intent: 'search',
  inputs: { query: { type: 'string' } },
  strategy: { type: 'http-json' },
  request: { method: 'GET', path: '/api/search', query: { q: '{{query}}' } },
  output: jsonOutput,
  validation: { status: 200, required: ['id', 'title'], minItems: 1 },
  fingerprint: {
    endpoint: '/api/search',
    hash: computeFingerprint('/api/search', payload),
    responseFields: ['results', 'results[]', 'results[].id', 'results[].title'],
  },
  fallback: { type: 'browser' },
}

const task: Task = { id: 't1', site: 'siteB', intent: 'search', input: { query: 'a' } }

function stub(name: Strategy['name'], impl: () => Promise<Result>): Strategy {
  return { name, execute: impl }
}

const goodJson = () => stub('http-json', async () => ({
  items: [{ id: '1', title: 'a' }], meta: emptyMeta('http-json'), payload, status: 200,
}))

const goodBrowser = () => stub('browser', async () => ({
  items: [{ id: '1', title: 'a' }], meta: { ...emptyMeta('browser'), browserLaunches: 1 },
}))

let registry: RecipeRegistry

beforeEach(async () => { registry = new RecipeRegistry(await mkdtemp(join(tmpdir(), 'fwa-x-'))) })

describe('Executor', () => {
  it('counts the recipe attempt that failed in what the task cost', async () => {
    // The HTTP try spends a request and a rate-limit wait before it is judged
    // invalid; the browser then answers. A report that shows only the browser's
    // cost describes a cheaper run than the one that happened.
    const spent = stub('http-json', async () => ({
      items: [],
      meta: { ...emptyMeta('http-json'), networkRequests: 1, bytesDownloaded: 900, latencyMs: 40, politenessWaitMs: 500 },
      payload: {}, status: 200,
    }))
    const browser = stub('browser', async () => ({
      items: [{ id: '1', title: 'a' }],
      meta: { ...emptyMeta('browser'), browserLaunches: 1, networkRequests: 12, bytesDownloaded: 50_000, latencyMs: 2_000, llmTokens: 700 },
    }))
    await registry.save(recipe)

    const out = await new Executor({ registry, strategies: [spent, browser] }).run(task)

    expect(out.fellBack).toBe(true)
    expect(out.meta.strategy).toBe('browser')
    expect(out.meta.llmTokens).toBe(700)
    expect(out.meta.networkRequests).toBe(13)
    expect(out.meta.bytesDownloaded).toBe(50_900)
    expect(out.meta.latencyMs).toBe(2_040)
    expect(out.meta.politenessWaitMs).toBe(500)
  })

  it('counts the re-record the fallback triggered', async () => {
    // Healing visits the site with a browser a second time. Left out of the
    // total, the one run that pays for learning looks like the cheap ones.
    const browser = stub('browser', async () => ({
      items: [{ id: '1', title: 'a' }],
      meta: { ...emptyMeta('browser'), browserLaunches: 1, networkRequests: 12, bytesDownloaded: 50_000, latencyMs: 2_000 },
    }))

    const out = await new Executor({
      registry,
      strategies: [browser],
      onFallback: async () => ({
        unchanged: false,
        meta: { ...emptyMeta('browser'), browserLaunches: 1, networkRequests: 9, bytesDownloaded: 30_000, latencyMs: 1_500 },
      }),
    }).run(task)

    expect(out.meta.browserLaunches).toBe(2)
    expect(out.meta.networkRequests).toBe(21)
    expect(out.meta.bytesDownloaded).toBe(80_000)
    expect(out.meta.latencyMs).toBe(3_500)
  })

  it('uses the recipe and never touches the browser when the recipe is healthy', async () => {
    await registry.save(recipe)
    const out = await new Executor({ registry, strategies: [goodJson(), goodBrowser()] }).run(task)
    expect(out.recipeUsed).toBe(true)
    expect(out.fellBack).toBe(false)
    expect(out.meta.browserLaunches).toBe(0)
  })

  it('goes straight to the browser when no recipe exists', async () => {
    const out = await new Executor({ registry, strategies: [goodJson(), goodBrowser()] }).run(task)
    expect(out.recipeUsed).toBe(false)
    expect(out.fellBack).toBe(true)
    expect(out.meta.browserLaunches).toBe(1)
  })

  it('falls back when the recipe strategy throws', async () => {
    await registry.save(recipe)
    const throwing = stub('http-json', async () => { throw new Error('404') })
    const out = await new Executor({ registry, strategies: [throwing, goodBrowser()] }).run(task)
    expect(out.fellBack).toBe(true)
    expect(out.meta.strategy).toBe('browser')
    expect(out.reasons.join()).toMatch(/404/)
  })

  it('falls back when the recipe succeeds but validation rejects the result', async () => {
    await registry.save(recipe)
    const drifted = stub('http-json', async () => ({
      items: [{ id: '1', title: 'a' }],
      meta: emptyMeta('http-json'),
      payload: { items: [{ id: '1', name: 'a' }] },
      status: 200,
    }))
    const out = await new Executor({ registry, strategies: [drifted, goodBrowser()] }).run(task)
    expect(out.fellBack).toBe(true)
    expect(out.reasons.join()).toMatch(/fingerprint/i)
  })

  it('notifies onFallback with the reasons, so the fallback can become training data', async () => {
    await registry.save(recipe)
    const events: string[][] = []
    const throwing = stub('http-json', async () => { throw new Error('boom') })
    await new Executor({
      registry,
      strategies: [throwing, goodBrowser()],
      onFallback: async (e) => { events.push(e.reasons) },
    }).run(task)
    expect(events).toHaveLength(1)
    expect(events[0]!.join()).toMatch(/boom/)
  })

  it('reports why the compiler refused on every run, including the first', async () => {
    const refused = 'json: items path not found; html: items are not in the raw html'
    const executor = new Executor({
      registry,
      strategies: [goodJson(), goodBrowser()],
      onFallback: async () => ({ unchanged: false, refused }),
    })

    // A benchmark task runs once, so a reason held back for next time is a
    // reason no report ever carries.
    for (const id of ['t1', 't2', 't3']) {
      const out = await executor.run({ ...task, id })
      expect(out.reasons).toEqual([`no recipe: ${refused}`])
    }
  })

  it('says only that no recipe is registered when the healer reports no refusal', async () => {
    const executor = new Executor({
      registry,
      strategies: [goodJson(), goodBrowser()],
      onFallback: async () => ({ unchanged: false }),
    })
    expect((await executor.run(task)).reasons).toEqual(['no recipe registered'])
  })

  it('appends the refusal when a stale recipe could not be relearned', async () => {
    await registry.save(recipe)
    const throwing = stub('http-json', async () => { throw new Error('boom') })
    const out = await new Executor({
      registry,
      strategies: [throwing, goodBrowser()],
      onFallback: async () => ({ unchanged: false, refused: 'json: items path not found' }),
    }).run(task)

    // There was a recipe, so there is no bare line to replace.
    expect(out.reasons).toEqual(['boom', 'no recipe: json: items path not found'])
  })

  it('propagates the error when the browser fallback also fails', async () => {
    const brokenBrowser = stub('browser', async () => { throw new Error('browser died') })
    await expect(
      new Executor({ registry, strategies: [goodJson(), brokenBrowser] }).run(task),
    ).rejects.toThrow(/browser died/)
  })
})

describe('Executor fallback ladder', () => {
  const warmOnly = () => stub('warm-browser', async () => ({
    items: [{ id: '1', title: 'a' }], meta: { ...emptyMeta('warm-browser') },
  }))

  it('falls back to the warm browser rather than paying for a cold one', async () => {
    const out = await new Executor({ registry, strategies: [warmOnly(), goodBrowser()] }).run(task)
    expect(out.meta.strategy).toBe('warm-browser')
    expect(out.meta.browserLaunches).toBe(0)
  })

  it('drops to the cold browser when the warm one fails', async () => {
    const brokenWarm = stub('warm-browser', async () => { throw new Error('pool died') })
    const out = await new Executor({ registry, strategies: [brokenWarm, goodBrowser()] }).run(task)
    expect(out.meta.strategy).toBe('browser')
    expect(out.reasons.join()).toMatch(/pool died/)
  })

  it('uses the cold browser when no warm strategy is registered', async () => {
    const out = await new Executor({ registry, strategies: [goodJson(), goodBrowser()] }).run(task)
    expect(out.meta.strategy).toBe('browser')
  })
})

describe('Executor block detection', () => {
  // The real HTTP strategies against a stub fetch, because the bug these tests
  // exist for was invisible to fakes: a fake returns a status the strategy of
  // the day would have thrown away.
  const ORIGIN = 'http://127.0.0.1:9'

  function answering(status: number, body: string, contentType: string): typeof fetch {
    return (async () => new Response(body, { status, headers: { 'content-type': contentType } })) as typeof fetch
  }

  function http(kind: 'http-html' | 'http-json', fetchImpl: typeof fetch): Strategy {
    const net = new PolitenessLayer({ minIntervalMs: 0, fetchImpl })
    const sites = new StaticSiteResolver({ siteB: ORIGIN, siteC: ORIGIN })
    return kind === 'http-html' ? new HttpHtmlStrategy(net, sites) : new HttpJsonStrategy(net, sites)
  }

  const htmlRecipe: Recipe = {
    ...recipe,
    strategy: { type: 'http-html' },
    request: { method: 'GET', path: '/search', query: { q: '{{query}}' } },
    output: { type: 'html', items: { selector: 'li.result', fields: { id: '@data-id', title: 'a.title' } } },
    fingerprint: { endpoint: '/search', hash: 'v1', responseFields: [] },
  }

  /** bandcamp's shape: the API's URL answers 200 with an interstitial page. */
  const CHALLENGE = '<html><head><title>Client Challenge</title></head><body>checking</body></html>'

  const emptyBrowser = () => stub('browser', async () => ({
    items: [], meta: { ...emptyMeta('browser'), browserLaunches: 1 },
  }))

  it('reads a refusing status off the real strategy and does not send the recipe for healing', async () => {
    await registry.save(htmlRecipe)
    let healed = 0
    const executor = new Executor({
      registry,
      strategies: [http('http-html', answering(403, '<html><body>Forbidden</body></html>', 'text/html')), emptyBrowser()],
      onFallback: async () => { healed += 1 },
    })

    const out = await executor.run(task)
    expect(out.blocked).toBe(true)
    expect(out.fellBack).toBe(true)
    expect(out.reasons).toContain('blocked: status 403')
    expect(healed).toBe(0)

    // The cooldown was recorded, not merely reported.
    const next = await executor.run(task)
    expect(next.reasons).toContain('blocked: cooling down for siteB')
  })

  // The hash a compiled recipe carries is taken over the json signature, not
  // over the raw payload, as src/compiler/heuristic.ts records it.
  const signedRecipe: Recipe = {
    ...recipe,
    fingerprint: {
      ...recipe.fingerprint,
      hash: computeFingerprint('/api/search', jsonSignature({ output: jsonOutput }, payload)),
    },
  }

  it('reads an empty result off the real strategy as empty, not as a block', async () => {
    await registry.save(signedRecipe)
    let healed = 0
    const executor = new Executor({
      registry,
      strategies: [http('http-json', answering(200, '{"results":[]}', 'application/json')), emptyBrowser()],
      onFallback: async () => { healed += 1 },
    })

    const out = await executor.run(task)
    expect(out.blocked).toBe(false)
    expect(healed).toBe(1)

    // No cooldown was recorded: the next run reaches the recipe again.
    const next = await executor.run(task)
    expect(next.reasons).not.toContain('blocked: cooling down for siteB')
  })

  it('reads a 200 whose shape is not the recorded endpoint as a block', async () => {
    await registry.save(signedRecipe)
    let healed = 0
    const out = await new Executor({
      registry,
      strategies: [http('http-json', answering(200, '{"data":[]}', 'application/json')), emptyBrowser()],
      onFallback: async () => { healed += 1 },
    }).run(task)

    expect(out.blocked).toBe(true)
    expect(out.reasons).toContain('blocked: 200 with no items, browser also empty')
    expect(healed).toBe(0)
  })

  it('reads a 200 challenge page off the real strategy, beside an empty browser, as a block', async () => {
    await registry.save(signedRecipe)
    let healed = 0
    const out = await new Executor({
      registry,
      strategies: [http('http-json', answering(200, CHALLENGE, 'text/html')), emptyBrowser()],
      onFallback: async () => { healed += 1 },
    }).run(task)

    expect(out.blocked).toBe(true)
    expect(out.reasons).toContain('blocked: 200 with no items, browser also empty')
    expect(healed).toBe(0)
  })

  // The conjunct: the same 200 with nothing in it is a rotted recipe, not a
  // refusal, when the browser standing beside it can still read the page.
  it('heals the same empty 200 when the browser does return items', async () => {
    await registry.save(signedRecipe)
    let healed = 0
    const out = await new Executor({
      registry,
      strategies: [http('http-json', answering(200, CHALLENGE, 'text/html')), goodBrowser()],
      onFallback: async () => { healed += 1 },
    }).run(task)

    expect(out.blocked).toBe(false)
    expect(healed).toBe(1)
  })

  const fake = (status: number) => stub('http-json', async () => ({
    items: [], meta: emptyMeta('http-json'), payload, status,
  }))

  it.each([404, 500])('treats %i with an empty browser as a nonexistent value, not a block', async (status) => {
    await registry.save(recipe)
    let healed = 0
    const out = await new Executor({
      registry,
      strategies: [fake(status), emptyBrowser()],
      onFallback: async () => { healed += 1 },
    }).run(task)

    expect(out.blocked).toBe(false)
    expect(healed).toBe(1)
  })

  it('still heals a drifted recipe, because the browser could read the page', async () => {
    await registry.save(recipe)
    let healed = 0
    const drifted = stub('http-json', async () => ({
      items: [{ id: '1', title: 'a' }],
      meta: emptyMeta('http-json'),
      payload: { items: [{ id: '1', name: 'a' }] },
      status: 200,
    }))
    const out = await new Executor({
      registry,
      strategies: [drifted, goodBrowser()],
      onFallback: async () => { healed += 1 },
    }).run(task)

    expect(out.blocked).toBe(false)
    expect(healed).toBe(1)
  })

  it('holds the recipe back for exactly the cooldown, then tries it again', async () => {
    await registry.save(htmlRecipe)
    let attempts = 0
    let clock = 1_000
    const counting: typeof fetch = (async () => {
      attempts += 1
      return new Response('<html><body>Forbidden</body></html>', {
        status: 403, headers: { 'content-type': 'text/html' },
      })
    }) as typeof fetch

    const executor = new Executor({
      registry,
      strategies: [http('http-html', counting), emptyBrowser()],
      now: () => clock,
    })

    await executor.run(task)
    expect(attempts).toBe(1)

    clock += BLOCK_COOLDOWN_MS - 1
    const cooling = await executor.run(task)
    expect(attempts).toBe(1)
    expect(cooling.blocked).toBe(true)
    expect(cooling.reasons).toContain('blocked: cooling down for siteB')

    clock += 1
    await executor.run(task)
    expect(attempts).toBe(2)
  })

  it('keeps the cooldown a refusing site earned even when the browser then throws', async () => {
    await registry.save(htmlRecipe)
    let attempts = 0
    const counting: typeof fetch = (async () => {
      attempts += 1
      return new Response('<html><body>Forbidden</body></html>', {
        status: 403, headers: { 'content-type': 'text/html' },
      })
    }) as typeof fetch
    // Dies on the run that discovers the refusal, recovers afterwards, so the
    // second run can report what the first one recorded before it threw.
    let browserCalls = 0
    const flakyBrowser = stub('browser', async () => {
      browserCalls += 1
      if (browserCalls === 1) throw new Error('browser died')
      return { items: [{ id: '1', title: 'a' }], meta: { ...emptyMeta('browser'), browserLaunches: 1 } }
    })

    const executor = new Executor({ registry, strategies: [http('http-html', counting), flakyBrowser] })

    await expect(executor.run(task)).rejects.toThrow(/browser died/)
    expect(attempts).toBe(1)

    // The throw lost the outcome, but not the fact that the site refused us.
    const next = await executor.run({ ...task, id: 't2' })
    expect(next.reasons).toContain('blocked: cooling down for siteB')
    expect(attempts).toBe(1)
  })

  /**
   * musicbrainz's shape, and the one rule (b) cannot reach: a 200 challenge
   * page beside a browser that reads the page perfectly well.
   */
  const VERIFYING =
    '<html><head><title>Verifying your browser</title></head><body>Verifying your browser</body></html>'

  const SAME_RECIPE =
    'blocked: re-record produced the same recipe — the site serves the engine a different page'

  function verifying(): { fetchImpl: typeof fetch; attempts: () => number } {
    let attempts = 0
    const fetchImpl: typeof fetch = (async () => {
      attempts += 1
      return new Response(VERIFYING, { status: 200, headers: { 'content-type': 'text/html' } })
    }) as typeof fetch
    return { fetchImpl, attempts: () => attempts }
  }

  it('blocks the site when the re-record produced the very same recipe', async () => {
    await registry.save(htmlRecipe)
    const { fetchImpl, attempts } = verifying()
    let healed = 0
    const executor = new Executor({
      registry,
      strategies: [http('http-html', fetchImpl), goodBrowser()],
      onFallback: async () => { healed += 1; return { unchanged: true } },
    })

    const out = await executor.run(task)
    expect(out.blocked).toBe(true)
    expect(out.reasons).toContain(SAME_RECIPE)
    // The one re-record is the measurement that proved the page had not rotted.
    expect(healed).toBe(1)
    expect(attempts()).toBe(1)

    // The cooldown was recorded: the next task never reaches the recipe.
    const next = await executor.run({ ...task, id: 't2' })
    expect(next.reasons).toContain('blocked: cooling down for siteB')
    expect(attempts()).toBe(1)
    expect(healed).toBe(1)
  })

  it('heals as before when the re-record produced a different recipe', async () => {
    await registry.save(htmlRecipe)
    const { fetchImpl, attempts } = verifying()
    let healed = 0
    const executor = new Executor({
      registry,
      strategies: [http('http-html', fetchImpl), goodBrowser()],
      onFallback: async () => { healed += 1; return { unchanged: false } },
    })

    const out = await executor.run(task)
    expect(out.blocked).toBe(false)
    expect(out.reasons).not.toContain(SAME_RECIPE)
    expect(healed).toBe(1)

    // No cooldown was recorded: the next task tries the recipe and heals again.
    const next = await executor.run({ ...task, id: 't2' })
    expect(next.reasons).not.toContain('blocked: cooling down for siteB')
    expect(attempts()).toBe(2)
    expect(healed).toBe(2)
  })

  it('cools down one site without silencing the recipe of another', async () => {
    await registry.save({ ...htmlRecipe, request: { ...htmlRecipe.request, path: '/refused' } })
    await registry.save({ ...htmlRecipe, site: 'siteC' })
    let healed = 0
    const otherTask: Task = { ...task, id: 't2', site: 'siteC' }

    // One stub, two answers: siteB's endpoint is refused, siteC's is served.
    const bySite: typeof fetch = (async (url: string | URL) => String(url).includes('/refused')
      ? new Response('<html><body>Forbidden</body></html>', { status: 403, headers: { 'content-type': 'text/html' } })
      : new Response('<ul><li class="result" data-id="1"><a class="title">a</a></li></ul>', {
          status: 200, headers: { 'content-type': 'text/html' },
        })) as typeof fetch

    const executor = new Executor({
      registry,
      strategies: [http('http-html', bySite), emptyBrowser()],
      onFallback: async () => { healed += 1 },
    })

    const refused = await executor.run(task)
    expect(refused.blocked).toBe(true)
    expect(healed).toBe(0)

    // siteC's recipe is stale rather than refused, so it heals as it always did.
    const other = await executor.run(otherTask)
    expect(other.blocked).toBe(false)
    expect(healed).toBe(1)
  })
})

/**
 * The challenge-page path against a real HTTP server rather than fakes: the
 * fixture answers every agent with a 200 whose body carries no results, which
 * is the shape bandcamp.com blocked this machine with.
 */
describe('Executor against a refusing server', () => {
  it('reads a 200 challenge page as a block and leaves the recipe alone', async () => {
    const server = await startRefusingFixture()
    const engine = buildEngine({
      recipeDir: await mkdtemp(join(tmpdir(), 'fwa-refused-')),
      plans: PLANS,
      origins: { siteRefusing: server.url },
      minIntervalMs: 0,
    })
    const refusedTask: Task = { id: 'r1', site: 'siteRefusing', intent: 'search', input: { query: 'rust' } }

    try {
      // v1 serves the browser the real page, so a recipe compiles from it.
      const learning = await engine.executor.run(refusedTask)
      expect(learning.blocked).toBe(false)
      expect(await engine.registry.load('siteRefusing', 'search')).not.toBeNull()

      server.setVersion('v2')
      const heal = vi.spyOn(engine.healer, 'heal')
      const refused = await engine.executor.run(refusedTask)

      expect(refused.blocked).toBe(true)
      expect(refused.reasons).toContain('blocked: 200 with no items, browser also empty')
      expect(heal).not.toHaveBeenCalled()
    } finally {
      await engine.warm.close()
      await server.close()
    }
  }, 180_000)
})
