import { describe, it, expect } from 'vitest'
import { summarizePairs, formatReport, failedPairs, excludedBy } from '../../src/benchmark/report.js'
import { isEquivalent } from '../../src/benchmark/grade.js'
import type { PairedRun } from '../../src/benchmark/runner.js'
import { DEFAULT_ORACLE } from '../../src/benchmark/oracle.js'
import { emptyMeta } from '../../src/types.js'

function pair(id: string, grade: Partial<PairedRun['grade']>, engineReasons: string[] = []): PairedRun {
  // TaskRun.items/threw are required (task 3); a graded run always finished.
  const run = { taskId: id, site: 's', set: 'wild' as const, meta: emptyMeta('http-html'), success: true, reasons: [], items: [], threw: false, blocked: false }
  return {
    task: { id, set: 'wild', site: 's', intent: 'search', input: {} } as PairedRun['task'],
    oracle: DEFAULT_ORACLE,
    baseline: { ...run, meta: { ...emptyMeta('browser'), latencyMs: 1000, browserLaunches: 1 } },
    engine: { ...run, reasons: engineReasons, meta: { ...emptyMeta('http-html'), latencyMs: 100 } },
    aging: null,
    grade: { usable: true, validityReason: null, excludeReason: null, entities: true, query: null, ordering: null, reasons: [], ...grade },
  }
}

describe('summarizePairs', () => {
  const pairs = [
    pair('a', {}),
    pair('b', { entities: false, reasons: ['3 unexpected'] }),
    pair('c', { usable: false, validityReason: 'baseline threw', excludeReason: 'baseline', entities: null, query: null }),
    pair('d', { query: false }),
  ]

  it('excludes an unusable baseline from the denominator', () => {
    const wild = summarizePairs(pairs)[1]!
    expect(wild.tasks).toBe(4)
    expect(wild.usableTasks).toBe(3)
    expect(wild.excludedTasks).toBe(1)
  })

  it('splits the exclusion count by cause, so a healthy-but-golden-less task is not counted as a baseline problem', () => {
    const withNoGolden = [...pairs, pair('e', {
      usable: false, validityReason: 'no stored golden for this task', excludeReason: 'no-golden', entities: null, query: null,
    })]
    const wild = summarizePairs(withNoGolden)[1]!
    expect(wild.excludedTasks).toBe(2)
    expect(wild.excludedBaselineTasks).toBe(1)
    expect(wild.excludedNoGoldenTasks).toBe(1)
  })

  it('rates entities over the usable tasks', () => {
    expect(summarizePairs(pairs)[1]!.entityRate).toBeCloseTo(2 / 3)
  })

  it('rates query semantics only over the tasks an oracle asked about', () => {
    const wild = summarizePairs(pairs)[1]!
    // Of the three usable pairs, 'd' is the only one with a declared verdict.
    expect(wild.querySemanticsJudged).toBe(1)
    expect(wild.querySemanticsRate).toBe(0)
  })

  it('reports no rate at all when nothing declared a rule', () => {
    const none = summarizePairs([pair('a', {}), pair('b', {})])[1]!
    expect(none.querySemanticsJudged).toBe(0)
    expect(none.querySemanticsRate).toBeNull()
  })

  it('treats engine equivalence as entities passing and query not failing', () => {
    const wild = summarizePairs(pairs)[1]!
    // 'a' passes both; 'b' fails entities; 'd' fails query. Unjudged is not a failure.
    expect(wild.successRate).toBeCloseTo(1 / 3)
  })

  it('agrees with isEquivalent exactly, since successRate is defined in terms of it', () => {
    const wild = summarizePairs(pairs)[1]!
    const usable = pairs.filter((p) => p.grade.usable)
    expect(wild.successRate).toBeCloseTo(usable.filter((p) => isEquivalent(p.grade)).length / usable.length)
  })
})

describe('formatReport with pairs', () => {
  const withNoGolden = [
    pair('a', {}),
    pair('b', { usable: false, validityReason: 'baseline threw', excludeReason: 'baseline', entities: null, query: null }),
    pair('e', { usable: false, validityReason: 'no stored golden for this task', excludeReason: 'no-golden', entities: null, query: null }),
  ]

  it('prints all four correctness lines and names the exclusions', () => {
    const text = formatReport(summarizePairs(withNoGolden), {})
    expect(text).toMatch(/Baseline validity/)
    expect(text).toMatch(/Entity equivalence/)
    expect(text).toMatch(/Query semantics/)
    expect(text).toMatch(/Ordering/)
    expect(text).toMatch(/1 excluded/)
  })

  it('prints the no-golden exclusions under their own heading, separate from baseline validity', () => {
    const text = formatReport(summarizePairs(withNoGolden), {})
    expect(text).toMatch(/No stored golden:\s*1 excluded/)
    // Baseline validity's own count must not have absorbed the no-golden one.
    expect(text).toMatch(/Baseline validity:\s*2\/3 usable\s*\(1 excluded\)/)
  })

  it('omits the correctness block entirely when the run graded no engine', () => {
    const text = formatReport(summarizePairs(withNoGolden), {}, { correctness: false })
    expect(text).not.toMatch(/Correctness/)
    expect(text).not.toMatch(/Baseline validity/)
    expect(text).not.toMatch(/Entity equivalence/)
  })
})

describe('failedPairs', () => {
  it('carries the engine run\'s own reasons alongside the grade\'s, so an exception is never invisible', () => {
    const pairs = [pair('a', { entities: false, reasons: ['3 unexpected'] }, ['request timed out'])]
    const failed = failedPairs(pairs)
    expect(failed).toHaveLength(1)
    expect(failed[0]!.reasons).toEqual(expect.arrayContaining(['3 unexpected', 'request timed out']))
  })

  it('excludes unusable tasks, which are unjudged rather than failed', () => {
    const pairs = [pair('a', { usable: false, validityReason: 'baseline threw', excludeReason: 'baseline', entities: null, query: null })]
    expect(failedPairs(pairs)).toHaveLength(0)
  })
})

describe('excludedBy', () => {
  it('separates the two exclusion causes rather than reporting them under one list', () => {
    const pairs = [
      pair('a', { usable: false, validityReason: 'baseline threw', excludeReason: 'baseline', entities: null, query: null }),
      pair('b', { usable: false, validityReason: 'no stored golden for this task', excludeReason: 'no-golden', entities: null, query: null }),
    ]
    expect(excludedBy(pairs, 'baseline').map((e) => e.taskId)).toEqual(['a'])
    expect(excludedBy(pairs, 'no-golden').map((e) => e.taskId)).toEqual(['b'])
  })
})
