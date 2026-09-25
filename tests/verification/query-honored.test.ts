import { describe, expect, it } from 'vitest'
import { judge, chooseContrastToken, type ProbeObservation } from '../../src/verification/query-honored.js'
import type { Item } from '../../src/types.js'

const rows = (...ids: number[]): Item[] => ids.map((id) => ({ title: `Senior rust engineer #${id}`, url: `/item/${id}` }))

const probes = (over: Partial<Record<ProbeObservation['role'], Partial<ProbeObservation>>> = {}): ProbeObservation[] => {
  const base: Partial<Record<ProbeObservation['role'], ProbeObservation>> = {
    taught: { role: 'taught', value: 'rust', items: rows(1, 2, 3, 4) },
    repeat: { role: 'repeat', value: 'rust', items: rows(1, 2, 3, 4) },
    contrast: { role: 'contrast', value: 'borrow', items: rows(2) },
    nonce: { role: 'nonce', value: 'zqx7391kvw', items: [] },
  }
  return (Object.keys(base) as ProbeObservation['role'][]).map((role) => ({ ...base[role]!, ...over[role] }))
}

describe('judging an endpoint that honours its query', () => {
  it('passes only with every signal, and records each one', () => {
    const verdict = judge(probes(), rows(2))
    expect(verdict.status).toBe('passed')
    expect(verdict.signals).toEqual({ stable: true, responsive: true, nonce_rejected: true, agreed: true })
  })

  it('accepts a nonce that returns a few rows rather than none', () => {
    expect(judge(probes({ nonce: { items: rows(9) } }), rows(2)).status).toBe('passed')
  })
})

describe('judging an endpoint that discards its query', () => {
  // The only route to `failed`: positive evidence, not the absence of evidence.
  it('fails when a query nothing could match returns the taught result', () => {
    const verdict = judge(probes({
      nonce: { items: rows(1, 2, 3, 4) },
      contrast: { items: rows(1, 2, 3, 4) },
    }), rows(1, 2, 3, 4))
    expect(verdict.status).toBe('failed')
    expect(verdict.signals.nonce_rejected).toBe(false)
    expect(verdict.reason).toMatch(/returned the taught result unchanged/)
  })

  it('withholds a verdict when the nonce returns a different but undiminished set', () => {
    const verdict = judge(probes({ nonce: { items: rows(5, 6, 7, 8) } }), rows(2))
    expect(verdict.status).toBe('not_tested')
    expect(verdict.reason).toMatch(/neither honours nor discards/)
  })
})

describe('refusing to judge what the probes cannot separate', () => {
  it('will not judge a site whose answer changes between identical requests', () => {
    const verdict = judge(probes({ repeat: { items: rows(1, 2, 3, 9) } }), rows(2))
    expect(verdict.status).toBe('not_tested')
    expect(verdict.signals.stable).toBe(false)
    expect(verdict.reason).toMatch(/two identical requests/)
  })

  // A volatile site must not be called broken either: `failed` would drop a
  // working integration to unverified on nothing but noise.
  it('will not call a volatile site failed even when the nonce matches the taught set', () => {
    expect(judge(probes({
      repeat: { items: rows(1, 2, 3, 9) },
      nonce: { items: rows(1, 2, 3, 4) },
    }), rows(2)).status).toBe('not_tested')
  })

  it('withholds a verdict when no contrast token could be built', () => {
    const without = probes().filter((p) => p.role !== 'contrast')
    expect(judge(without, rows(2)).reason).toMatch(/no contrast probe/)
    expect(judge(without, rows(2)).status).toBe('not_tested')
  })

  it('withholds a verdict when the contrast token was too common to separate anything', () => {
    const verdict = judge(probes({ contrast: { items: rows(1, 2, 3, 4) } }), rows(1, 2, 3, 4))
    expect(verdict.status).toBe('not_tested')
    expect(verdict.signals.responsive).toBe(false)
    expect(verdict.reason).toMatch(/too common/)
  })

  // Rate limits and outages are the site declining, never a semantic verdict.
  it.each([
    ['taught', 'site declined with 429'],
    ['repeat', 'site declined with 503'],
    ['nonce', 'unexpected status 500'],
    ['contrast', 'site declined with 429'],
  ] as const)('withholds a verdict when the %s probe was declined', (role, why) => {
    const verdict = judge(probes({ [role]: { items: null, unavailable: why } }), rows(2))
    expect(verdict.status).toBe('not_tested')
    expect(verdict.reason).toContain(why)
  })

  it('withholds a verdict when the recipe and the browser saw different items', () => {
    const verdict = judge(probes(), rows(3))
    expect(verdict.status).toBe('not_tested')
    expect(verdict.signals.agreed).toBe(false)
    expect(verdict.reason).toMatch(/recipe and the browser saw different items/)
  })

  it('withholds a verdict when no browser reference was taken', () => {
    expect(judge(probes(), null).status).toBe('not_tested')
  })

  it('withholds a verdict when the taught query itself returned nothing', () => {
    expect(judge(probes({ taught: { items: [] }, repeat: { items: [] } }), rows(2)).reason)
      .toMatch(/taught query returned nothing/)
  })
})

describe('choosing a contrast token', () => {
  it('prefers a token the taught result carries in only a row or two', () => {
    const items: Item[] = [
      { title: 'Senior rust engineer', url: '/a' },
      { title: 'Senior rust designer', url: '/b' },
      { title: 'Senior rust analyst', url: '/c' },
    ]
    expect(chooseContrastToken(items, 'rust')).toBe('analyst')
  })

  it('never proposes a token of the taught query itself', () => {
    const items: Item[] = [{ title: 'rust one', url: '/a' }, { title: 'rust two', url: '/b' }]
    expect(chooseContrastToken(items, 'rust')).not.toBe('rust')
  })

  // Every row carrying every token, so nothing in the answer can separate one
  // query from another. Saying so is what keeps the run at not_tested.
  it('returns null when the result has no token rare enough to discriminate', () => {
    const items: Item[] = Array.from({ length: 6 }, (_, i) => ({ title: 'senior rust engineer', url: `/${i}` }))
    expect(chooseContrastToken(items, 'rust')).toBeNull()
  })

  it('returns null for a single-row result, where every token spans the whole set', () => {
    expect(chooseContrastToken([{ title: 'senior rust engineer', url: '/a' }], 'rust')).toBeNull()
  })

  it('picks the same token every time, so a stored verification can be repeated', () => {
    const items: Item[] = [
      { title: 'alpha bravo charlie', url: '/a' },
      { title: 'alpha delta echo', url: '/b' },
      { title: 'alpha foxtrot golf', url: '/c' },
    ]
    expect(chooseContrastToken(items, 'alpha')).toBe(chooseContrastToken(items, 'alpha'))
    expect(chooseContrastToken(items, 'alpha')).toBe('bravo')
  })
})
