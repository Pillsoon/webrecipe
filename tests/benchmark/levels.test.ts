import { describe, it, expect } from 'vitest'
import { levelOf, summarize, formatReport, type TaskRun } from '../../src/benchmark/report.js'
import { emptyMeta } from '../../src/types.js'

describe('levelOf', () => {
  it('maps each strategy onto its execution level', () => {
    expect(levelOf('http-html')).toBe('L0')
    expect(levelOf('http-json')).toBe('L1')
    expect(levelOf('warm-browser')).toBe('L2')
    expect(levelOf('browser')).toBe('L3')
  })
})

function run(over: Partial<TaskRun>): TaskRun {
  return {
    taskId: 't', site: 's', set: 'wild', meta: emptyMeta('http-json'), success: true, reasons: [],
    items: [], threw: false, blocked: false, ...over,
  }
}

const runs: TaskRun[] = [
  run({ taskId: 'a', site: 'x', meta: { ...emptyMeta('http-html'), latencyMs: 100 } }),
  run({ taskId: 'b', site: 'x', meta: { ...emptyMeta('http-json'), latencyMs: 100 } }),
  run({ taskId: 'c', site: 'y', meta: { ...emptyMeta('warm-browser'), latencyMs: 500 } }),
  run({ taskId: 'd', site: 'y', meta: { ...emptyMeta('browser'), latencyMs: 2000, browserLaunches: 1 } }),
]
const baseline: TaskRun[] = runs.map((r) => run({
  taskId: r.taskId, site: r.site, meta: { ...emptyMeta('browser'), latencyMs: 2000, browserLaunches: 1 },
}))

describe('level reporting', () => {
  it('counts the share of tasks at each level', () => {
    const wild = summarize(runs, baseline)[1]!
    expect(wild.levels).toEqual({ L0: 0.25, L1: 0.25, L2: 0.25, L3: 0.25 })
  })

  it('separates browser-free from full-browser avoidance', () => {
    const wild = summarize(runs, baseline)[1]!
    // L0+L1 never open a browser; L2 opens one but does not pay to start it.
    expect(wild.browserFree).toBeCloseTo(0.5)
    expect(wild.fullBrowserAvoidance).toBeCloseTo(0.75)
  })

  it('reports the median site speedup beside the overall one', () => {
    const wild = summarize(runs, baseline)[1]!
    // site x: median 100ms vs 2000ms = 20x. site y: median 1250ms vs 2000ms = 1.6x.
    expect(wild.medianSiteSpeedup).toBeCloseTo((20 + 1.6) / 2, 1)
    expect(wild.speedup).not.toBeCloseTo(wild.medianSiteSpeedup, 1)
  })

  it('prints both avoidance numbers and the level breakdown', () => {
    const text = formatReport(summarize(runs, baseline), {})
    expect(text).toMatch(/Browser-free/)
    expect(text).toMatch(/Full-browser avoidance/)
    expect(text).toMatch(/L0/)
    expect(text).toMatch(/Median site speedup/)
  })
})

it('does not classify a warm first launch or healing launch as full-browser avoidance', () => {
  const warm = run({ meta: { ...emptyMeta('warm-browser'), browserLaunches: 2 } })
  const reused = run({ meta: emptyMeta('warm-browser') })
  const failed = run({ threw: true })
  expect(summarize([warm, reused, failed], [])[1]!.fullBrowserAvoidance).toBeCloseTo(1 / 3)
})
