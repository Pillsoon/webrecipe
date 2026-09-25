import { describe, expect, it } from 'vitest'
import { verificationStatus, verificationWarnings, verifyReadable, type VerificationChecks } from '../src/local.js'
import { buildContract } from '../src/authoring/contract.js'

const structural: VerificationChecks = {
  non_empty: 'passed',
  required_fields: 'passed',
  query_honored: 'not_configured',
  lexical_query_consistency: 'not_configured',
  pagination_honored: 'not_configured',
  entity_equivalence: 'not_configured',
  ordering: 'not_configured',
}

describe('local result verification boundary', () => {
  it('labels readable extraction as structural rather than semantic verification', () => {
    expect(verifyReadable([{ title: 'Rust', url: '/rust' }], ['title', 'url'])).toEqual({
      status: 'structural',
      contract: null,
      checks: structural,
    })
  })

  it('still fails closed when rows or required fields are missing', () => {
    expect(() => verifyReadable([], ['title'])).toThrowError(/No readable items/)
    expect(() => verifyReadable([{ title: 'Rust', url: '' }], ['title', 'url'])).toThrowError(/Selected fields are missing/)
  })
})

describe('status derivation', () => {
  // The check that stops a passing probe from writing its own passing grade.
  it('cannot exceed structural without a stored contract, however much passed', () => {
    expect(verificationStatus({ ...structural, query_honored: 'passed', pagination_honored: 'passed' })).toBe('structural')
  })

  it('reports a contracted task with an unrun required check as partially verified', () => {
    const contract = { required: ['non_empty', 'required_fields', 'query_honored'] } as const
    expect(verificationStatus({ ...structural, query_honored: 'not_tested' }, { required: [...contract.required] })).toBe('partially_verified')
  })

  it('reports verified only when every required check passed', () => {
    const contract = { required: ['non_empty', 'required_fields', 'query_honored'] as const }
    expect(verificationStatus({ ...structural, query_honored: 'passed' }, { required: [...contract.required] })).toBe('verified')
    expect(verificationStatus({ ...structural, query_honored: 'passed', pagination_honored: 'not_tested' },
      { required: ['non_empty', 'required_fields', 'query_honored', 'pagination_honored'] })).toBe('partially_verified')
  })

  // Contrary evidence outranks a contract, whether or not the contract asked
  // for that check: a result is not partly verified while something says it is
  // wrong.
  it('drops to unverified whenever a check actually failed', () => {
    expect(verificationStatus({ ...structural, query_honored: 'failed' })).toBe('unverified')
    expect(verificationStatus({ ...structural, query_honored: 'passed', pagination_honored: 'failed' },
      { required: ['non_empty', 'required_fields', 'query_honored'] })).toBe('unverified')
    expect(verificationStatus({ ...structural, non_empty: 'not_tested' })).toBe('unverified')
  })
})

describe('stored contract and evidence', () => {
  const rows = [{ title: 'Rust' }]

  it('marks a required check with no evidence as not tested, not as unconfigured', () => {
    const result = verifyReadable(rows, ['title'], {
      contract: { required: ['non_empty', 'required_fields', 'query_honored'] },
      evidence: { non_empty: { status: 'passed' }, required_fields: { status: 'passed' } },
    })
    expect(result.checks.query_honored).toBe('not_tested')
    expect(result.checks.pagination_honored).toBe('not_configured')
    expect(result.status).toBe('partially_verified')
  })

  it('lets this run overrule stored structural evidence, which describes an older result', () => {
    const result = verifyReadable(rows, ['title'], {
      contract: { required: ['non_empty', 'required_fields'] },
      evidence: { non_empty: { status: 'failed' } },
    })
    expect(result.checks.non_empty).toBe('passed')
    expect(result.status).toBe('verified')
  })
})

describe('warnings', () => {
  it('names the unproven checks instead of a fixed sentence', () => {
    const none = verifyReadable([{ title: 'Rust' }], ['title'])
    expect(verificationWarnings(none)).toEqual(['no verification contract is stored for this task; only structural validity was checked'])

    const partial = verifyReadable([{ title: 'Rust' }], ['title'], {
      contract: { required: ['non_empty', 'required_fields', 'query_honored', 'pagination_honored'] },
      evidence: { query_honored: { status: 'passed' } },
    })
    expect(verificationWarnings(partial)).toEqual(['required by this task\'s verification contract but not proven: pagination_honored'])
  })

  it('says nothing once the contract is met', () => {
    expect(verificationWarnings(verifyReadable([{ title: 'Rust' }], ['title'], {
      contract: { required: ['non_empty', 'required_fields'] },
      evidence: {},
    }))).toEqual([])
  })
})

describe('contract builder', () => {
  it('requires only structural checks when nothing varies', () => {
    expect(buildContract('list', new Set())).toEqual({ required: ['non_empty', 'required_fields'] })
  })

  // Both query checks, because neither is enough alone: the first passes a
  // site that honours the query and answers with the wrong records.
  it('requires both query checks when a search templates its query', () => {
    expect(buildContract('search', new Set(['query']))).toEqual({
      required: ['non_empty', 'required_fields', 'query_honored', 'lexical_query_consistency'],
    })
  })

  // A detail lookup templating an id is not a search, and demanding query
  // semantics of it would make it permanently unverifiable.
  it('does not require the query checks of a non-search task', () => {
    expect(buildContract('detail', new Set(['id']))).toEqual({ required: ['non_empty', 'required_fields'] })
  })

  // Templating page is what makes `run --page N` a supported operation. A task
  // that only ever returns one page does not template it, and is asked nothing.
  it('requires pagination exactly when the plan exposes page as an input', () => {
    expect(buildContract('search', new Set(['query'])).required).not.toContain('pagination_honored')
    expect(buildContract('list', new Set()).required).not.toContain('pagination_honored')
  })

  it('requires pagination wherever the plan can page', () => {
    expect(buildContract('search', new Set(['query', 'page']))).toEqual({
      required: ['non_empty', 'required_fields', 'query_honored', 'lexical_query_consistency', 'pagination_honored'],
    })
  })
})
