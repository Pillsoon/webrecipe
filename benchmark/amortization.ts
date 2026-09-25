/**
 * From which repetition is a learned HTTP replay cheaper than opening a
 * browser every time?
 *
 * Arm A (webrecipe): learn + teach once in a browser, then `run` k times over the
 * compiled recipe. Arm B: the same taught plan executed in a fresh browser on
 * every repetition, with no LLM cost — a "new browser each time, no LLM"
 * control, not a bound on every browser-based approach.
 *
 * Both arms are held to the same access policy: one page load per host per
 * interval (robots Crawl-delay, else 1s), counted across both arms and across
 * preparation, so a fast arm cannot win by ignoring what the slow arm honours.
 * Waiting for that gate is recorded apart from processing time.
 *
 *   pnpm exec tsx benchmark/amortization.ts [--reps 20] [--out DIR] [--only hn]
 *
 * `--out` must not exist yet: a run's raw records are never overwritten.
 * `--from DIR` rewrites DIR/REPORT.md from its runs.jsonl and first-time.json without running anything.
 */
import { mkdir, writeFile, appendFile, access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { learnFromHtml } from '../src/authoring/learn.js'
import { captureDom } from '../src/authoring/snapshot.js'
import { parseRobots } from '../src/net/robots.js'
import { teach } from '../src/authoring/teach.js'
import { loadLearnedPlans, mergePlans } from '../src/authoring/plans.js'
import { buildEngine } from '../src/wiring.js'
import { BrowserStrategy } from '../src/executor/strategies/browser.js'
import { measureResult } from '../src/measurement.js'
import { emptyMeta, type ExecutionMeta, type Intent, type Item } from '../src/types.js'
import type { Recipe } from '../src/recipes/schema.js'
import { PLANS } from './plans.js'

/** One line per item, keys sorted, so two reads can be compared as sets. */
const normalize = (item: Item): string =>
  JSON.stringify(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v ?? null]))

interface Spec { id: string; site: string; intent: Intent; url: string; input: Record<string, string>; items: string; fields: Record<string, string> }

/** The three reads already in daily use; selectors as taught on 2026-09-21. */
const SPECS: Spec[] = [
  { id: 'hn', site: 'hn-newest', intent: 'list', url: 'https://news.ycombinator.com/newest', input: {},
    items: 'tr.athing', fields: { id: '@id', title: 'span.titleline > a', url: 'span.titleline > a@href' } },
  { id: 'remoteok', site: 'remoteok-jobs', intent: 'search', url: 'https://remoteok.com/remote-python-jobs', input: { query: 'python' },
    items: 'tr.job[data-url]', fields: { title: 'h2', company: 'h3', url: '@data-url' } },
  { id: 'steam', site: 'steam-factorio-us', intent: 'detail', url: 'https://store.steampowered.com/app/427520/Factorio/?cc=us&l=english', input: {},
    items: '#game_area_purchase_section_add_to_cart_88199', fields: { product: 'h2.title', displayedPrice: '.game_purchase_price, .discount_final_price' } },
]

interface RunRecord {
  task: string; arm: 'A' | 'B'; k: number; at: string
  /** Includes gate and politeness waits. */
  wallMs: number
  /** Time spent waiting for the shared per-host access gate before starting. Absent in runs before the gate existed. */
  gateWaitMs?: number
  meta: ExecutionMeta
  items: number
  ok: boolean
  error?: string
  recipeUsed?: boolean
  fellBack?: boolean
  normalized: string[]
}

interface FirstTime {
  task: string; learnMs: number; teachMs: number; meta: ExecutionMeta; recipe: string | null; refused: string | null
  /** learn split: page load in a browser, then candidate generation and field candidates on the captured HTML. Absent in older records. */
  learnPhases?: { loadMs: number; candidatesMs: number; fieldsMs: number; htmlBytes: number }
  gateWaitMs?: { learn: number; teach: number }
  /** The interval both arms were held to for this host, in ms. */
  accessIntervalMs?: number
}

const args = process.argv.slice(2)
const arg = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1] ?? fallback }
const REPS = Number(arg('reps', '20'))
const OUT = resolve(arg('out', join('benchmark', 'results', `amortization-${new Date().toISOString().slice(0, 10)}`)))
const ONLY = arg('only', '')
const FROM = arg('from', '')
const GAP_MS = 1000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()

/**
 * One page load per host per interval, whichever arm or phase asks. Spacing is
 * between starts, as the engine's own politeness layer does it, so A's internal
 * wait stays near zero once this gate has been honoured.
 */
