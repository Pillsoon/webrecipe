import { describe, it, expect } from 'vitest'
import { planAging } from '../../src/benchmark/grade.js'
import { resolveOracle } from '../../src/benchmark/oracle.js'
import type { Item } from '../../src/types.js'

const oracle = resolveOracle({ mode: 'paired-live', compare: { fields: ['title', 'url'] } }, undefined)
const golden: Item[] = [{ title: 'Alpha', url: '/a' }, { title: 'Beta', url: '/b' }]

describe('planAging', () => {
  it('says nothing when the shape still holds, however different the items', () => {
    const fresh: Item[] = [{ title: 'Kappa', url: '/k' }, { title: 'Lambda', url: '/l' }]
    expect(planAging(golden, fresh, oracle)).toBeNull()
  })

  it('reports a compared field that has stopped resolving', () => {
    const rotted: Item[] = [{ title: null, url: '/k' }, { title: null, url: '/l' }]
    const out = planAging(golden, rotted, oracle)
    expect(out).toMatch(/title/)
    expect(out).toMatch(/^plan aging:/)
  })

  it('flags a collapse in item count as possible, not certain', () => {
    const out = planAging(golden, [{ title: 'Kappa', url: '/k' }], oracle)
    expect(out).toMatch(/possible plan aging/)
    expect(out).toMatch(/count/i)
  })

  it('says nothing when there is no golden to compare against', () => {
    expect(planAging(undefined, golden, oracle)).toBeNull()
  })

  it('ignores a field the oracle does not compare', () => {
    const noExtra: Item[] = [{ title: 'Kappa', url: '/k' }, { title: 'Lambda', url: '/l' }]
    const withExtra: Item[] = golden.map((g) => ({ ...g, posted: '2h' }))
    expect(planAging(withExtra, noExtra, oracle)).toBeNull()
  })
})
