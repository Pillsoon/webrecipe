import { describe, it, expect } from 'vitest'
import { LabelSchema, visibleRuns } from '../../src/benchmark/labels.js'

const valid = {
  snapshot: 'flathub-search',
  url: 'https://flathub.org/apps/search?q=editor',
  capturedAt: '2026-09-19T12:00:00Z',
  note: 'the search result grid',
  identifier: 'text' as const,
  items: ['GNU Emacs', 'Vim'],
}

describe('LabelSchema', () => {
  it('accepts a complete label', () => {
    expect(LabelSchema.parse(valid).items).toEqual(['GNU Emacs', 'Vim'])
  })

  it('defaults an absent note to empty', () => {
    const { note, ...withoutNote } = valid
    expect(LabelSchema.parse(withoutNote).note).toBe('')
  })

  it('rejects a label with no items, so an unfinished skeleton cannot be scored', () => {
    expect(() => LabelSchema.parse({ ...valid, items: [] })).toThrow()
  })

  it('rejects an unknown identifier kind', () => {
    expect(() => LabelSchema.parse({ ...valid, identifier: 'selector' })).toThrow()
  })
})

describe('visibleRuns', () => {
  it('returns the page text in document order', () => {
    const html = '<body><h1>Results</h1><ul><li>First<em>!</em></li><li>Second</li></ul></body>'
    expect(visibleRuns(html)).toEqual(['Results', 'First', '!', 'Second'])
  })

  it("reads an image's alternative text, which is the only thing a cover says", () => {
    const html = '<body><ul><li><img src="a.jpg" alt="Dune"><span>Borrow</span></li></ul></body>'
    expect(visibleRuns(html)).toEqual(['Dune', 'Borrow'])
  })

  it('ignores an empty alt, which marks an image as decorative', () => {
    expect(visibleRuns('<body><img src="line.png" alt=""><p>Shown</p></body>')).toEqual(['Shown'])
  })

  it('leaves out script and style, which are not shown to a reader', () => {
    const html = '<body><style>.a{color:red}</style><p>Shown</p><script>hidden()</script></body>'
    expect(visibleRuns(html)).toEqual(['Shown'])
  })
})
