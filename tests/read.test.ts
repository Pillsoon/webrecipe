import { describe, it, expect } from 'vitest'
import { readUrl, urlShape, visibleText, type ReadDeps } from '../src/read.js'

const ARTICLE = `<html><head><title>Post</title><style>p{}</style></head><body><nav>menu</nav>
<article><h1>Hello</h1><p>${'Real server-rendered words. '.repeat(20)}</p></article><script>var x = 1</script></body></html>`
const SHELL = `<html><head><title>App</title><script src="/bundle.js"></script></head><body><div id="root"></div></body></html>`

function deps(pages: Record<string, { status?: number; body: string; type?: string }>, rendered = ARTICLE) {
  const calls = { fetch: 0, render: 0 }
  const store: Record<string, 'http' | 'browser'> = {}
  const d: ReadDeps = {
    isAllowed: async () => true,
    fetch: async (url) => { calls.fetch++; const p = pages[url]!; return { status: p.status ?? 200, headers: { 'content-type': p.type ?? 'text/html' }, body: p.body } },
    render: async () => { calls.render++; return rendered },
    methods: { get: async (k) => store[k], set: async (k, v) => { store[k] = v } },
  }
  return { d, calls, store }
}

describe('urlShape', () => {
  it('collapses id-like segments so different pages of one structure share a key', () => {
    expect(urlShape('https://a.com/post/12345/some-slug-here?x=1')).toBe(urlShape('https://a.com/post/999/other-slug-too'))
    expect(urlShape('https://a.com/docs/intro')).not.toBe(urlShape('https://a.com/docs/setup'))
  })
})

describe('visibleText', () => {
  it('drops scripts and styles and keeps the title', () => {
    const t = visibleText(ARTICLE)
    expect(t.title).toBe('Post')
    expect(t.text).toContain('Real server-rendered words.')
    expect(t.text).not.toContain('var x')
  })
})

describe('visibleText layout', () => {
  it('keeps block boundaries and drops navigation chrome, preferring main content', () => {
    const html = `<html><body><header><nav><a>Pricing</a><a>Log in</a></nav></header>
<main><h1>Plugins</h1><p>First paragraph.</p><ul><li>Nodes</li><li>Assets</li></ul></main>
<aside>Related</aside><footer>Careers Legal</footer></body></html>`
    const t = visibleText(html).text
    expect(t).toBe('Plugins\nFirst paragraph.\nNodes\nAssets')
  })
  it('falls back to the body when there is no main or article', () => {
    expect(visibleText('<html><body><div>One</div><div>Two</div><footer>F</footer></body></html>').text).toBe('One\nTwo')
  })
})

describe('readUrl', () => {
  it('returns server HTML text without a browser and remembers http', async () => {
    const { d, calls, store } = deps({ 'https://a.com/post/1': { body: ARTICLE } })
    const r = await readUrl('https://a.com/post/1', d)
    expect(r.method).toBe('http')
    expect(calls.render).toBe(0)
    expect(store[urlShape('https://a.com/post/1')]).toBe('http')
  })

  it('renders a JS shell, remembers browser, and skips HTTP for the same structure next time', async () => {
    const { d, calls } = deps({ 'https://b.com/item/1': { body: SHELL }, 'https://b.com/item/2': { body: SHELL } })
    const first = await readUrl('https://b.com/item/1', d)
    expect(first.method).toBe('browser')
    expect(first.reason).toMatch(/shell/)
    const second = await readUrl('https://b.com/item/2', d)
    expect(second.method).toBe('browser')
    expect(second.reason).toMatch(/remembered/)
    expect(calls.fetch).toBe(1)
  })

  it('falls back to the browser on a block status', async () => {
    const { d } = deps({ 'https://c.com/x': { status: 403, body: 'denied' } })
    const r = await readUrl('https://c.com/x', d)
    expect(r.method).toBe('browser')
    expect(r.reason).toContain('403')
  })

  it('returns non-HTML bodies as they are', async () => {
    const { d, calls } = deps({ 'https://d.com/api.json': { body: '{"a":1}', type: 'application/json' } })
    const r = await readUrl('https://d.com/api.json', d)
    expect(r).toMatchObject({ method: 'http', text: '{"a":1}' })
    expect(calls.render).toBe(0)
  })

  it('refuses what robots.txt disallows, with neither HTTP nor browser', async () => {
    const { d, calls } = deps({})
    d.isAllowed = async () => false
    await expect(readUrl('https://e.com/private', d)).rejects.toMatchObject({ code: 'ROBOTS_DISALLOWED' })
    expect(calls).toEqual({ fetch: 0, render: 0 })
  })

  it('does not report an empty render as content', async () => {
    const { d } = deps({ 'https://f.com/': { body: SHELL } }, SHELL)
    await expect(readUrl('https://f.com/', d)).rejects.toMatchObject({ code: 'UNVERIFIED_RESULT' })
  })
})
