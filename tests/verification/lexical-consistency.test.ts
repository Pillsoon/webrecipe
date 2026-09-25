import { describe, expect, it } from 'vitest'
import { judgeLexicalConsistency, lexicalShare, LEXICAL_MATCH_THRESHOLD } from '../../src/verification/lexical-consistency.js'
import type { ProbeSession, ProbeObservation } from '../../src/verification/query-honored.js'
import type { Item } from '../../src/types.js'

const rows = (titles: string[]): Item[] => titles.map((title, i) => ({ title, url: `/item/${i}` }))

const session = (over: {
  taught?: Item[] | null
  contrast?: Item[] | null
  contrastValue?: string
  taughtValue?: string
  unavailable?: string
  noContrast?: boolean
}): ProbeSession => {
  const observations: ProbeObservation[] = [
    { role: 'taught', value: over.taughtValue ?? 'rust', items: over.taught === undefined ? rows(['Senior rust engineer']) : over.taught,
      ...(over.unavailable === undefined ? {} : { unavailable: over.unavailable }) },
    { role: 'repeat', value: over.taughtValue ?? 'rust', items: [] },
    { role: 'nonce', value: 'zqx7391kvw', items: [] },
  ]
  if (over.noContrast !== true) {
    observations.push({ role: 'contrast', value: over.contrastValue ?? 'analyst',
      items: over.contrast === undefined ? rows(['Senior go analyst']) : over.contrast })
  }
  return { parameter: 'query', taughtValue: over.taughtValue ?? 'rust', observations, browserContrast: null }
}

describe('measuring how visible a query is in its own result', () => {
  it('counts a row once whichever extracted field carries the token', () => {
    expect(lexicalShare([{ title: 'nothing', url: '/rust-guide' }], 'rust')).toBe(1)
  })

  it('has no share to report when the query carries no usable token', () => {
    expect(lexicalShare(rows(['Senior rust engineer']), 'a')).toBeNull()
    expect(lexicalShare([], 'rust')).toBeNull()
  })

  it('absorbs a plural the site added, which is not a site answering wrongly', () => {
    expect(lexicalShare(rows(['Senior rust designers wanted']), 'designer')).toBe(1)
  })
})

describe('judging lexical consistency', () => {
  it('passes a site whose results carry the query, and kept doing so for an untaught value', () => {
    const verdict = judgeLexicalConsistency(session({}))
    expect(verdict.status).toBe('passed')
    expect(verdict.signals).toEqual({ applicable: true, consistent: true })
    expect(verdict.shares).toEqual({ taught: 1, contrast: 1 })
  })

  // The shifted site: it honours the query and answers with other records, so
  // its own result never carries what was asked for.
  it('withholds a verdict when the taught query is nowhere in its own result', () => {
    const verdict = judgeLexicalConsistency(session({ taught: rows(['Senior typescript designer', 'Senior typescript analyst']) }))
    expect(verdict.status).toBe('not_tested')
    expect(verdict.signals.applicable).toBe(false)
    expect(verdict.reason).toMatch(/does not match on text we can read/)
  })

  // A site searching a description, a tag or a synonym is answering correctly
  // and is indistinguishable from the one above, so neither may be failed.
  it('reaches the same verdict for a site that matches on something we cannot see', () => {
    const matchedElsewhere = judgeLexicalConsistency(session({ taught: rows(['Systems programmer', 'Kernel developer']) }))
    expect(matchedElsewhere.status).toBe('not_tested')
    expect(matchedElsewhere.status).not.toBe('failed')
  })

  it('withholds a verdict when an untaught value stops being visible', () => {
    const verdict = judgeLexicalConsistency(session({ contrast: rows(['Senior rust engineer', 'Senior go manager']) }))
    expect(verdict.status).toBe('not_tested')
    expect(verdict.signals.applicable).toBe(true)
    expect(verdict.signals.consistent).toBe(false)
    expect(verdict.reason).toMatch(/matching on two different fields/)
  })

  it.each([
    ['no contrast token could be built', session({ noContrast: true })],
    ['the contrast probe was declined', session({ contrast: null })],
    ['the contrast query returned nothing', session({ contrast: [] })],
    ['the taught probe was declined', session({ taught: null, unavailable: 'site declined with 429' })],
  ])('withholds a verdict when %s', (_why, given) => {
    expect(judgeLexicalConsistency(given).status).toBe('not_tested')
  })

  it('never returns failed, whatever the probes showed', () => {
    const everyShape = [
      session({}), session({ taught: rows(['unrelated']) }), session({ contrast: rows(['unrelated']) }),
      session({ taught: [] }), session({ noContrast: true }), session({ contrast: null }),
    ]
    for (const one of everyShape) expect(judgeLexicalConsistency(one).status).not.toBe('failed')
  })

  it('applies one named threshold to both stages', () => {
    const justUnder = Array.from({ length: 10 }, (_, i) => i < 7 ? 'Senior rust engineer' : 'Senior go engineer')
    expect(LEXICAL_MATCH_THRESHOLD).toBe(0.8)
    expect(judgeLexicalConsistency(session({ taught: rows(justUnder) })).signals.applicable).toBe(false)
    expect(judgeLexicalConsistency(session({ taught: rows([...justUnder.slice(0, 7), 'Senior rust analyst']) })).signals.applicable).toBe(true)
  })
})
