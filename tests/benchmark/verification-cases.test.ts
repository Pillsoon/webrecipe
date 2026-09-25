import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runVerificationCases, runCase, VERIFICATION_CASES, PAGINATION_CASES } from '../../src/benchmark/verification-cases.js'
import { tabulate, verdictFrom, type CaseOutcome } from '../../src/benchmark/verification-matrix.js'

const HONORED = ['query_honored'] as const
const BOTH = ['query_honored', 'lexical_query_consistency'] as const

describe('the fixture verification benchmark', () => {
  let outcomes: CaseOutcome[]

  it('runs every case and judges each answer independently of the verifier', async () => {
    outcomes = await runVerificationCases()
    expect(outcomes.map((o) => o.id)).toEqual(VERIFICATION_CASES.map((c) => c.id))
    expect(outcomes.every((o) => o.oracleMatch !== null)).toBe(true)
  }, 120_000)

  // The case this benchmark was built to make countable, and the record of
  // what adding a check did to it.
  it('stops blessing shifted once lexical consistency is required, without failing it', () => {
    const shifted = outcomes.find((o) => o.id === 'shifted')!
    expect(shifted.oracleMatch).toBe(false)
    expect(shifted.checks.query_honored).toBe('passed')
    expect(shifted.checks.lexical_query_consistency).toBe('not_tested')
    expect(verdictFrom(shifted, [...HONORED])).toBe('passed')
    expect(verdictFrom(shifted, [...BOTH])).toBe('not_tested')
  })

  it('removes the one false success and gives up no correct answer to do it', () => {
    const before = tabulate(outcomes, [...HONORED])
    const after = tabulate(outcomes, [...BOTH])
    expect(before.falseSuccess).toBe(1)
    expect(after.falseSuccess).toBe(0)
    expect(after.verifiedCorrect).toBe(before.verifiedCorrect)
    expect(after.abstainedCorrect).toBe(before.abstainedCorrect)
  })

  it('shows the structural bar blessing every wrong answer the checks caught', () => {
    const m = tabulate(outcomes, [...BOTH])
    expect(m.structuralSuccess).toBe(m.cases)
    expect(m.structuralFalseSuccess).toBe(m.oracleWrong)
    expect(m.falseSuccess).toBeLessThan(m.structuralFalseSuccess)
  })

  it('places each case in the quadrant its fixture was written to produce', () => {
    const by = Object.fromEntries(outcomes.map((o) => [o.id, o]))
    expect(verdictFrom(by.honest!, [...BOTH])).toBe('passed')
    expect(by.honest!.oracleMatch).toBe(true)
    expect(verdictFrom(by.ignoring!, [...BOTH])).toBe('failed')
    expect(by.ignoring!.oracleMatch).toBe(false)
    expect(verdictFrom(by.volatile!, [...BOTH])).toBe('not_tested')
    expect(by.volatile!.oracleMatch).toBe(true)
    expect(verdictFrom(by['rate-limited']!, [...BOTH])).toBe('not_tested')
    expect(by['rate-limited']!.oracleMatch).toBe(true)
    expect(verdictFrom(by.cloaking!, [...BOTH])).toBe('not_tested')
    expect(by.cloaking!.oracleMatch).toBe(false)
  })
})

describe('the pagination benchmark', () => {
  let outcomes: CaseOutcome[]
  const PAGED = ['pagination_honored'] as const

  it('runs its own cases under its own denominator', async () => {
    outcomes = await runVerificationCases(PAGINATION_CASES)
    expect(outcomes).toHaveLength(PAGINATION_CASES.length)
    // Pooling these with the query cases would give a rate over a population
    // nobody chose: these fixtures exercise a page control and those do not.
    expect(PAGINATION_CASES.map((c) => c.id)).not.toEqual(VERIFICATION_CASES.map((c) => c.id))
    expect(outcomes.every((o) => o.oracleMatch !== null)).toBe(true)
  }, 180_000)

  it('blesses no wrong answer, and names the one it can prove broken', () => {
    const m = tabulate(outcomes, [...PAGED])
    expect(m.falseSuccess).toBe(0)
    expect(m.structuralFalseSuccess).toBeGreaterThan(0)
    expect(m.failed).toBe(1)
  })

  it('places each case in the quadrant its fixture was written to produce', () => {
    const by = Object.fromEntries(outcomes.map((o) => [o.id, o]))
    const verdict = (id: string) => verdictFrom(by[id]!, [...PAGED])

    expect(verdict('paged')).toBe('passed')
    expect(by.paged!.oracleMatch).toBe(true)
    // Overlap is recorded, never gated: a pinned row is ordinary.
    expect(verdict('page-pinned')).toBe('passed')
    expect(by['page-pinned']!.oracleMatch).toBe(true)
    // The only positive disproof available: the browser moved, the recipe did not.
    expect(verdict('page-stale')).toBe('failed')
    expect(by['page-stale']!.oracleMatch).toBe(false)
    // Indistinguishable from a site with one page, so it is withheld not failed.
    expect(verdict('page-ignored')).toBe('not_tested')
    expect(by['page-ignored']!.oracleMatch).toBe(false)

    for (const id of ['single-page', 'page-volatile', 'page-limited']) {
      expect(verdict(id), id).toBe('not_tested')
      expect(by[id]!.oracleMatch, id).toBe(true)
    }
    expect(verdict('page-cloaking')).toBe('not_tested')
    expect(by['page-cloaking']!.oracleMatch).toBe(false)
  })
})

describe('keeping the oracle independent of the verifier', () => {
  /**
   * The invariant, stated behaviourally rather than as a signature: change what
   * the verifier concludes, leave the answer alone, and the oracle must not
   * move. Skipping the probes turns shifted's verdict from passed to
   * not_tested without touching a single byte the site returns.
   */
  it('does not move when the verifier reaches a different verdict on the same answer', async () => {
    const shifted = VERIFICATION_CASES.find((c) => c.id === 'shifted')!
    const probed = await runCase(shifted)
    const unprobed = await runCase(shifted, { skipSemanticVerification: true })

    expect(probed.checks.query_honored).toBe('passed')
    expect(unprobed.checks.query_honored).toBeUndefined()
    expect(probed.oracleMatch).toBe(false)
    expect(unprobed.oracleMatch).toBe(false)
    expect(unprobed.oracleReason).toBe(probed.oracleReason)
  }, 60_000)

  // The judging path must not be able to read the verifier even by accident.
  it('has no path from the judging modules into the production verifier', async () => {
    const root = join(process.cwd(), 'src', 'benchmark')
    for (const file of ['grade.ts', 'oracle.ts', 'verification-matrix.ts', 'ground-truth.ts']) {
      const source = await readFile(join(root, file), 'utf8')
      expect(source, `${file} imports the production verifier`).not.toMatch(/from '\.\.\/verification\//)
    }
  })
})
