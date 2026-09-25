import { describe, expect, it } from 'vitest'
import { alternatePage, judgePagination, type PaginationSession } from '../../src/verification/pagination-honored.js'
import type { ProbeObservation } from '../../src/verification/probes.js'
import type { Item } from '../../src/types.js'

const rows = (...ids: number[]): Item[] => ids.map((id) => ({ title: `row ${id}`, url: `/item/${id}` }))

const session = (over: Partial<{
  taught: Item[] | null
  repeat: Item[] | null
  alternate: Item[] | null
  unavailable: string
  browserTaught: Item[] | null
  browserAlternate: Item[] | null
  noAlternate: boolean
}> = {}): PaginationSession => {
  const pick = <T>(v: T | undefined, fallback: T): T => v === undefined ? fallback : v
  const observations: ProbeObservation[] = [
    { role: 'taught', value: '1', items: pick(over.taught, rows(1, 2, 3)) },
    { role: 'repeat', value: '1', items: pick(over.repeat, rows(1, 2, 3)) },
  ]
  if (over.noAlternate !== true) {
    observations.push({ role: 'alternate', value: '2', items: pick(over.alternate, rows(4, 5, 6)),
      ...(over.unavailable === undefined ? {} : { unavailable: over.unavailable }) })
  }
  return {
    parameter: 'page', taughtPage: 1, alternatePage: 2, observations,
    browserTaught: pick(over.browserTaught, rows(1, 2, 3)),
    browserAlternate: pick(over.browserAlternate, rows(4, 5, 6)),
  }
}

describe('choosing which page to compare against', () => {
  // Probing page + 1 from a task taught on its last page comes back empty and
  // gives up on a site that paginates perfectly well.
  it('reaches for a neighbour that probably exists', () => {
    expect(alternatePage(1)).toBe(2)
    expect(alternatePage(5)).toBe(4)
    expect(alternatePage(2)).toBe(1)
  })

  it('treats a page below one as a first page', () => {
    expect(alternatePage(0)).toBe(2)
  })
})

describe('judging whether a page control selects a window', () => {
  it('passes when the window moved and the browser saw the same one', () => {
    const verdict = judgePagination(session())
    expect(verdict.status).toBe('passed')
    expect(verdict.signals).toEqual({ stable: true, moved: true, agreed: true })
  })

  // A pinned or sponsored row, a live insert and a ranking shift all repeat
  // rows across pages, so overlap is recorded and never gated on.
  it('passes a site that repeats a pinned row on both pages', () => {
    const verdict = judgePagination(session({ alternate: rows(1, 4, 5), browserAlternate: rows(1, 4, 5) }))
    expect(verdict.status).toBe('passed')
    expect(verdict.shares.overlap).toBeCloseTo(1 / 3)
  })
})

describe('the one route to failed', () => {
  it('fails when the recipe stays put and the browser moves', () => {
    const verdict = judgePagination(session({ alternate: rows(1, 2, 3) }))
    expect(verdict.status).toBe('failed')
    expect(verdict.signals.moved).toBe(false)
    expect(verdict.reason).toMatch(/recipe's page control does nothing/)
  })

  // Indistinguishable from a site with one page, so it is not called broken.
  it('withholds a verdict when the browser stays put too', () => {
    const verdict = judgePagination(session({ alternate: rows(1, 2, 3), browserAlternate: rows(1, 2, 3) }))
    expect(verdict.status).toBe('not_tested')
    expect(verdict.reason).toMatch(/clamps the page or has only one/)
  })

  it('withholds a verdict when nothing in the browser can say either way', () => {
    expect(judgePagination(session({ alternate: rows(1, 2, 3), browserAlternate: null })).status).toBe('not_tested')
    expect(judgePagination(session({ alternate: rows(1, 2, 3), browserTaught: null })).status).toBe('not_tested')
  })
})

describe('refusing to judge', () => {
  // A real last page is empty. Calling that broken would fail every task
  // taught near the end of its results.
  it('never fails an empty neighbour', () => {
    const verdict = judgePagination(session({ alternate: [] }))
    expect(verdict.status).toBe('not_tested')
    expect(verdict.status).not.toBe('failed')
    expect(verdict.reason).toMatch(/which a last page also does/)
  })

  it('will not judge a listing that changes between identical requests', () => {
    const verdict = judgePagination(session({ repeat: rows(1, 2, 9) }))
    expect(verdict.signals.stable).toBe(false)
    expect(verdict.status).toBe('not_tested')
  })

  it.each([
    ['the taught page was declined', session({ taught: null, unavailable: 'site declined with 429' })],
    ['the alternate page was declined', session({ alternate: null, unavailable: 'site declined with 503' })],
    ['no alternate probe was issued', session({ noAlternate: true })],
    ['the taught page returned nothing', session({ taught: [], repeat: [] })],
  ])('withholds a verdict when %s', (_why, given) => {
    expect(judgePagination(given).status).toBe('not_tested')
  })

  it('withholds a verdict when the recipe and the browser disagree on the moved window', () => {
    const verdict = judgePagination(session({ browserAlternate: rows(7, 8, 9) }))
    expect(verdict.signals.agreed).toBe(false)
    expect(verdict.status).toBe('not_tested')
  })

  // Transport trouble must never read as a semantic verdict.
  it('never fails on anything a declined probe produced', () => {
    for (const given of [
      session({ taught: null, unavailable: 'x' }), session({ alternate: null, unavailable: 'x' }),
      session({ alternate: [] }), session({ repeat: rows(9) }), session({ noAlternate: true }),
    ]) expect(judgePagination(given).status).not.toBe('failed')
  })
})
