import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startXhrFixture } from '../../fixtures/xhr.js'
import type { FixtureServer } from '../../fixtures/harness.js'
import { StaticSiteResolver } from '../../src/sites.js'
import { record } from '../../src/recorder/index.js'
import { HeuristicCompiler, findItemsPath, findRecordPath, inferFields, templatePath, templateBody } from '../../src/compiler/heuristic.js'
import { isRefused, type CompileResult } from '../../src/compiler/types.js'
import type { Recipe } from '../../src/recipes/schema.js'
import { scoreRequests } from '../../src/analyzer/score.js'
import { PolitenessLayer } from '../../src/net/politeness.js'
import { HttpJsonStrategy } from '../../src/executor/strategies/http-json.js'
import type { Trace } from '../../src/recorder/types.js'
import type { Task } from '../../src/types.js'
import type { BrowserPlan } from '../../src/executor/strategies/browser.js'

let server: FixtureServer
let trace: Trace

beforeAll(async () => {
  server = await startXhrFixture()
  const task: Task = { id: 'c1', site: 'siteB', intent: 'search', input: { query: 'rust' } }
  trace = await record(
    { url: (o, t) => `${o}/search?q=${t.input.query}`, itemSelector: 'li.result', fields: { id: '@data-id' } },
    task, new StaticSiteResolver({ siteB: server.url }),
  )
}, 60_000)
afterAll(async () => { await server.close() })

describe('findItemsPath', () => {
  it('finds the array of objects', () => {
    expect(findItemsPath({ query: 'x', total: 40, results: [{ id: '1' }] })).toBe('$.results')
  })

  it('prefers the longest array of objects', () => {
    expect(findItemsPath({ a: [{ x: 1 }], b: [{ x: 1 }, { x: 2 }] })).toBe('$.b')
  })

  it('ignores arrays of primitives', () => {
    expect(findItemsPath({ suggestions: ['a', 'b'], results: [{ id: '1' }] })).toBe('$.results')
  })

  it('returns null when there is no array of objects', () => {
    expect(findItemsPath({ flags: { a: true } })).toBeNull()
  })
})

describe('inferFields', () => {
  it('maps the conventional id, title and url names', () => {
    expect(inferFields({ id: '1', title: 'T', url: '/x', author: 'a' }))
      .toMatchObject({ id: '$.id', title: '$.title', url: '$.url' })
  })

  it('accepts name as a title', () => {
    expect(inferFields({ id: '1', name: 'N' })).toMatchObject({ id: '$.id', title: '$.name' })
  })

  it('falls back to the first string field when nothing is conventional', () => {
    expect(inferFields({ code: 'C', label: 'L' })).toMatchObject({ id: '$.code' })
  })
})

/** The recipe, or a failure that names why the compiler refused. */
function compiled(result: CompileResult): Recipe {
  if (isRefused(result)) throw new Error(`compiler refused: ${result.refused}`)
  return result
}

describe('HeuristicCompiler', () => {
  it('compiles a recipe that points at the real endpoint, not a decoy', async () => {
    const recipe = compiled(await new HeuristicCompiler().compile(trace))
    expect(recipe.request.path).toBe('/api/search')
    expect(recipe.strategy.type).toBe('http-json')
  })

  it('templates the query parameter that carried the input', async () => {
    const recipe = compiled(await new HeuristicCompiler().compile(trace))
    // page is a constant here: the search task supplies no page input to match.
    expect(recipe.request.query).toEqual({ q: '{{query}}', page: '1' })
  })

  it('records an items path and fields', async () => {
    const recipe = compiled(await new HeuristicCompiler().compile(trace))
    expect(recipe.output).toMatchObject({ type: 'json', items: { path: '$.results' } })
    expect(Object.keys(recipe.output.items.fields)).toContain('title')
  })

  it('fingerprints the contract it reads, not the whole payload', async () => {
    const recipe = compiled(await new HeuristicCompiler().compile(trace))
    expect(recipe.fingerprint.hash).toHaveLength(16)
    // The names the recipe declares, not every path the response happens to carry.
    expect(recipe.fingerprint.responseFields).toEqual(Object.keys(recipe.output.items.fields).sort())
  })

  it('produces a recipe that actually runs and returns the same data', async () => {
    const recipe = compiled(await new HeuristicCompiler().compile(trace))
    const strategy = new HttpJsonStrategy(
      new PolitenessLayer({ minIntervalMs: 0 }),
      new StaticSiteResolver({ siteB: server.url }),
    )
    const result = await strategy.execute(recipe, { id: 'c2', site: 'siteB', intent: 'search', input: { query: 'rust' } })
    expect(result.items.length).toBeGreaterThan(0)
    expect(String(result.items[0]!.title)).toContain('rust')
  })

  it('refuses, naming the step, when the trace has no usable data request', async () => {
    expect(await new HeuristicCompiler().compile({ ...trace, requests: [] }))
      .toEqual({ refused: "no candidate response carries the browser's items" })
  })
})

