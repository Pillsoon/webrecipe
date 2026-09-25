import type { ExecutionMeta, Item, StrategyName } from '../types.js'
import { isEquivalent } from './grade.js'
import type { PairedRun } from './runner.js'

export type BenchSet = 'controlled' | 'wild'

/**
 * How much browser a task needed.
 *
 * The project's claim is not that it drives a browser better but that it
 * compiles work into a form that does not need one, so L0+L1 (browser-free) and
 * L0+L1+L2 (no cold launch) are different claims and are reported apart.
 */
export type Level = 'L0' | 'L1' | 'L2' | 'L3'

const LEVELS: Record<StrategyName, Level> = {
  'http-html': 'L0',
  'http-json': 'L1',
  'warm-browser': 'L2',
  browser: 'L3',
}

export const levelOf = (strategy: StrategyName): Level => LEVELS[strategy]

export interface TaskRun {
  taskId: string
  site: string
  set: BenchSet
  meta: ExecutionMeta
  /** Kept as the headline pass/fail: schema and semantic both hold. */
  success: boolean
  /** Ordering agreement, reported apart so site instability is not read as engine failure. */
  ordering?: boolean | null
  schema?: boolean
  reasons: string[]
  /** The items the run produced. Empty when it threw. */
  items: Item[]
  /** Whether the run threw rather than returning a result. */
  threw: boolean
  /** Whether the site refused the recipe, as opposed to the recipe having rotted. */
  blocked: boolean
}

