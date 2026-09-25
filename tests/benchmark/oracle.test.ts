import { describe, it, expect } from 'vitest'
import { gradeGolden, type Golden } from '../../src/benchmark/golden.js'
import type { Item } from '../../src/types.js'

const golden: Golden = {
  taskId: 't', capturedAt: '2026-09-16T00:00:00.000Z',
  items: [
    { id: '1', title: 'Alpha', votes: 10 },
    { id: '2', title: 'Beta', votes: 5 },
    { id: '3', title: 'Gamma', votes: 1 },
  ],
}

describe('gradeGolden', () => {
  it('passes all three grades on an identical result', () => {
    const g = gradeGolden(golden, golden.items)
    expect(g).toMatchObject({ schema: true, semantic: true, ordering: true })
  })

  it('separates a reshuffle from a wrong result', () => {
    const shuffled = [golden.items[1]!, golden.items[0]!, golden.items[2]!]
    const g = gradeGolden(golden, shuffled)
    expect(g.schema).toBe(true)
    expect(g.semantic).toBe(true)
    expect(g.ordering).toBe(false)
  })

  it('fails semantic when an item is missing entirely', () => {
    const g = gradeGolden(golden, golden.items.slice(0, 2))
    expect(g.semantic).toBe(false)
    expect(g.reasons.join()).toMatch(/missing/i)
  })

  it('fails semantic when a field value is wrong', () => {
    const wrong = [{ ...golden.items[0]!, title: 'Delta' }, golden.items[1]!, golden.items[2]!]
    expect(gradeGolden(golden, wrong).semantic).toBe(false)
  })

  it('fails schema when a declared field is absent from every item', () => {
    const thin: Item[] = golden.items.map(({ id, title }) => ({ id: id!, title: title! }))
    const g = gradeGolden(golden, thin)
    expect(g.schema).toBe(false)
    expect(g.reasons.join()).toMatch(/votes/)
  })

  it('treats a volatile field as present-and-typed, not equal', () => {
    const moved = golden.items.map((i) => ({ ...i, votes: Number(i.votes) + 99 }))
    expect(gradeGolden(golden, moved, ['votes'])).toMatchObject({ schema: true, semantic: true })
  })

  it('still catches the wrong page, which shares a schema with the right one', () => {
    const page2: Golden = { ...golden, items: [{ id: '9', title: 'Kappa', votes: 1 }] }
    const g = gradeGolden(page2, golden.items)
    expect(g.schema).toBe(true)
    expect(g.semantic).toBe(false)
  })

  it('reports ordering as not applicable when the sets differ', () => {
    const g = gradeGolden(golden, [golden.items[0]!])
    expect(g.ordering).toBeNull()
  })

  it('without a fields restriction, drift in any field fails the comparison', () => {
    const drifted = golden.items.map((i) => ({ ...i, votes: Number(i.votes) + 1 }))
    expect(gradeGolden(golden, drifted).semantic).toBe(false)
  })

  it('restricts comparison to the given fields, so drift outside them does not fail it', () => {
    const drifted = golden.items.map((i) => ({ ...i, votes: Number(i.votes) + 1 }))
    const g = gradeGolden(golden, drifted, [], ['id', 'title'])
    expect(g).toMatchObject({ schema: true, semantic: true })
  })

  it('still fails on a mismatch within the restricted fields', () => {
    const wrong = [{ ...golden.items[0]!, title: 'Delta' }, golden.items[1]!, golden.items[2]!]
    expect(gradeGolden(golden, wrong, [], ['id', 'title']).semantic).toBe(false)
  })
})
