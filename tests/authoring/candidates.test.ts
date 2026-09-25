import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { generateCandidates } from '../../src/authoring/candidates.js'

/** A navigation run that is numerous and text-poor beside a listing that is not. */
const NAV_AND_LIST = `<!doctype html><html><body>
  <nav>
    <a class="nav" href="/a">Home</a>
    <a class="nav" href="/b">Help</a>
    <a class="nav" href="/c">About</a>
    <a class="nav" href="/d">Blog</a>
  </nav>
  <ul id="results">
    <li class="result"><a class="title" href="/item/1">The Hobbit, or There and Back Again</a></li>
    <li class="result"><a class="title" href="/item/2">Dune, and its several sequels</a></li>
  </ul>
</body></html>`

describe('generateCandidates', () => {
  it('proposes every repeated sibling run, not only the largest', () => {
    const selectors = generateCandidates(NAV_AND_LIST).map((c) => c.selector)
    expect(selectors).toContain('li.result')
    expect(selectors).toContain('a.nav')
  })

  it('ranks the text-heavy run above the numerous text-poor one', () => {
    expect(generateCandidates(NAV_AND_LIST)[0]!.selector).toBe('li.result')
  })

  it('reports what the selector matches, with samples a human can read', () => {
    const listing = generateCandidates(NAV_AND_LIST).find((c) => c.selector === 'li.result')!
    expect(listing.count).toBe(2)
    expect(listing.samples[0]).toBe('The Hobbit, or There and Back Again')
  })

  it('drops runs that carry no text, which are layout rather than content', () => {
    const html = '<body><div class="row"><span class="sep"></span><span class="sep"></span></div></body>'
    expect(generateCandidates(html)).toEqual([])
  })

  it('ignores script and style text, which is not what the page shows', () => {
    const html = `<body>
      <div><script>const a = ${'"x".repeat(500)'}</script><script>const b = 2</script></div>
      <ul><li class="r">one item</li><li class="r">two item</li></ul>
    </body>`
    expect(generateCandidates(html)[0]!.selector).toBe('li.r')
  })
})

/** Two regions of the same shape, which is the openlibrary failure. */
export const TWO_CAROUSELS = `<!doctype html><html><body>
  <section id="trending">
    <a class="card" href="/b/1">Trending one</a>
    <a class="card" href="/b/2">Trending two</a>
  </section>
  <section id="classics">
    <a class="card" href="/b/3">Classic one</a>
    <a class="card" href="/b/4">Classic two</a>
  </section>
</body></html>`

describe('two regions sharing a signature', () => {
  it('becomes two candidates, one per region', () => {
    const selectors = generateCandidates(TWO_CAROUSELS).map((c) => c.selector)
    expect(selectors).toContain('#trending > a.card')
    expect(selectors).toContain('#classics > a.card')
  })

  it('still offers the unscoped run, because over-matching is sometimes right', () => {
    expect(generateCandidates(TWO_CAROUSELS).map((c) => c.selector)).toContain('a.card')
  })
})

describe('addressing', () => {
  it('addresses through an id when the bare signature reaches too far', () => {
    const html = `<body>
      <ul id="results"><li class="r">first result</li><li class="r">second result</li></ul>
      <ul class="aside"><li class="r">related one</li><li class="r">related two</li></ul>
    </body>`
    const selectors = generateCandidates(html).map((c) => c.selector)
    expect(selectors).toContain('#results > li.r')
    expect(selectors).toContain('li.r')
  })

  it('escapes a class that is not a bare identifier', () => {
    const html = `<body>
      <div class="md:flex">
        <a class="w-1/2" href="/a">first entry</a><a class="w-1/2" href="/b">second entry</a>
      </div>
      <div class="plain">
        <a class="w-1/2" href="/c">third entry</a><a class="w-1/2" href="/d">fourth entry</a>
      </div>
    </body>`
    const scoped = generateCandidates(html).find((c) => c.scoped)!
    expect(scoped.selector).toBe('div.md\\:flex > a.w-1\\/2')
    expect(scoped.count).toBe(2)
  })

  it('falls back to nth-of-type when neither id nor class is unique', () => {
    const html = `<body><main>
      <div><p class="c">alpha one</p><p class="c">alpha two</p></div>
      <div><p class="c">beta one</p><p class="c">beta two</p></div>
    </main></body>`
    const selectors = generateCandidates(html).map((c) => c.selector)
    expect(selectors).toContain('main > div:nth-of-type(1) > p.c')
    expect(selectors).toContain('main > div:nth-of-type(2) > p.c')
  })

  it('scopes a run that a state class has split into several exact-class groups', () => {
    // A carousel marks the visible slide active, so the twenty items in one
    // track are not one group. The selector the largest group yields still
    // selects all twenty, because a class selector matches by subset.
    const html = `<body>
      <div id="one">
        <a class="card on">alpha one</a><a class="card">alpha two</a><a class="card">alpha three</a>
      </div>
      <div id="two">
        <a class="card on">beta one</a><a class="card">beta two</a><a class="card">beta three</a>
      </div>
    </body>`
    const scoped = generateCandidates(html).find((c) => c.selector === '#one > a.card')
    expect(scoped).toBeDefined()
    expect(scoped!.count).toBe(3)
    expect(generateCandidates(html).map((c) => c.selector)).toContain('#two > a.card')
  })

  it('marks a candidate unscoped when no unique address exists', () => {
    const html = '<body><ul><li class="r">one item</li><li class="r">two item</li></ul></body>'
    const bare = generateCandidates(html).find((c) => c.selector === 'li.r')!
    expect(bare.scoped).toBe(false)
  })
})

import { startSsrFixture } from '../../fixtures/ssr.js'
import type { FixtureServer } from '../../fixtures/harness.js'

describe('the SSR fixture', () => {
  let ssr: FixtureServer
  beforeAll(async () => { ssr = await startSsrFixture() })
  afterAll(async () => { await ssr.close() })

  it('proposes the listing the hand-written plan uses', async () => {
    const html = await (await fetch(`${ssr.url}/search?q=rust`)).text()
    const listing = generateCandidates(html).find((c) => c.selector === 'li.result')
    expect(listing).toBeDefined()
    expect(listing!.count).toBeGreaterThan(1)
    // `li.result` is unique to this page's listing, so the scoped form selects
    // the same elements and the shorter selector is the one that survives.
    expect(listing!.scoped).toBe(false)
  })
})
