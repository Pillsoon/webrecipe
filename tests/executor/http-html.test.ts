import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startSsrFixture } from '../../fixtures/ssr.js'
import type { FixtureServer } from '../../fixtures/harness.js'
import { PolitenessLayer } from '../../src/net/politeness.js'
import { StaticSiteResolver } from '../../src/sites.js'
import { HttpHtmlStrategy } from '../../src/executor/strategies/http-html.js'
import { extractHtmlItems, extractBySelector } from '../../src/executor/extract.js'
import type { Recipe } from '../../src/recipes/schema.js'
import type { Task } from '../../src/types.js'

let server: FixtureServer
let strategy: HttpHtmlStrategy

const recipe: Recipe = {
  site: 'siteA', intent: 'search',
  inputs: { query: { type: 'string' } },
  strategy: { type: 'http-html' },
  request: { method: 'GET', path: '/search', query: { q: '{{query}}' } },
  output: {
    type: 'html',
    items: { selector: 'li.result', fields: { id: '@data-id', title: 'a.title', url: 'a.title@href' } },
  },
  validation: { status: 200, required: ['id', 'title'], minItems: 1 },
  fingerprint: { endpoint: '/search', hash: 'x', responseFields: [] },
  fallback: { type: 'browser' },
}

const task: Task = { id: 't1', site: 'siteA', intent: 'search', input: { query: 'rust' } }

beforeAll(async () => {
  server = await startSsrFixture()
  strategy = new HttpHtmlStrategy(
    new PolitenessLayer({ minIntervalMs: 0 }),
    new StaticSiteResolver({ siteA: server.url }),
  )
})
afterAll(async () => { await server.close() })

describe('extractHtmlItems', () => {
  it('reads an attribute off the item element with @attr', () => {
    const items = extractHtmlItems(recipe, '<li class="result" data-id="7"><a class="title" href="/item/7">T</a></li>')
    expect(items[0]).toEqual({ id: '7', title: 'T', url: '/item/7' })
  })

  it('returns an empty list when the selector matches nothing', () => {
    expect(extractHtmlItems(recipe, '<div>nothing here</div>')).toEqual([])
  })

  it('yields null for a field whose selector is absent', () => {
    const items = extractHtmlItems(recipe, '<li class="result" data-id="7"></li>')
    expect(items[0]!.title).toBeNull()
  })
})

describe('HttpHtmlStrategy', () => {
  it('parses server-rendered results with no browser', async () => {
    const result = await strategy.execute(recipe, task)
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.meta.strategy).toBe('http-html')
    expect(result.meta.browserLaunches).toBe(0)
    expect(result.meta.networkRequests).toBe(1)
  })

  it('returns nothing once the markup is renamed in v2', async () => {
    server.setVersion('v2')
    const result = await strategy.execute(recipe, task)
    expect(result.items).toEqual([])
    server.setVersion('v1')
  })
})

describe('extractHtmlItems and extractBySelector agree', () => {
  const html = '<li class="result" data-id="7"><a class="title" href="/item/7">T</a></li>'

  it("reads the element's own text for an empty spec, as the browser plan does", () => {
    const own: Recipe = {
      ...recipe,
      output: { type: 'html', items: { selector: 'li.result', fields: { title: '' } } },
    }
    expect(extractHtmlItems(own, html)[0]!.title).toBe('T')
  })

  it('produces the same items as extractBySelector for the same spec', () => {
    const fields = { id: '@data-id', title: '', link: 'a.title@href' }
    const asRecipe: Recipe = {
      ...recipe,
      output: { type: 'html', items: { selector: 'li.result', fields } },
    }
    expect(extractHtmlItems(asRecipe, html)).toEqual(extractBySelector(html, 'li.result', fields))
  })
})

describe('field specs whose selector contains @', () => {
  const html = '<li><a href="/@oak/oak" class="name">oak</a></li>'

  it('splits on the attribute suffix, not on an @ inside the selector', () => {
    expect(extractBySelector(html, 'li', { url: 'a[href^="/@"]@href' }))
      .toEqual([{ url: '/@oak/oak' }])
  })

  it('still reads text through a selector containing @', () => {
    expect(extractBySelector(html, 'li', { title: 'a[href^="/@"]' }))
      .toEqual([{ title: 'oak' }])
  })

  it('still reads an attribute off the item element itself', () => {
    expect(extractBySelector('<li data-id="7"></li>', 'li', { id: '@data-id' }))
      .toEqual([{ id: '7' }])
  })
})
