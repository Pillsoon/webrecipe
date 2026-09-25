import { describe, it, expect } from 'vitest'
import { gradeByOracle } from '../../src/benchmark/runner.js'
import type { BenchTask } from '../../src/benchmark/runner.js'
import type { TaskRun } from '../../src/benchmark/report.js'
import type { Golden } from '../../src/benchmark/golden.js'
import { resolveOracle } from '../../src/benchmark/oracle.js'
import { emptyMeta } from '../../src/types.js'

function run(over: Partial<TaskRun>): TaskRun {
  return {
    taskId: 't', site: 's', set: 'wild', meta: emptyMeta('http-html'),
    success: true, reasons: [], items: [], threw: false, blocked: false, ...over,
  }
}

function task(over: Partial<BenchTask> = {}): BenchTask {
  return { id: 't', set: 'wild', site: 's', intent: 'search', input: { query: 'x' }, ...over }
}

const pairedLive = resolveOracle({ mode: 'paired-live', compare: { ordering: 'ignore' } }, undefined)
const golden = resolveOracle({ mode: 'golden' }, undefined)

describe('gradeByOracle: a crashed engine is never scored a pass (C1)', () => {
  it('paired-live: does not read an expectEmpty pass off two empty item lists', () => {
    const baseline = run({ items: [] }) // legitimately empty: the task expects that
    const engine = run({ items: [], threw: true, reasons: ['boom'] })
    const grade = gradeByOracle(pairedLive, undefined, baseline, engine, task({ expectEmpty: true }))
    expect(grade.usable).toBe(true) // the baseline itself was fine
    expect(grade.entities).toBe(false)
    expect(grade.reasons).toContain('boom')
  })

  it('golden: does not read an expectEmpty pass off an empty stored golden', () => {
    const stored: Golden = { taskId: 't', capturedAt: 'x', items: [] }
    const baseline = run({ items: [] })
    const engine = run({ items: [], threw: true, reasons: ['boom'] })
    const grade = gradeByOracle(golden, stored, baseline, engine, task({ expectEmpty: true }))
    expect(grade.usable).toBe(true)
    expect(grade.entities).toBe(false)
    expect(grade.reasons).toContain('boom')
  })

  it('paired-live: a thrown engine against a non-empty baseline is still entities:false with the exception text', () => {
    const baseline = run({ items: [{ title: 'Alpha' }] })
    const engine = run({ items: [], threw: true, reasons: ['timed out after 30s'] })
    const grade = gradeByOracle(pairedLive, undefined, baseline, engine, task())
    expect(grade.entities).toBe(false)
    expect(grade.reasons).toEqual(['timed out after 30s'])
  })
})

describe('gradeByOracle: direct coverage of the golden branch (I3)', () => {
  it('baseline threw, engine matches the golden -> passes; the baseline never gates golden mode', () => {
    const stored: Golden = { taskId: 't', capturedAt: 'x', items: [{ title: 'Alpha' }] }
    const baseline = run({ items: [], threw: true, reasons: ['browser timeout'] })
    const engine = run({ items: [{ title: 'Alpha' }] })
    const grade = gradeByOracle(golden, stored, baseline, engine, task())
    expect(grade.usable).toBe(true)
    expect(grade.entities).toBe(true)
  })

  it('baseline fine, engine mismatches the golden -> fails', () => {
    const stored: Golden = { taskId: 't', capturedAt: 'x', items: [{ title: 'Alpha' }] }
    const baseline = run({ items: [{ title: 'Alpha' }] })
    const engine = run({ items: [{ title: 'Beta' }] })
    const grade = gradeByOracle(golden, stored, baseline, engine, task())
    expect(grade.usable).toBe(true)
    expect(grade.entities).toBe(false)
  })

  it('excludes with its own reason when no golden is stored, regardless of how healthy the runs were', () => {
    const baseline = run({ items: [{ title: 'Alpha' }] })
    const engine = run({ items: [{ title: 'Alpha' }] })
    const grade = gradeByOracle(golden, undefined, baseline, engine, task())
    expect(grade.usable).toBe(false)
    expect(grade.excludeReason).toBe('no-golden')
  })

  it('honours oracle.compare.fields, so drift in a field the oracle does not score does not fail the engine (I2)', () => {
    const fieldsOracle = resolveOracle({ mode: 'golden', compare: { fields: ['title'] } }, undefined)
    const stored: Golden = { taskId: 't', capturedAt: 'x', items: [{ title: 'Alpha', votes: 10 }] }
    const baseline = run({ items: [{ title: 'Alpha', votes: 10 }] })
    const engine = run({ items: [{ title: 'Alpha', votes: 999 }] })
    const grade = gradeByOracle(fieldsOracle, stored, baseline, engine, task())
    expect(grade.entities).toBe(true)
  })
})

describe('gradeByOracle: paired-live baseline validity gates before layer two (I3)', () => {
  it('an invalid baseline excludes the task without judging the engine at all', () => {
    const baseline = run({ items: [], threw: true })
    const engine = run({ items: [{ title: 'Alpha' }] })
    const grade = gradeByOracle(pairedLive, undefined, baseline, engine, task())
    expect(grade.usable).toBe(false)
    expect(grade.excludeReason).toBe('baseline')
    expect(grade.entities).toBeNull()
  })
})