describe('HeuristicCompiler candidate fallthrough', () => {
  it('skips a higher-scoring candidate whose payload has no result set', async () => {
    // Give autocomplete every signal search has, so it outranks it on arrival order.
    const poisoned: Trace = {
      ...trace,
      requests: trace.requests.map((r) =>
        new URL(r.url).pathname === '/api/autocomplete'
          ? { ...r, domChanged: true, url: `${new URL(r.url).origin}/api/autocomplete?prefix=rust` }
          : r,
      ),
    }
    const ranked = scoreRequests(poisoned)
    expect(new URL(ranked[0]!.request.url).pathname).toBe('/api/autocomplete')

    const recipe = compiled(await new HeuristicCompiler().compile(poisoned))
    expect(recipe.request.path).toBe('/api/search')
  })

  it('names the input it could not template, which is what makes a recipe a snapshot', async () => {
    // page 7 appears nowhere in the recorded /api/search?q=rust&page=1, so a
    // recipe compiled from it would answer page 1 for every page asked.
    const unreachable: Trace = { ...trace, input: { query: 'rust', page: 7 } }
    expect(await new HeuristicCompiler().compile(unreachable))
      .toEqual({ refused: 'required input "page" not templated' })
  })

  it('still refuses when no candidate has a result set at all', async () => {
    const stripped: Trace = {
      ...trace,
      requests: trace.requests.filter((r) => new URL(r.url).pathname !== '/api/search'),
    }
    expect(await new HeuristicCompiler().compile(stripped))
      .toEqual({ refused: 'no fields could be inferred from the payload' })
  })
})

describe('HeuristicCompiler on detail payloads', () => {
  it('finds a single record when the payload has no array', () => {
    expect(findRecordPath({ result: { id: '100', title: 'T', author: 'a' } })).toBe('$.result')
  })

  it('prefers a conventional wrapper key', () => {
    expect(findRecordPath({ meta: { page: 1 }, result: { id: '1', title: 'T' } })).toBe('$.result')
  })

  it('uses the root when the record is not wrapped', () => {
    expect(findRecordPath({ id: '100', title: 'T', author: 'a' })).toBe('$')
  })

  it('ignores an object with too few scalar fields to be a record', () => {
    expect(findRecordPath({ flags: { on: true } })).toBeNull()
  })

  it('compiles a detail recipe that runs without a browser', async () => {
    const detailTask: Task = { id: 'd1', site: 'siteB', intent: 'detail', input: { id: '100' } }
    const detailTrace = await record(
      { url: (o, t) => `${o}/item/${t.input.id}`, itemSelector: 'article#detail', fields: { id: '@data-id' } },
      detailTask, new StaticSiteResolver({ siteB: server.url }),
    )
    const recipe = compiled(await new HeuristicCompiler().compile(detailTrace))
    expect(recipe.request.path).toBe('/api/item')

    const strategy = new HttpJsonStrategy(
      new PolitenessLayer({ minIntervalMs: 0 }),
      new StaticSiteResolver({ siteB: server.url }),
    )
    const result = await strategy.execute(recipe!, detailTask)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.id).toBe('100')
  }, 60_000)
})

describe('path templating', () => {
  it('replaces a path segment that carries an input value', () => {
    expect(templatePath('/item/100', { id: '100' })).toBe('/item/{{id}}')
  })

  it('leaves segments that are not input values alone', () => {
    expect(templatePath('/api/v1/crates', { query: 'serde' })).toBe('/api/v1/crates')
  })

  it('ignores an empty input value, which would match every empty segment', () => {
    expect(templatePath('/search/', { query: '' })).toBe('/search/')
  })

  it('templates only the matching segment when several look similar', () => {
    expect(templatePath('/100/item/100', { id: '100' })).toBe('/{{id}}/item/{{id}}')
  })
})

