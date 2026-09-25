import { describe, it, expect } from 'vitest'
import { resolveOracle, DEFAULT_ORACLE, OracleSpecSchema } from '../../src/benchmark/oracle.js'

describe('resolveOracle', () => {
  it('falls back to golden and low volatility when nothing is declared', () => {
    expect(resolveOracle(undefined, undefined)).toEqual(DEFAULT_ORACLE)
    expect(DEFAULT_ORACLE.mode).toBe('golden')
    expect(DEFAULT_ORACLE.volatility).toBe('low')
  })

  it('takes the site default when the task declares nothing', () => {
    const site = { mode: 'paired-live' as const, volatility: 'high' as const }
    expect(resolveOracle(site, undefined)).toMatchObject({ mode: 'paired-live', volatility: 'high' })
  })

  it('lets a task override only the field it names and inherit the rest', () => {
    const site = { mode: 'paired-live' as const, volatility: 'high' as const, compare: { entities: 'set' as const, ordering: 'ignore' as const, fields: ['title'] } }
    const resolved = resolveOracle(site, { mode: 'golden' })
    expect(resolved.mode).toBe('golden')
    expect(resolved.volatility).toBe('high')
    expect(resolved.compare.fields).toEqual(['title'])
  })

  it('carries an opt-in semantics rule through, and leaves it absent by default', () => {
    expect(resolveOracle(undefined, undefined).semantics).toBeUndefined()
    const rule = { input: 'query', fields: ['title'], match: 'contains-token' as const, minShare: 0.5 }
    expect(resolveOracle({ semantics: rule }, undefined).semantics).toEqual(rule)
  })

  it('merges compare field by field rather than replacing it wholesale', () => {
    const site = { compare: { entities: 'set' as const, ordering: 'ignore' as const, fields: ['title', 'url'] } }
    const resolved = resolveOracle(site, { compare: { ordering: 'strict' } })
    expect(resolved.compare.ordering).toBe('strict')
    expect(resolved.compare.fields).toEqual(['title', 'url'])
  })
})

describe('OracleSpecSchema', () => {
  it('accepts a partial override', () => {
    expect(OracleSpecSchema.parse({ mode: 'golden' })).toEqual({ mode: 'golden' })
  })

  it('rejects property-based, which is reserved but not implemented', () => {
    expect(() => OracleSpecSchema.parse({ mode: 'property-based' })).toThrow()
  })

  it('rejects an unknown mode', () => {
    expect(() => OracleSpecSchema.parse({ mode: 'vibes' })).toThrow()
  })

  it('rejects a misspelled compare key instead of silently dropping it (I5)', () => {
    // `field` for `fields` used to parse to `{ compare: {} }`, silently widening
    // comparison to every field instead of the one the author named.
    expect(() => OracleSpecSchema.parse({ compare: { field: ['title'] } })).toThrow()
  })

  it('rejects a misspelled top-level key', () => {
    expect(() => OracleSpecSchema.parse({ volatilty: 'low' })).toThrow()
  })

  it('rejects a misspelled semantics key', () => {
    expect(() => OracleSpecSchema.parse({
      semantics: { input: 'query', field: ['title'], match: 'contains-token', minShare: 0.5 },
    })).toThrow()
  })
})
