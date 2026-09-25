import { describe, it, expect } from 'vitest'
import { fieldCandidates } from '../../src/authoring/fields.js'

/** Hacker News's shape: a title link, a site label, and a per-row id. */
const ROWS = `<!doctype html><html><body><table><tbody>
  <tr class="athing" id="101">
    <td class="title"><span class="titleline"><a href="/a">Alpha story</a><span class="sitebit"> (a.com)</span></span></td>
    <td class="votes"><a href="/vote">vote</a></td>
  </tr>
  <tr class="athing" id="102">
    <td class="title"><span class="titleline"><a href="/b">Beta story</a><span class="sitebit"> (b.com)</span></span></td>
    <td class="votes"><a href="/vote">vote</a></td>
  </tr>
</tbody></table></body></html>`

const find = (html: string, selector: string, spec: string) =>
  fieldCandidates(html, selector, 200).find((c) => c.spec === spec)

describe('fieldCandidates', () => {
  it('proposes the title as a descendant text spec that covers every item', () => {
    const title = find(ROWS, 'tr.athing', 'span.titleline > a')
    expect(title).toBeDefined()
    expect(title).toMatchObject({ coverage: 1, distinct: 1 })
    expect(title!.samples).toEqual(['Alpha story', 'Beta story'])
  })

  it('proposes an attribute on the item itself', () => {
    expect(find(ROWS, 'tr.athing', '@id')).toMatchObject({ coverage: 1, distinct: 1 })
  })

  it('proposes an attribute on a descendant', () => {
    const href = find(ROWS, 'tr.athing', 'span.titleline > a@href')
    expect(href!.samples).toEqual(['/a', '/b'])
  })

  it('ranks a value that differs per item above one that is the same on all of them', () => {
    const ranked = fieldCandidates(ROWS, 'tr.athing', 200)
    const title = ranked.findIndex((c) => c.spec === 'span.titleline > a')
    const label = ranked.findIndex((c) => c.spec === 'td.votes > a')
    expect(label).toBeGreaterThan(-1)
    expect(title).toBeLessThan(label)
  })

  it('scores a constant label as covering everything and distinguishing nothing', () => {
    const label = find(ROWS, 'tr.athing', 'td.votes > a')
    expect(label).toMatchObject({ coverage: 1 })
    expect(label!.distinct).toBeLessThan(1)
  })

  it('returns nothing when the selector matches nothing', () => {
    expect(fieldCandidates(ROWS, 'tr.missing')).toEqual([])
  })

  it('enumerates over the same items the engine will read, including one a template holds', () => {
    const html = `<body>
      <div class="row"><span class="t">real one</span></div>
      <div class="row"><span class="t">real two</span></div>
      <template><div class="row"><b class="only-here">templated</b></div></template>
    </body>`
    const specs = fieldCandidates(html, 'div.row', 200).map((c) => c.spec)
    expect(specs).toContain('b.only-here')
  })

  it('does not offer a spec whose escaped class would be read as an attribute', () => {
    const html = `<!doctype html><html><body><ul>
      <li class="item"><span class="price@sale">10</span></li>
      <li class="item"><span class="price@sale">20</span></li>
    </ul></body></html>`
    const specs = fieldCandidates(html, 'li.item', 200).map((c) => c.spec)
    expect(specs.length).toBeGreaterThan(0)
    for (const spec of specs) expect(spec).not.toContain('\\@')
  })
})
