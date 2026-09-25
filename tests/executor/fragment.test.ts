import { describe, it, expect } from 'vitest'
import { parseHtmlFragment, extractBySelector } from '../../src/executor/extract.js'

describe('parseHtmlFragment', () => {
  it('keeps table rows that a document parse would discard', () => {
    const frag = '<tr class="job" data-url="/a"><td>A</td></tr><tr class="job" data-url="/b"><td>B</td></tr>'
    expect(parseHtmlFragment(frag)('tr.job').length).toBe(2)
  })

  it('keeps table cells', () => {
    expect(parseHtmlFragment('<td class="x">A</td><td class="x">B</td>')('td.x').length).toBe(2)
  })

  it('keeps list items', () => {
    expect(parseHtmlFragment('<li class="r">A</li><li class="r">B</li>')('li.r').length).toBe(2)
  })

  it('keeps options', () => {
    expect(parseHtmlFragment('<option value="1">A</option>')('option').length).toBe(1)
  })

  it('leaves an ordinary fragment alone', () => {
    expect(parseHtmlFragment('<div class="r">A</div><div class="r">B</div>')('div.r').length).toBe(2)
  })

  it('leaves a whole document alone', () => {
    const doc = '<!doctype html><html><body><table><tr class="job"><td>A</td></tr></table></body></html>'
    expect(parseHtmlFragment(doc)('tr.job').length).toBe(1)
  })

  it('ignores leading whitespace and comments when deciding', () => {
    const frag = '\n\t<!-- rows -->\n<tr class="job"><td>A</td></tr>'
    expect(parseHtmlFragment(frag)('tr.job').length).toBe(1)
  })
})

describe('extractBySelector on a fragment', () => {
  it('reads rows out of a bare table fragment', () => {
    const frag = '<tr class="job" data-url="/a"><td class="t">Alpha</td></tr>'
    expect(extractBySelector(frag, 'tr.job', { url: '@data-url', title: 'td.t' }))
      .toEqual([{ url: '/a', title: 'Alpha' }])
  })
})
