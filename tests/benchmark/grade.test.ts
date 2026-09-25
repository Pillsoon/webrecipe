import { describe, it, expect } from 'vitest'
import {
  baselineValidity, entityEquivalence, querySemantics, orderingAgreement, gradePair,
} from '../../src/benchmark/grade.js'
import { resolveOracle } from '../../src/benchmark/oracle.js'
import type { Item } from '../../src/types.js'

// `ordering: 'ignore'` is explicit here: DEFAULT_ORACLE.compare.ordering is
// 'strict' (see oracle.ts), so leaving it unset would make this oracle
// indistinguishable from `strict` below.
const oracle = resolveOracle({ mode: 'paired-live', compare: { ordering: 'ignore', fields: ['title', 'url'] } }, undefined)
const strict = resolveOracle({ compare: { ordering: 'strict' } }, undefined)

const rows: Item[] = [
  { title: 'Alpha', url: '/a', posted: '2h ago' },
  { title: 'Beta', url: '/b', posted: '5h ago' },
]

describe('baselineValidity', () => {
  it('rejects a baseline that threw', () => {
    expect(baselineValidity(rows, oracle, { threw: true, expectEmpty: false }).usable).toBe(false)
  })

  it('rejects an empty baseline the task did not expect', () => {
    const v = baselineValidity([], oracle, { threw: false, expectEmpty: false })
    expect(v.usable).toBe(false)
    expect(v.reason).toMatch(/no items/i)
  })

  it('accepts an empty baseline the task did expect', () => {
    expect(baselineValidity([], oracle, { threw: false, expectEmpty: true }).usable).toBe(true)
  })

  it('accepts a baseline whose compared fields resolve', () => {
    expect(baselineValidity(rows, oracle, { threw: false, expectEmpty: false }).usable).toBe(true)
  })

  it('rejects a baseline whose compared field is missing from most items', () => {
    const thin: Item[] = [{ title: null, url: '/a' }, { title: null, url: '/b' }]
    const v = baselineValidity(thin, oracle, { threw: false, expectEmpty: false })
    expect(v.usable).toBe(false)
    expect(v.reason).toMatch(/title/)
  })

  it('ignores a field the oracle does not compare', () => {
    // `posted` is absent everywhere, but the oracle only compares title and url.
    const noPosted: Item[] = rows.map(({ title, url }) => ({ title: title!, url: url! }))
    expect(baselineValidity(noPosted, oracle, { threw: false, expectEmpty: false }).usable).toBe(true)
  })
})

describe('entityEquivalence', () => {
  it('matches the same items in a different order', () => {
    expect(entityEquivalence(rows, [rows[1]!, rows[0]!], oracle).match).toBe(true)
  })

  it('ignores fields the oracle does not compare', () => {
    const moved = rows.map((r) => ({ ...r, posted: 'just now' }))
    expect(entityEquivalence(rows, moved, oracle).match).toBe(true)
  })

  it('fails when an item is missing', () => {
    const out = entityEquivalence(rows, [rows[0]!], oracle)
    expect(out.match).toBe(false)
    expect(out.reasons.join()).toMatch(/missing/i)
  })

  it('fails when an unexpected item appears', () => {
    const out = entityEquivalence(rows, [...rows, { title: 'Gamma', url: '/c' }], oracle)
    expect(out.reasons.join()).toMatch(/unexpected/i)
  })

  it('compares every field when the oracle names none', () => {
    const all = resolveOracle(undefined, undefined)
    expect(entityEquivalence(rows, rows.map((r) => ({ ...r, posted: 'x' })), all).match).toBe(false)
  })
})

describe('querySemantics', () => {
  const semantic = resolveOracle({
    semantics: { input: 'query', fields: ['title'], match: 'contains-token', minShare: 0.5 },
  }, undefined)

  it('is unjudged when no oracle declares a rule', () => {
    const items: Item[] = [{ title: 'anything', url: '/a' }]
    expect(querySemantics(items, { query: 'rust' }, oracle).match).toBeNull()
  })

  it('passes when enough items carry a token of the query', () => {
    const items: Item[] = [{ title: 'Senior Rust engineer', url: '/a' }, { title: 'Rust platform', url: '/b' }]
    expect(querySemantics(items, { query: 'rust' }, semantic).match).toBe(true)
  })

  it('passes a multi-word query on any token, not the whole phrase', () => {
    const items: Item[] = [{ title: 'Senior Backend Engineer', url: '/a' }, { title: 'Rust Platform Developer', url: '/b' }]
    expect(querySemantics(items, { query: 'senior rust engineer' }, semantic).match).toBe(true)
  })

  it('fails when the result ignores the query entirely', () => {
    const items: Item[] = [{ title: 'nursing role', url: '/a' }, { title: 'chef wanted', url: '/b' }]
    const out = querySemantics(items, { query: 'rust' }, semantic)
    expect(out.match).toBe(false)
    expect(out.reasons.join()).toMatch(/rust/)
  })

  it('is unjudged for an empty result', () => {
    expect(querySemantics([], { query: 'rust' }, semantic).match).toBeNull()
  })

  it('is unjudged when the task carries no value for the declared input', () => {
    expect(querySemantics(rows, { page: 2 }, semantic).match).toBeNull()
  })
})

describe('orderingAgreement', () => {
  it('is null when the oracle ignores ordering', () => {
    expect(orderingAgreement(rows, [rows[1]!, rows[0]!], oracle)).toBeNull()
  })

  it('is false when a strict oracle sees a different order', () => {
    expect(orderingAgreement(rows, [rows[1]!, rows[0]!], strict)).toBe(false)
  })

  it('is true when a strict oracle sees the same order', () => {
    expect(orderingAgreement(rows, rows, strict)).toBe(true)
  })

  it('is null when the sets differ, so ordering is unanswerable', () => {
    expect(orderingAgreement(rows, [rows[0]!], strict)).toBeNull()
  })
})

describe('gradePair', () => {
  const opts = { threw: false, expectEmpty: false, input: { query: 'Alpha' } }

  it('reports all three checks when the baseline is usable', () => {
    const g = gradePair(rows, rows, oracle, opts)
    expect(g).toMatchObject({ usable: true, entities: true, ordering: null })
    // No semantics rule is declared on this oracle, so the check is unjudged.
    expect(g.query).toBeNull()
  })

  it('leaves the layer-two checks unjudged when the baseline is not usable', () => {
    const g = gradePair([], rows, oracle, { ...opts, threw: true })
    expect(g.usable).toBe(false)
    expect(g.entities).toBeNull()
    expect(g.query).toBeNull()
    expect(g.validityReason).not.toBeNull()
  })
})