describe('inferFields with expected names', () => {
  it('maps an expected name straight onto the payload key of the same name', () => {
    expect(inferFields({ id: '1', title: 'T', author: 'a' }, ['id', 'title', 'author']))
      .toEqual({ id: '$.id', title: '$.title', author: '$.author' })
  })

  it('maps an expected title onto a payload key called name', () => {
    expect(inferFields({ id: '1', name: 'N' }, ['id', 'title'])).toEqual({ id: '$.id', title: '$.name' })
  })

  it('drops an expected field the payload does not carry', () => {
    expect(inferFields({ id: '1' }, ['id', 'author'])).toEqual({ id: '$.id' })
  })

  it('falls back to conventional inference when nothing is expected', () => {
    expect(inferFields({ id: '1', title: 'T' })).toMatchObject({ id: '$.id', title: '$.title' })
  })
})

describe('the browser plan is a contract', () => {
  it('refuses to compile when the payload cannot supply every expected field', async () => {
    // crates.io's API has no url field, while its browser plan extracts one.
    const compiler = new HeuristicCompiler(['id', 'title', 'nonexistent'])
    expect(await compiler.compile(trace)).toEqual({ refused: 'inferred 2 of 3 expected fields' })
  })

  it('compiles when every expected field is available', async () => {
    const compiler = new HeuristicCompiler(['id', 'title'])
    const recipe = compiled(await compiler.compile(trace))
    expect(Object.keys(recipe.output.items.fields).sort()).toEqual(['id', 'title'])
  })
})

describe('templateBody', () => {
  it('templates a json post body by exact value match', () => {
    const body = JSON.stringify({ query: 'kubernetes', page: 0, tags: ['story'] })
    const out = templateBody(body, { query: 'kubernetes' })
    expect(JSON.parse(out!)).toEqual({ query: '{{query}}', page: 0, tags: ['story'] })
  })

  it('templates a form-encoded body', () => {
    expect(templateBody('q=rust&page=1', { query: 'rust' })).toBe('q=%7B%7Bquery%7D%7D&page=1')
  })

  it('returns null when the body carries no input value', () => {
    expect(templateBody(JSON.stringify({ page: 0 }), { query: 'rust' })).toBeNull()
  })

  it('does not touch a value that merely contains the input', () => {
    const body = JSON.stringify({ note: 'about kubernetes clusters', query: 'kubernetes' })
    expect(JSON.parse(templateBody(body, { query: 'kubernetes' })!))
      .toEqual({ note: 'about kubernetes clusters', query: '{{query}}' })
  })
})

describe('templatePath with multi-segment values', () => {
  it('templates an id that spans several segments', () => {
    expect(templatePath('/github.com/gorilla/mux', { id: 'github.com/gorilla/mux' }))
      .toBe('/{{id}}')
  })

  it('does not template a segment that merely starts with the value', () => {
    expect(templatePath('/1000/x', { id: '100' })).toBe('/1000/x')
  })

  it('prefers the longer value when one contains another', () => {
    expect(templatePath('/a/b', { long: 'a/b', short: 'a' })).toBe('/{{long}}')
  })
})

describe('templatePath with a value below the length floor', () => {
  it('templates a short value that fills a whole segment', () => {
    expect(templatePath('/t/typescript/page/2', { query: 'typescript', page: 2 }))
      .toBe('/t/{{query}}/page/{{page}}')
  })

  it('leaves a short value that is only part of a segment', () => {
    expect(templatePath('/v2/api/page/2', { page: 2 })).toBe('/v2/api/page/{{page}}')
    expect(templatePath('/item-2/page/2', { page: 2 })).toBe('/item-2/page/{{page}}')
  })

  it('still refuses a longer value that only prefixes a segment', () => {
    expect(templatePath('/item/1000', { id: 100 })).toBe('/item/1000')
  })
})

describe('detail intent prefers the record over a sidecar array', () => {
  it('picks the record, not the longest array beside it', () => {
    const payload = { crate: { id: 'serde', name: 'serde' }, versions: [{ num: '1' }, { num: '2' }] }
    expect(findRecordPath(payload)).toBe('$.crate')
    expect(findItemsPath(payload)).toBe('$.versions')
  })
})

describe('deriving fields the API does not carry', () => {
  it('synthesises a field from the browser value when no path supplies it', async () => {
    // siteB's api/search has no `link`; the browser plan builds one from the id.
    const plan: BrowserPlan = {
      url: (o, t) => `${o}/search?q=${encodeURIComponent(String(t.input.query))}`,
      itemSelector: 'li.result',
      fields: { id: '@data-id', link: 'a.permalink@href' },
    }
    const derivedTrace = await record(plan,
      { id: 'd', site: 'siteB', intent: 'search', input: { query: 'rust' } },
      new StaticSiteResolver({ siteB: server.url }))

    const recipe = compiled(await new HeuristicCompiler(plan).compile(derivedTrace))
    expect(recipe.output.items.fields.link).toBe('/item/{{id}}')
  }, 60_000)
})
