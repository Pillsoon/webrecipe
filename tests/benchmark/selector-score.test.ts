import { describe, it, expect } from 'vitest'
import { scoreSelector, scoreSnapshot } from '../../src/benchmark/selector-score.js'
import type { Label } from '../../src/benchmark/labels.js'

const HTML = `<!doctype html><html><body>
  <nav><a class="nav" href="/help">Help</a><a class="nav" href="/about">About</a></nav>
  <ul id="results">
    <li class="result"><a href="/item/1">The Hobbit</a></li>
    <li class="result"><a href="/item/2">Dune</a></li>
  </ul>
</body></html>`

const label: Label = {
  snapshot: 'fixture',
  url: 'https://example.com/search',
  capturedAt: '2026-09-19T12:00:00Z',
  note: '',
  identifier: 'text',
  items: ['The Hobbit', 'Dune'],
}

describe('scoreSelector', () => {
  it('scores the right selector exact', () => {
    expect(scoreSelector(HTML, '#results > li.result', label)).toEqual({
      precision: 1, recall: 1, exact: true,
    })
  })

  it('refuses a wrapper that covers every item in one element', () => {
    const score = scoreSelector(HTML, 'ul#results', label)
    expect(score.exact).toBe(false)
  })

  it('reports partial precision when the selector also picks up navigation', () => {
    const score = scoreSelector(HTML, 'a', label)
    expect(score.recall).toBe(1)
    expect(score.precision).toBeCloseTo(0.5)
    expect(score.exact).toBe(false)
  })

  it('refuses the right count aimed at the wrong elements', () => {
    expect(scoreSelector(HTML, 'a.nav', label)).toEqual({ precision: 0, recall: 0, exact: false })
  })

  it('matches on href when the label is written in hrefs', () => {
    const byHref: Label = { ...label, identifier: 'href', items: ['/item/1', '/item/2'] }
    expect(scoreSelector(HTML, '#results > li.result', byHref).exact).toBe(true)
  })

  it('does not let a short href answer for a longer one', () => {
    const html = `<!doctype html><html><body><ul>
      <li class="r"><a href="/item/1">First</a></li>
      <li class="r"><a href="/item/12">Second</a></li>
    </ul></body></html>`
    const byHref: Label = { ...label, identifier: 'href', items: ['/item/1', '/item/12'] }
    expect(scoreSelector(html, 'li.r', byHref)).toEqual({ precision: 1, recall: 1, exact: true })
  })
})

describe('items that carry no text of their own', () => {
  const covers = `<!doctype html><html><body><ul id="shelf">
    <li class="book"><a href="/works/1"><img src="1.jpg" alt="Dune"></a><span>Borrow</span></li>
    <li class="book"><a href="/works/2"><img src="2.jpg" alt="Neuromancer"></a><span>Borrow</span></li>
  </ul></body></html>`

  const shelf: Label = {
    snapshot: 'covers', url: 'https://example.com/shelf', capturedAt: '2026-09-19T12:00:00Z',
    note: '', identifier: 'text', items: ['Dune', 'Neuromancer'],
  }

  it('scores a label written from alternative text', () => {
    expect(scoreSelector(covers, '#shelf > li.book', shelf)).toEqual({
      precision: 1, recall: 1, exact: true,
    })
  })

  it('still refuses the wrapper that holds every cover', () => {
    expect(scoreSelector(covers, 'ul#shelf', shelf).exact).toBe(false)
  })
})

describe('scoreSnapshot', () => {
  it('keeps generator recall apart from ranking accuracy', () => {
    const report = scoreSnapshot('fixture', HTML, label)
    expect(report.labeled).toBe(2)
    expect(report.exactRank).not.toBeNull()
    expect(report.rows[report.exactRank! - 1]!.score.exact).toBe(true)
    expect(report.topIsExact).toBe(report.exactRank === 1)
  })

  it('reports no exact rank when nothing in the list is right', () => {
    const impossible: Label = { ...label, items: ['Nothing On This Page'] }
    const report = scoreSnapshot('fixture', HTML, impossible)
    expect(report.exactRank).toBeNull()
    expect(report.topIsExact).toBe(false)
  })
})
