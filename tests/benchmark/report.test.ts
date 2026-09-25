import { describe, it, expect } from 'vitest'
import { summarize, formatReport, type TaskRun } from '../../src/benchmark/report.js'
import { emptyMeta } from '../../src/types.js'

function run(over: Partial<TaskRun>): TaskRun {
  return {
    taskId: 't', site: 'siteA', set: 'controlled',
    meta: emptyMeta('http-json'), success: true, reasons: [],
    items: [], threw: false, blocked: false, ...over,
  }
}

const engine: TaskRun[] = [
  run({ taskId: 'c1', meta: { ...emptyMeta('http-json'), latencyMs: 100 } }),
  run({ taskId: 'c2', meta: { ...emptyMeta('http-json'), latencyMs: 200 } }),
  run({ taskId: 'c3', meta: { ...emptyMeta('browser'), latencyMs: 4000, browserLaunches: 1 }, success: false, reasons: ['x'] }),
  run({ taskId: 'w1', set: 'wild', site: 'crates.io', meta: { ...emptyMeta('http-json'), latencyMs: 400 } }),
  run({ taskId: 'w2', set: 'wild', site: 'crates.io', meta: { ...emptyMeta('browser'), latencyMs: 6000, browserLaunches: 1 } }),
]

const baseline: TaskRun[] = [
  run({ taskId: 'c1', meta: { ...emptyMeta('browser'), latencyMs: 3000, browserLaunches: 1 } }),
  run({ taskId: 'c2', meta: { ...emptyMeta('browser'), latencyMs: 3000, browserLaunches: 1 } }),
  run({ taskId: 'c3', meta: { ...emptyMeta('browser'), latencyMs: 3000, browserLaunches: 1 } }),
  run({ taskId: 'w1', set: 'wild', site: 'crates.io', meta: { ...emptyMeta('browser'), latencyMs: 8000, browserLaunches: 1 } }),
  run({ taskId: 'w2', set: 'wild', site: 'crates.io', meta: { ...emptyMeta('browser'), latencyMs: 8000, browserLaunches: 1 } }),
]

describe('summarize', () => {
  it('reports the two sets separately and never merges them', () => {
    const out = summarize(engine, baseline)
    expect(out.map((s) => s.set)).toEqual(['controlled', 'wild'])
    expect(out[0]!.tasks).toBe(3)
    expect(out[1]!.tasks).toBe(2)
  })

  it('counts browser avoidance as the share of runs that launched no browser', () => {
    const out = summarize(engine, baseline)
    expect(out[0]!.browserAvoidance).toBeCloseTo(2 / 3)
    expect(out[1]!.browserAvoidance).toBeCloseTo(1 / 2)
  })

  it('computes speedup from median latencies', () => {
    const out = summarize(engine, baseline)
    expect(out[0]!.medianLatencyMs).toBe(200)
    expect(out[0]!.speedup).toBeCloseTo(3000 / 200)
  })

  it('reports success rate against the golden, not against throwing', () => {
    const out = summarize(engine, baseline)
    expect(out[0]!.successRate).toBeCloseTo(2 / 3)
    expect(out[1]!.successRate).toBe(1)
  })
})

describe('formatReport', () => {
  it('prints the sets under separate headings with no combined total', () => {
    const text = formatReport(summarize(engine, baseline), { 'crates.io': 'allowed' })
    expect(text).toMatch(/Controlled/)
    expect(text).toMatch(/Wild/)
    expect(text).not.toMatch(/Combined|Overall|Total browser avoidance/i)
  })

  it('states the robots status of each wild site', () => {
    const text = formatReport(summarize(engine, baseline), { 'crates.io': 'allowed' })
    expect(text).toMatch(/crates\.io.*allowed/)
  })
})

describe('cost axes', () => {
  const cheap: TaskRun[] = [
    run({ taskId: 'c1', meta: { ...emptyMeta('http-html'), bytesDownloaded: 100 * 1024, networkRequests: 1, llmTokens: 400 } }),
    run({ taskId: 'c2', meta: { ...emptyMeta('http-html'), bytesDownloaded: 200 * 1024, networkRequests: 1, llmTokens: 600 } }),
  ]
  const costly: TaskRun[] = [
    run({ taskId: 'c1', meta: { ...emptyMeta('browser'), bytesDownloaded: 2000 * 1024, networkRequests: 90, llmTokens: 9000 } }),
    run({ taskId: 'c2', meta: { ...emptyMeta('browser'), bytesDownloaded: 3000 * 1024, networkRequests: 110, llmTokens: 11000 } }),
  ]

  it('reports bytes and requests against the baseline, not only latency', () => {
    const out = summarize(cheap, costly)[0]!
    expect(out.medianBytes).toBe(150 * 1024)
    expect(out.baselineMedianBytes).toBe(2500 * 1024)
    expect(out.medianRequests).toBe(1)
    expect(out.baselineMedianRequests).toBe(100)
  })

  it('prints the ratio the politeness posture rests on', () => {
    const text = formatReport(summarize(cheap, costly), {})
    expect(text).toMatch(/Data fetched:.*150KB.*baseline 2500KB.*16\.7x less/)
    expect(text).toMatch(/Requests:\s+1 median \(baseline 100\)/)
  })

  it('reports the tokens an agent would have to read, against the baseline', () => {
    const out = summarize(cheap, costly)[0]!
    expect(out.medianAgentTokens).toBe(500)
    expect(out.baselineMedianAgentTokens).toBe(10000)
  })

  it('prints what the agent reads, the quantity the project is about', () => {
    const text = formatReport(summarize(cheap, costly), {})
    expect(text).toMatch(/Agent reads:\s+500 tokens median \(baseline 10000\)\s+20\.0x less/)
  })

  // Tokens is the axis where the engine can lose: extracted item JSON can be
  // wordier than the page it came from, and the line has to say so.
  it('says more, not less, when the engine reads more than the baseline', () => {
    const wordy = cheap.map((r) => ({ ...r, meta: { ...r.meta, llmTokens: 20000 } }))
    const text = formatReport(summarize(wordy, costly), {})
    expect(text).toMatch(/Agent reads:\s+20000 tokens median \(baseline 10000\)\s+2\.0x more/)
  })
})

describe('blocked reporting', () => {
  const refused: TaskRun[] = [
    run({ taskId: 'b1', meta: { ...emptyMeta('browser'), browserLaunches: 1 }, blocked: true }),
    run({ taskId: 'b2', meta: { ...emptyMeta('browser'), browserLaunches: 1 }, blocked: true }),
    run({ taskId: 'b3' }),
  ]

  it('counts the engine runs the site refused', () => {
    expect(summarize(refused, refused)[0]!.blockedTasks).toBe(2)
  })

  it('prints the count, so a refusal is not read off the report as a rotted recipe', () => {
    const text = formatReport(summarize(refused, refused), {})
    expect(text).toContain('Blocked:           2 (site refused the recipe; ran on the browser)')
  })
})

it('keeps historical elapsed unavailable rather than substituting latency', () => {
  expect(summarize(engine, baseline)[0]!.medianElapsedMs).toBeNull()
  const measured = engine.map(r => ({ ...r, meta: { ...r.meta, elapsedMs: 1234 } }))
  expect(summarize(measured, baseline)[0]!.medianElapsedMs).toBe(1234)
  expect(formatReport(summarize(measured, baseline), {})).toMatch(/Actual elapsed:.*1234ms.*unavailable/)
})