class AccessGate {
  private readonly lastStart = new Map<string, number>()
  private readonly intervals = new Map<string, number>()
  async intervalFor(url: string): Promise<number> {
    const { host, origin } = new URL(url)
    let interval = this.intervals.get(host)
    if (interval === undefined) {
      const text = await fetch(new URL('/robots.txt', origin)).then((r) => (r.ok ? r.text() : '')).catch(() => '')
      const delay = parseRobots(text).crawlDelaySec
      interval = Math.max(GAP_MS, delay === null ? 0 : delay * 1000)
      this.intervals.set(host, interval)
    }
    return interval
  }
  /** Waits until this host may be loaded again, then marks the start. Returns the wait. */
  async take(url: string): Promise<number> {
    const { host } = new URL(url)
    const interval = await this.intervalFor(url)
    const last = this.lastStart.get(host)
    const wait = last === undefined ? 0 : Math.max(0, interval - (performance.now() - last))
    if (wait > 0) await sleep(wait)
    this.lastStart.set(host, performance.now())
    return Math.round(wait)
  }
}

async function regenerate(dir: string) {
  const firstTimes = JSON.parse(await readFile(join(dir, 'first-time.json'), 'utf8')) as FirstTime[]
  const runs = (await readFile(join(dir, 'runs.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as RunRecord)
  await writeFile(join(dir, 'REPORT.md'), report(firstTimes, runs))
  console.log(join(dir, 'REPORT.md'))
}

async function main() {
  if (FROM !== '') return regenerate(resolve(FROM))
  if (await access(OUT).then(() => true, () => false)) throw new Error(`${OUT} exists; pick a new --out so earlier raw records are kept`)
  const data = join(OUT, 'data')
  await mkdir(data, { recursive: true })
  const runsPath = join(OUT, 'runs.jsonl')
  await writeFile(runsPath, '')
  const firstTimes: FirstTime[] = []
  const runs: RunRecord[] = []
  const log = (line: string) => console.error(`${now()} ${line}`)
  const gate = new AccessGate()

  for (const spec of SPECS.filter((s) => ONLY === '' || s.id === ONLY)) {
    // First-time cost, arm A only: what a person pays before the first replay.
    // learn is split into its phases here so a slow learn can be read without a second experiment.
    const accessIntervalMs = await gate.intervalFor(spec.url)
    const learnGate = await gate.take(spec.url)
    const t0 = performance.now()
    const learned = await measureResult('browser', async () => {
      const l0 = performance.now()
      const { html } = await captureDom(spec.url)
      const loadMs = Math.round(performance.now() - l0)
      const c0 = performance.now()
      const report = learnFromHtml(spec.url, html)
      // learnFromHtml = generateCandidates + fieldCandidates over the top candidates; candidates alone is re-timed
      // on the same HTML so the two can be told apart. The re-run is deterministic and not part of learnMs.
      const analyzeMs = Math.round(performance.now() - c0)
      return { report, loadMs, analyzeMs, html, meta: emptyMeta('browser') }
    })
    const learnMs = Math.round(performance.now() - t0)
    const { generateCandidates } = await import('../src/authoring/candidates.js')
    const cc0 = performance.now(); generateCandidates(learned.html); const candidatesMs = Math.round(performance.now() - cc0)
    const learnPhases = { loadMs: learned.loadMs, candidatesMs, fieldsMs: learned.analyzeMs - candidatesMs, htmlBytes: learned.html.length }
    log(`${spec.id} learn ${learnMs}ms (gate ${learnGate}ms; load ${learnPhases.loadMs}, candidates ~${candidatesMs}, fields ~${learnPhases.fieldsMs}; ${learned.report.items.length} candidates)`)

    const teachGate = await gate.take(spec.url)
    const t1 = performance.now()
    const taught = await measureResult('browser', async () => ({ ...await teach({
      site: spec.site, intent: spec.intent, url: spec.url, input: spec.input,
      itemSelector: spec.items, fields: spec.fields, planDir: join(data, 'plans'), recipeDir: join(data, 'recipes'),
    }), meta: emptyMeta('browser') }))
    const teachMs = Math.round(performance.now() - t1)
    const first: FirstTime = {
      task: spec.id, learnMs, teachMs, meta: { ...taught.meta, elapsedMs: (learned.meta.elapsedMs ?? 0) + (taught.meta.elapsedMs ?? 0),
        browserLaunches: learned.meta.browserLaunches + taught.meta.browserLaunches,
        networkRequests: learned.meta.networkRequests + taught.meta.networkRequests,
        bytesDownloaded: learned.meta.bytesDownloaded + taught.meta.bytesDownloaded },
      recipe: taught.recipe?.strategy.type ?? null, refused: taught.refused,
      learnPhases, gateWaitMs: { learn: learnGate, teach: teachGate }, accessIntervalMs,
    }
    firstTimes.push(first)
    log(`${spec.id} teach ${teachMs}ms recipe=${first.recipe ?? `none (${first.refused})`}`)

    const plans = await loadLearnedPlans(join(data, 'plans'))
    const merged = mergePlans(PLANS, plans.plans)
    const engine = buildEngine({ recipeDir: join(data, 'recipes'), plans: merged, origins: plans.origins })
    // No accessibility-snapshot token count: it is a page read of its own and would be charged to B's wall time.
    const browserArm = new BrowserStrategy(engine.sites, merged, false)
    const task = { id: spec.id, site: spec.site, intent: spec.intent, input: spec.input }

    const runA = async (k: number): Promise<RunRecord> => {
      const at = now(); const s = performance.now()
      const gateWaitMs = await gate.take(spec.url)
      try {
        const o = await engine.executor.run(task)
        return { task: spec.id, arm: 'A', k, at, wallMs: Math.round(performance.now() - s), gateWaitMs, meta: o.meta, items: o.items.length, ok: o.items.length > 0,
          recipeUsed: o.recipeUsed, fellBack: o.fellBack, normalized: o.items.map(normalize) }
      } catch (error) {
        return { task: spec.id, arm: 'A', k, at, wallMs: Math.round(performance.now() - s), gateWaitMs, meta: emptyMeta('http-html'), items: 0, ok: false, error: String((error as Error).message), normalized: [] }
      }
    }
    const runB = async (k: number): Promise<RunRecord> => {
      const at = now(); const s = performance.now()
      const gateWaitMs = await gate.take(spec.url)
      try {
        const r = await browserArm.execute({} as Recipe, task)
        return { task: spec.id, arm: 'B', k, at, wallMs: Math.round(performance.now() - s), gateWaitMs, meta: r.meta, items: r.items.length, ok: r.items.length > 0, normalized: (r.items as Item[]).map(normalize) }
      } catch (error) {
        return { task: spec.id, arm: 'B', k, at, wallMs: Math.round(performance.now() - s), gateWaitMs, meta: emptyMeta('browser'), items: 0, ok: false, error: String((error as Error).message), normalized: [] }
      }
    }

    try {
      for (let k = 1; k <= REPS; k++) {
        // Alternate which arm goes first so neither always sees the fresher page.
        const order = k % 2 === 1 ? [runA, runB] : [runB, runA]
        for (const run of order) {
          const record = await run(k)
          runs.push(record)
          await appendFile(runsPath, `${JSON.stringify(record)}\n`)
          log(`${spec.id} ${record.arm} k=${k} ${record.wallMs}ms (gate ${record.gateWaitMs}ms, politeness ${record.meta.politenessWaitMs}ms) items=${record.items} browser=${record.meta.browserLaunches}${record.fellBack ? ' FELL_BACK' : ''}${record.error ? ` ERROR ${record.error}` : ''}`)
        }
      }
    } finally { await engine.warm.close() }
  }

  await writeFile(join(OUT, 'first-time.json'), JSON.stringify(firstTimes, null, 2))
  await writeFile(join(OUT, 'REPORT.md'), report(firstTimes, runs))
  console.log(join(OUT, 'REPORT.md'))
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]! }
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const sec = (ms: number) => (ms / 1000).toFixed(1)

function jaccard(a: string[], b: string[]): number {
  const [sa, sb] = [new Set(a), new Set(b)]
  const union = new Set([...sa, ...sb])
  if (union.size === 0) return 1
  return [...sa].filter((x) => sb.has(x)).length / union.size
}

function report(firstTimes: FirstTime[], runs: RunRecord[]): string {
  const lines: string[] = [
    '# Amortization: learned HTTP replay vs a browser every time',
    '',
    `Run: ${now()}. Repetitions per task: ${REPS}, arms alternated, ${GAP_MS}ms between runs.`,
    '',
    'Arm A is webrecipe: learn + teach once (browser), then `run` over the compiled recipe.',
    'Arm B runs the same taught plan in a fresh browser every time. B has no LLM',
    'latency or tokens, so it is a **lower bound** on a browser agent, not an agent.',
    'Wall times are in-process around each call; Node startup is excluded for both.',
    '"Agreement" is Jaccard overlap of A and B items in the same repetition — the',
    'page changes between the two reads, so this is consistency, **not correctness**.',
    '',
  ]
  for (const first of firstTimes) {
    const A = runs.filter((r) => r.task === first.task && r.arm === 'A')
    const B = runs.filter((r) => r.task === first.task && r.arm === 'B')
    const firstMs = first.learnMs + first.teachMs
    const cumA = (k: number) => firstMs + sum(A.slice(0, k).map((r) => r.wallMs))
    const cumB = (k: number) => sum(B.slice(0, k).map((r) => r.wallMs))
    // Politeness waits are a policy webrecipe applies to its own HTTP requests (per-host
    // spacing, robots Crawl-delay); the browser arm applies none. Shown apart so the
    // reader can see both the policy cost and the raw request cost.
    const waitOf = (r: RunRecord) => r.meta.politenessWaitMs + (r.gateWaitMs ?? 0)
    const processing = (r: RunRecord) => r.wallMs - waitOf(r)
    const waitA = (k: number) => sum(A.slice(0, k).map(waitOf))
    const waitB = (k: number) => sum(B.slice(0, k).map(waitOf))
    const ks = [...new Set([1, 3, 5, 10, REPS].filter((k) => k <= REPS))].sort((a, b) => a - b)
    const breakEven = A.map((_, i) => i + 1).find((k) => cumA(k) <= cumB(k)) ?? null
    const last = A.length
    const holds = (cum: (k: number) => number) => cum(last) <= cumB(last)
    const ranges = (rs: RunRecord[]) => rs.filter((r) => !r.ok).map((r) => r.k).join(', ') || 'none'
    const meanA = mean(A.map((r) => r.wallMs)), meanB = mean(B.map((r) => r.wallMs))
    const extrapolated = meanB > meanA ? Math.ceil(firstMs / (meanB - meanA)) : null
    // Both arms extract the same fields, so an agent reads the same TSV either way; no token row.
    const cumAKnown = (k: number) => cumA(k) - first.learnMs
    const breakEvenKnown = A.map((_, i) => i + 1).find((k) => cumAKnown(k) <= cumB(k)) ?? null
    const agreement = A.map((a) => jaccard(a.normalized, B.find((b) => b.k === a.k)?.normalized ?? []))

    lines.push(`## ${first.task}`, '',
      `First-time cost (A only): learn ${sec(first.learnMs)}s + teach ${sec(first.teachMs)}s = **${sec(firstMs)}s**, ${first.meta.browserLaunches} browser launch(es), ${first.meta.networkRequests} requests. Recipe: ${first.recipe ?? `none — ${first.refused}`}.`,
      first.learnPhases ? `learn split: page load ${sec(first.learnPhases.loadMs)}s, candidate generation ~${sec(first.learnPhases.candidatesMs)}s, field candidates ~${sec(first.learnPhases.fieldsMs)}s (${Math.round(first.learnPhases.htmlBytes / 1024)} KB HTML; the split re-times candidate generation on the same HTML). Gate waits before learn/teach: ${first.gateWaitMs?.learn ?? 0}/${first.gateWaitMs?.teach ?? 0} ms.` : 'learn phases not recorded in this run.',
      first.accessIntervalMs !== undefined ? `Access policy: one page load per ${first.accessIntervalMs} ms on this host, applied to learn, teach and every repetition of both arms (teach's probe requests follow A's own politeness layer).` : 'Access policy: none applied to B in this run (A honoured its own politeness layer); this run is a policy-asymmetric experiment.',
      `Counting preparation, A launched ${first.meta.browserLaunches} browser(s) in total; B launched ${B.length}. "Zero browser launches" holds for the replays only.`, '',
      '| per repetition | A (webrecipe) | B (browser each time) |', '| --- | ---: | ---: |',
      `| wall ms incl. waits, median (min–max) | ${median(A.map((r) => r.wallMs))} (${Math.min(...A.map((r) => r.wallMs))}–${Math.max(...A.map((r) => r.wallMs))}) | ${median(B.map((r) => r.wallMs))} (${Math.min(...B.map((r) => r.wallMs))}–${Math.max(...B.map((r) => r.wallMs))}) |`,
      `| processing ms (wall − waits), median (min–max) | ${median(A.map(processing))} (${Math.min(...A.map(processing))}–${Math.max(...A.map(processing))}) | ${median(B.map(processing))} (${Math.min(...B.map(processing))}–${Math.max(...B.map(processing))}) |`,
      `| browser launches, total | ${sum(A.map((r) => r.meta.browserLaunches))} | ${sum(B.map((r) => r.meta.browserLaunches))} |`,
      `| network requests, median | ${median(A.map((r) => r.meta.networkRequests))} | ${median(B.map((r) => r.meta.networkRequests))} |`,
      `| bytes downloaded, median | ${median(A.map((r) => r.meta.bytesDownloaded))} | ${median(B.map((r) => r.meta.bytesDownloaded))} |`,
      `| runs with items / total | ${A.filter((r) => r.ok).length}/${A.length} | ${B.filter((r) => r.ok).length}/${B.length} |`,
      `| A fell back to a browser | ${A.filter((r) => r.fellBack).length} | — |`,
      `| gate wait ms, median | ${median(A.map((r) => r.gateWaitMs ?? 0))} | ${median(B.map((r) => r.gateWaitMs ?? 0))} |`,
      `| A's own politeness wait ms, median | ${median(A.map((r) => r.meta.politenessWaitMs))} | — |`,
      `| A–B agreement, median (min) | ${median(agreement).toFixed(2)} (${Math.min(...agreement).toFixed(2)}) | |`,
      '',
      `| cumulative wall time | ${ks.map((k) => `k=${k}`).join(' | ')} | k=100 (extrapolated from means) |`, `| --- | ${ks.map(() => '---:').join(' | ')} | ---: |`,
      `| A, page investigated first (learn + teach) | ${ks.map((k) => sec(cumA(k)) + 's').join(' | ')} | ${sec(firstMs + 100 * meanA)}s |`,
      `| A, selectors already known (teach only) | ${ks.map((k) => sec(cumAKnown(k)) + 's').join(' | ')} | ${sec(first.teachMs + 100 * meanA)}s |`,
      `| A, processing only (no waits) | ${ks.map((k) => sec(cumA(k) - waitA(k)) + 's').join(' | ')} | ${sec(firstMs + 100 * mean(A.map(processing)))}s |`,
      `| B | ${ks.map((k) => sec(cumB(k)) + 's').join(' | ')} | ${sec(100 * meanB)}s |`,
      `| B, processing only (no waits) | ${ks.map((k) => sec(cumB(k) - waitB(k)) + 's').join(' | ')} | ${sec(100 * mean(B.map(processing)))}s |`,
      '',
      `Repetitions without items: A ${ranges(A)}; B ${ranges(B)}. A repetition without items is a page the site did not serve as taught; both arms pay for it, A also pays its browser fallback.`,
      breakEven !== null
        ? `**Break-even observed at repetition ${breakEven}** when the page is investigated first (learn + teach counted)${holds(cumA) ? `, and A is still below B at repetition ${last}` : `, but A is above B again at repetition ${last}`}.`
        : extrapolated !== null
          ? `**No break-even within ${REPS} repetitions when the page is investigated first.** Extrapolating from mean per-run costs it would come at about repetition ${extrapolated}; that is an extrapolation, not an observation.`
          : `**No break-even.** B's mean per-run wall time is not above A's, so A never catches up on time here.`,
      breakEvenKnown !== null
        ? `With selectors already known (teach only), break-even is at repetition ${breakEvenKnown}${holds(cumAKnown) ? `, still holding at repetition ${last}` : `, but A is above B again at repetition ${last}`}.`
        : 'With selectors already known (teach only), there is still no break-even within the observed repetitions.',
      '')
  }
  lines.push('## What this does not show', '',
    '- B is a "new browser each time, no LLM" control with the answer selectors already known. It is not a bound on every browser-based approach (a reused browser, for one, would be cheaper per run), and neither arm\'s LLM usage was measured.',
    '- Tokens are not compared: both arms extract the same fields, so an agent would read the same output from either. An earlier draft compared A\'s TSV against B\'s whole-page accessibility snapshot; that only showed that selected fields are smaller than a page.',
    '- `learn` runs here but its output is not used: `teach` receives selectors chosen in advance. The "investigated first" row charges learn anyway; the "selectors already known" row is the same records minus learn time, an arithmetic split, not a second experiment.',
    '- Agreement is consistency between two reads of a changing page, not an independent correctness check.',
    '- Three sites, one session, one machine and network. Per-site tables are the result; there is no pooled average.',
    '- The first-time cost is what a person pays once per task; it does not include the person\'s own time choosing selectors.',
    '- Where the access policy line above says it applied to both arms, wall time includes the same per-host gate for A and B; "processing only" rows remove gate and politeness waits. Older runs without that line gated only A and are kept as policy-asymmetric experiments, not re-labelled.', '')
  return lines.join('\n')
}

await main()
