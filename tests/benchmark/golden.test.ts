import { describe, it, expect } from 'vitest'
import { diffGolden, type Golden } from '../../src/benchmark/golden.js'

const golden: Golden = {
  taskId: 't1',
  capturedAt: '2026-09-15T00:00:00.000Z',
  items: [
    { id: '1', title: 'Alpha', votes: 10 },
    { id: '2', title: 'Beta', votes: 5 },
  ],
}

describe('diffGolden', () => {
  it('matches an identical result', () => {
    expect(diffGolden(golden, golden.items)).toEqual({ match: true, reasons: [] })
  })

  it('fails on a different item count', () => {
    const out = diffGolden(golden, [golden.items[0]!])
    expect(out.match).toBe(false)
    expect(out.reasons.join()).toMatch(/count/i)
  })

  it('fails when the order differs, because ranking is part of the result', () => {
    const out = diffGolden(golden, [golden.items[1]!, golden.items[0]!])
    expect(out.match).toBe(false)
  })

  it('fails on a changed field value', () => {
    const out = diffGolden(golden, [{ ...golden.items[0]!, title: 'Gamma' }, golden.items[1]!])
    expect(out.reasons.join()).toMatch(/title/)
  })

  it('compares a volatile field by presence and type only', () => {
    const actual = [{ ...golden.items[0]!, votes: 99 }, { ...golden.items[1]!, votes: 42 }]
    expect(diffGolden(golden, actual, ['votes']).match).toBe(true)
  })

  it('still fails when a volatile field is missing entirely', () => {
    const out = diffGolden(golden, [{ id: '1', title: 'Alpha' }, { id: '2', title: 'Beta' }], ['votes'])
    expect(out.match).toBe(false)
    expect(out.reasons.join()).toMatch(/votes/)
  })

  it('still fails when a volatile field changes type', () => {
    const actual = [{ ...golden.items[0]!, votes: 'ten' }, { ...golden.items[1]!, votes: 'five' }]
    const out = diffGolden(golden, actual, ['votes'])
    expect(out.match).toBe(false)
  })

  it('catches the pagination bug: right shape, wrong page', () => {
    const page2: Golden = { ...golden, items: [{ id: '11', title: 'Kappa', votes: 1 }, { id: '12', title: 'Lambda', votes: 2 }] }
    expect(diffGolden(page2, golden.items).match).toBe(false)
  })
})