export interface SetSummary {
  set: BenchSet
  tasks: number
  browserAvoidance: number
  /** Null when any row lacks actual boundary timing (historical data). */
  medianElapsedMs: number | null
  baselineMedianElapsedMs: number | null
  medianLatencyMs: number
  baselineMedianLatencyMs: number
  speedup: number
  /** Median of the per-site speedups, so one very fast site cannot carry the set. */
  medianSiteSpeedup: number
  successRate: number
  schemaRate: number
  /** Share of the tasks where ordering was judgeable and agreed. */
  orderingRate: number | null
  /** Tasks whose baseline was usable enough to grade the engine against. */
  usableTasks: number
  /** Tasks left out of every correctness figure below, for either exclusion cause. */
  excludedTasks: number
  /** Of those, excluded because the browser run itself was unusable. */
  excludedBaselineTasks: number
  /** Of those, excluded because no stored golden exists — the browser run may have been healthy. */
  excludedNoGoldenTasks: number
  entityRate: number
  /** Null when no oracle in the set declared a semantics rule. */
  querySemanticsRate: number | null
  querySemanticsJudged: number
  medianPolitenessWaitMs: number
  /** Bytes the engine had to fetch, against what the browser fetched for the same task. */
  medianBytes: number
  baselineMedianBytes: number
  /** Requests issued, the figure the politeness posture in spec section 6 rests on. */
  medianRequests: number
  baselineMedianRequests: number
  /** Tokens an agent would have to read, against what the browser would have made it read. */
  medianAgentTokens: number
  baselineMedianAgentTokens: number
  levels: Record<Level, number>
  /** L0 + L1: no browser was involved at all. */
  browserFree: number
  /** No launch observed on a completed task; independent of the final strategy. */
  fullBrowserAvoidance: number
  /** Engine runs the site refused, so their browser run is a refusal and not a regression. */
  blockedTasks: number
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

const share = <T>(rows: T[], predicate: (r: T) => boolean): number =>
  rows.length === 0 ? 0 : rows.filter(predicate).length / rows.length

export function summarize(runs: TaskRun[], baseline: TaskRun[]): SetSummary[] {
  const sets: BenchSet[] = ['controlled', 'wild']

  return sets.map((set) => {
    const mine = runs.filter((r) => r.set === set)
    const theirs = baseline.filter((r) => r.set === set)
    const medianLatencyMs = median(mine.map((r) => r.meta.latencyMs))
    const baselineMedianLatencyMs = median(theirs.map((r) => r.meta.latencyMs))

    const at = (level: Level): number => share(mine, (r) => levelOf(r.meta.strategy) === level)
    const sites = [...new Set(mine.map((r) => r.site))]
    const siteSpeedups = sites.map((site) => {
      const ours = median(mine.filter((r) => r.site === site).map((r) => r.meta.latencyMs))
      const theirsHere = median(theirs.filter((r) => r.site === site).map((r) => r.meta.latencyMs))
      return ours === 0 ? 0 : theirsHere / ours
    })

    return {
      set,
      tasks: mine.length,
      browserAvoidance: share(mine, (r) => r.meta.browserLaunches === 0 && !r.threw),
      medianSiteSpeedup: median(siteSpeedups),
      levels: { L0: at('L0'), L1: at('L1'), L2: at('L2'), L3: at('L3') },
      browserFree: share(mine, (r) => ['L0', 'L1'].includes(levelOf(r.meta.strategy))),
      fullBrowserAvoidance: share(mine, (r) => r.meta.browserLaunches === 0 && !r.threw),
      blockedTasks: mine.filter((r) => r.blocked).length,
      medianElapsedMs: mine.length > 0 && mine.every((r) => r.meta.elapsedMs !== undefined)
        ? median(mine.map((r) => r.meta.elapsedMs!)) : null,
      baselineMedianElapsedMs: theirs.length > 0 && theirs.every((r) => r.meta.elapsedMs !== undefined)
        ? median(theirs.map((r) => r.meta.elapsedMs!)) : null,
      medianLatencyMs,
      baselineMedianLatencyMs,
      speedup: medianLatencyMs === 0 ? 0 : baselineMedianLatencyMs / medianLatencyMs,
      successRate: share(mine, (r) => r.success),
      schemaRate: share(mine, (r) => r.schema !== false),
      // This path predates the oracle contract: it never marks a baseline
      // unusable, and it never declares a query-semantics rule.
      usableTasks: mine.length,
      excludedTasks: 0,
      excludedBaselineTasks: 0,
      excludedNoGoldenTasks: 0,
      entityRate: share(mine, (r) => r.schema !== false),
      querySemanticsRate: null,
      querySemanticsJudged: 0,
      orderingRate: (() => {
        const judged = mine.filter((r) => r.ordering !== null && r.ordering !== undefined)
        return judged.length === 0 ? null : share(judged, (r) => r.ordering === true)
      })(),
      medianPolitenessWaitMs: median(mine.map((r) => r.meta.politenessWaitMs)),
      medianBytes: median(mine.map((r) => r.meta.bytesDownloaded)),
      baselineMedianBytes: median(theirs.map((r) => r.meta.bytesDownloaded)),
      medianRequests: median(mine.map((r) => r.meta.networkRequests)),
      baselineMedianRequests: median(theirs.map((r) => r.meta.networkRequests)),
      medianAgentTokens: median(mine.map((r) => r.meta.llmTokens)),
      baselineMedianAgentTokens: median(theirs.map((r) => r.meta.llmTokens)),
    }
  })
}

/**
 * Summarises pairs rather than two independent lists.
 *
 * A task whose baseline was unusable leaves the equivalence denominator — the
 * engine cannot be blamed for a browser failure, and counting it as a pass
 * would be worse — but it never leaves the report.
 */
export function summarizePairs(pairs: PairedRun[]): SetSummary[] {
  const sets: BenchSet[] = ['controlled', 'wild']

  return sets.map((set) => {
    const mine = pairs.filter((p) => p.task.set === set)
    const usable = mine.filter((p) => p.grade.usable)
    const engineRuns = mine.map((p) => p.engine)
    const baselineRuns = mine.map((p) => p.baseline)

    const base = summarize(engineRuns, baselineRuns).find((s) => s.set === set)!
    const judgedOrdering = usable.filter((p) => p.grade.ordering !== null)
    const judgedQuery = usable.filter((p) => p.grade.query !== null)

    return {
      ...base,
      tasks: mine.length,
      usableTasks: usable.length,
      excludedTasks: mine.length - usable.length,
      // Two different reasons look identical as "not usable": a task with no
      // stored golden had a perfectly healthy browser run, and blaming that on
      // baseline validity is the exact confusion this split exists to end.
      excludedBaselineTasks: mine.filter((p) => p.grade.excludeReason === 'baseline').length,
      excludedNoGoldenTasks: mine.filter((p) => p.grade.excludeReason === 'no-golden').length,
      entityRate: share(usable, (p) => p.grade.entities === true),
      // Denominator is the tasks an oracle actually asked about, so an
      // undeclared rule cannot inflate the rate with unexamined passes.
      querySemanticsJudged: judgedQuery.length,
      querySemanticsRate: judgedQuery.length === 0 ? null : share(judgedQuery, (p) => p.grade.query === true),
      successRate: share(usable, (p) => isEquivalent(p.grade)),
      orderingRate: judgedOrdering.length === 0 ? null : share(judgedOrdering, (p) => p.grade.ordering === true),
    }
  })
}

export interface FailedPair {
  taskId: string
  reasons: string[]
}

/**
 * The tasks that were judged and did not pass, in the same terms the CLI
 * prints — extracted so the CLI cannot hand-copy `isEquivalent` and drift, the
 * way its old failure filter did.
 */
export function failedPairs(pairs: PairedRun[]): FailedPair[] {
  return pairs
    .filter((p) => p.grade.usable && !isEquivalent(p.grade))
    .map((p) => ({
      taskId: p.task.id,
      // `grade.reasons` holds only the oracle's verdict text; an engine that
      // timed out or fell back leaves that reason on the run itself, and a
      // printed failure line is useless without it.
      reasons: [...new Set([...p.grade.reasons, ...p.engine.reasons])],
    }))
}

export interface ExcludedPair {
  taskId: string
  reason: string | null
}

/** Tasks left out of the denominator for one specific cause, so the two never print under one heading. */
export function excludedBy(pairs: PairedRun[], cause: 'baseline' | 'no-golden'): ExcludedPair[] {
  return pairs
    .filter((p) => p.grade.excludeReason === cause)
    .map((p) => ({ taskId: p.task.id, reason: p.grade.validityReason }))
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`

/**
 * One cost axis, engine against baseline. Tokens is the first axis where the
 * engine can come out worse, so the direction is read off the numbers rather
 * than assumed to be a saving.
 */
const ratio = (engine: number, baseline: number): string => {
  if (engine === 0 || baseline === 0) return '—'
  return baseline >= engine ? `${(baseline / engine).toFixed(1)}x less` : `${(engine / baseline).toFixed(1)}x more`
}

export function formatReport(
  summaries: SetSummary[],
  robots: Record<string, string>,
  opts: { correctness?: boolean } = {},
): string {
  const { correctness = true } = opts
  const lines: string[] = []

  for (const s of summaries) {
    if (s.tasks === 0) continue
    lines.push(s.set === 'controlled' ? 'Controlled' : 'Wild')
    lines.push(`  Tasks:             ${s.tasks}`)
    lines.push(`  Browser-free:      ${pct(s.browserFree)}   (L0 + L1)`)
    lines.push(`  Full-browser avoidance: ${pct(s.fullBrowserAvoidance)}   (observed zero launches)`)
    if (s.medianElapsedMs !== null) {
      lines.push(`  Actual elapsed:    ${s.medianElapsedMs}ms median (baseline ${s.baselineMedianElapsedMs ?? 'unavailable'}ms)`)
      if (s.medianElapsedMs > 0 && s.baselineMedianElapsedMs !== null) {
        lines.push(`  Actual speedup:    ${(s.baselineMedianElapsedMs / s.medianElapsedMs).toFixed(1)}x`)
      }
    }
    lines.push(`  Levels:            L0 ${pct(s.levels.L0)}  L1 ${pct(s.levels.L1)}  L2 ${pct(s.levels.L2)}  L3 ${pct(s.levels.L3)}`)
    lines.push(`  Blocked:           ${s.blockedTasks} (site refused the recipe; ran on the browser)`)
    lines.push(`  Median latency:    ${s.medianLatencyMs}ms (baseline ${s.baselineMedianLatencyMs}ms; legacy attempt timing)`)
    lines.push(`  Median speedup:    ${s.speedup.toFixed(1)}x (legacy timing)`)
    lines.push(`  Median site speedup: ${s.medianSiteSpeedup.toFixed(1)}x`)
    lines.push(`  Politeness wait:   ${s.medianPolitenessWaitMs}ms median (excluded from latency above)`)
    // Latency is the noisiest of the three cost axes and was the only one
    // reported. Bytes and requests were instrumented from the first commit and
    // discarded on every run until held-out 3.
    const kb = (b: number): string => `${(b / 1024).toFixed(0)}KB`
    lines.push(`  Data fetched:      ${kb(s.medianBytes)} median (baseline ${kb(s.baselineMedianBytes)})  ${ratio(s.medianBytes, s.baselineMedianBytes)}`)
    lines.push(`  Requests:          ${s.medianRequests} median (baseline ${s.baselineMedianRequests})`)
    lines.push(`  Agent reads:       ${s.medianAgentTokens} tokens median (baseline ${s.baselineMedianAgentTokens})  ${ratio(s.medianAgentTokens, s.baselineMedianAgentTokens)}`)
    // A raw browser-only run (`bench run --baseline`) never grades an engine
    // against anything, so it has none of these figures to report — printing
    // them anyway would be four false labels, not one.
    if (correctness) {
      lines.push('  Correctness')
      lines.push(`    Baseline validity:  ${s.tasks - s.excludedBaselineTasks}/${s.tasks} usable          (${s.excludedBaselineTasks} excluded)`)
      lines.push(`    No stored golden:   ${s.excludedNoGoldenTasks} excluded`)
      lines.push(`    Entity equivalence: ${pct(s.entityRate)}`)
      lines.push(`    Query semantics:    ${s.querySemanticsRate === null ? 'not declared' : `${pct(s.querySemanticsRate)} of ${s.querySemanticsJudged} judgeable`}`)
      lines.push(`    Ordering:           ${s.orderingRate === null ? 'not judgeable' : `${pct(s.orderingRate)} where meaningful`}`)
    }
    lines.push('')
  }

  if (Object.keys(robots).length > 0) {
    lines.push('robots.txt status of wild sites')
    for (const [site, status] of Object.entries(robots)) lines.push(`  ${site}: ${status}`)
    lines.push('')
  }

  return lines.join('\n')
}
