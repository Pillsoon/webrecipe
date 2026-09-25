import { describe, it, expect } from 'vitest'
import { ORACLES } from '../../benchmark/oracles.js'
import { OracleSpecSchema, resolveOracle } from '../../src/benchmark/oracle.js'
import { PLANS } from '../../benchmark/plans.js'

describe('ORACLES', () => {
  it('parses against the schema', () => {
    for (const [site, spec] of Object.entries(ORACLES)) {
      expect(() => OracleSpecSchema.parse(spec), site).not.toThrow()
    }
  })

  it('only names sites that have a browser plan', () => {
    for (const site of Object.keys(ORACLES)) expect(PLANS[site], site).toBeDefined()
  })

  it('puts the job boards on paired-live, since their listings rotate in minutes', () => {
    for (const site of ['remoteok.com', 'arbeitnow.com']) {
      expect(resolveOracle(ORACLES[site], undefined).mode).toBe('paired-live')
    }
  })

  it('declares a semantics rule only for the site known to ignore its input', () => {
    const declared = Object.entries(ORACLES).filter(([, spec]) => spec.semantics !== undefined)
    expect(declared.map(([site]) => site)).toEqual(['arbeitnow.com'])
  })

  it('leaves a stable site on golden', () => {
    expect(resolveOracle(ORACLES['docs.rs'], undefined).mode).toBe('golden')
  })

  it('gives an undeclared site the golden default', () => {
    expect(resolveOracle(ORACLES['not-a-site'], undefined).mode).toBe('golden')
  })
})
