import { describe, expect, it } from 'vitest'
import { tabulate, ratio, verdictFrom, structurallySuccessful, type CaseOutcome } from '../../src/benchmark/verification-matrix.js'

const outcome = (over: Partial<CaseOutcome> & { id: string }): CaseOutcome => ({
  checks: { query_honored: 'passed' }, oracleMatch: true, structuralSuccess: true, ...over,
})
const ONLY_HONORED = ['query_honored'] as const

describe('tabulating verifier verdicts against an independent oracle', () => {
  const set: CaseOutcome[] = [
    outcome({ id: 'honest' }),
    outcome({ id: 'shifted', oracleMatch: false }),
    outcome({ id: 'ignoring', checks: { query_honored: 'failed' }, oracleMatch: false }),
    outcome({ id: 'volatile', checks: { query_honored: 'not_tested' } }),
    outcome({ id: 'cloaking', checks: { query_honored: 'not_tested' }, oracleMatch: false }),
  ]

  it('counts a passed verdict on a wrong answer as a false success and nothing else', () => {
    const m = tabulate(set, [...ONLY_HONORED])
    expect(m.falseSuccess).toBe(1)
    expect(m.verifiedCorrect).toBe(1)
    expect(m.rejectedWrong).toBe(2)
    expect(m.abstainedCorrect).toBe(1)
    // The quadrants partition the judged cases exactly once each.
    expect(m.verifiedCorrect + m.falseSuccess + m.abstainedCorrect + m.rejectedWrong).toBe(m.judged)
  })

  it('separates the structural baseline from the verifier on the same cases', () => {
    const m = tabulate(set, [...ONLY_HONORED])
    // Every wrong answer here is structurally impeccable, which is the whole
    // difficulty: the structural bar blesses all three, the verifier one.
    expect(m.oracleWrong).toBe(3)
    expect(m.structuralFalseSuccess).toBe(3)
    expect(m.falseSuccess).toBe(1)
  })

  it('keeps a case the oracle could not judge out of every rate', () => {
    const m = tabulate([...set, outcome({ id: 'unjudgeable', oracleMatch: null })], [...ONLY_HONORED])
    expect(m.cases).toBe(6)
    expect(m.judged).toBe(5)
    expect(m.oracleUnjudged).toBe(1)
    expect(m.verifiedCorrect + m.falseSuccess).toBe(1 + 1)
    expect(m.passed).toBe(3)
  })

  it('reports no score rather than a perfect one when a denominator is empty', () => {
    expect(ratio(0, 0)).toBeNull()
    const m = tabulate([outcome({ id: 'only', checks: { query_honored: 'not_tested' } })], [...ONLY_HONORED])
    expect(ratio(m.verifiedCorrect, m.passed)).toBeNull()
  })
})

describe('scoring one layer at a time', () => {
  // Adding a check must read as a change to the same case, not as a new number
  // with no ancestor, so a layer is scored by shortening the required list.
  const both = outcome({ id: 'shifted', oracleMatch: false, checks: { query_honored: 'passed', lexical_query_consistency: 'not_tested' } })

  it('calls a case passed only when every required check passed', () => {
    expect(verdictFrom(both, ['query_honored'])).toBe('passed')
    expect(verdictFrom(both, ['query_honored', 'lexical_query_consistency'])).toBe('not_tested')
  })

  it('treats a check with no evidence as untested rather than as absent', () => {
    expect(verdictFrom(outcome({ id: 'x', checks: {} }), ['query_honored'])).toBe('not_tested')
  })

  it('lets one failure outweigh every other check passing', () => {
    const mixed = outcome({ id: 'y', checks: { query_honored: 'failed', lexical_query_consistency: 'passed' } })
    expect(verdictFrom(mixed, ['query_honored', 'lexical_query_consistency'])).toBe('failed')
  })

  it('turns a false success into an abstention when the added check withholds', () => {
    const before = tabulate([both], ['query_honored'])
    const after = tabulate([both], ['query_honored', 'lexical_query_consistency'])
    expect(before.falseSuccess).toBe(1)
    expect(after.falseSuccess).toBe(0)
    expect(after.rejectedWrong).toBe(1)
  })
})

describe('the structural bar', () => {
  it('is the one Step 1 already applied: non-empty, and no field missing anywhere', () => {
    expect(structurallySuccessful([{ title: 'a', url: '/a' }], ['title', 'url'])).toBe(true)
    expect(structurallySuccessful([], ['title'])).toBe(false)
    expect(structurallySuccessful([{ title: 'a', url: '' }], ['title', 'url'])).toBe(false)
  })
})
