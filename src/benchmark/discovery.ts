import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'cheerio'
import { teach } from '../authoring/teach.js'
import { HttpHtmlStrategy } from '../executor/strategies/http-html.js'
import { HttpJsonStrategy } from '../executor/strategies/http-json.js'
import { PolitenessLayer } from '../net/politeness.js'
import { StaticSiteResolver, WILD_ORIGINS } from '../sites.js'
import { verifyReadable, UserError, type CheckName, type EvidenceEntry, type VerificationStatus } from '../local.js'
import { PLANS } from '../../benchmark/plans.js'
import type { BenchTask } from './runner.js'
import type { Item } from '../types.js'

/**
 * What the frozen verifier says about real sites, beside what an independent
 * account says the answer was.
 *
 * The verifier is not modified while this runs. A failure found on the first
 * site and fixed before the last is a batch whose halves came from two
 * different systems, and the first case is the one a fix overfits to.
 */

export const BASELINE = '7f51ca0'

/** Why a check came back untested, read off the structured evidence rather
 *  than its prose, so the verifier needed no change to be classified. */
export type NotTestedReason =
  | 'volatile' | 'rate_limited' | 'transport_failure' | 'browser_disagreement'
  | 'no_visible_lexical_match' | 'lexical_inconsistent' | 'empty_alternate_page'
  | 'page_control_ambiguous' | 'insufficient_evidence' | 'unclassified'

export type Judgement = 'correct' | 'wrong' | 'indeterminate'
export type JudgementSource = 'entity_id' | 'expect_empty' | 'detail_mismatch' | 'manual' | 'none'

/**
 * Whether a rule could be applied here, asked and recorded before what it
 * concluded — the same discipline the verifier follows.
 *
 * v1 had no such gate and reported ten wrong answers that were right. It asked
 * whether the requested id appeared among the fields an answer carried, and
 * never whether the plan extracted a field that could carry one.
 */
export interface OracleApplicability {
  type: JudgementSource
  applicable: boolean
  reason: string
}

export interface DiscoveryRecord {
  baseline: string
  /** This batch hit origins; nothing was served from a cache, because there is none. */
  cached: false
  site: string
  taskId: string
  intent: string
  inputRole: 'taught' | 'unseen'
  input: Record<string, string | number>
  contract: CheckName[]
  checks: Partial<Record<CheckName, string>>
  finalStatus: VerificationStatus | 'error'
  notTestedReasons: Partial<Record<CheckName, NotTestedReason>>
  judgement: Judgement
  judgementSource: JudgementSource
  judgementReason: string
  oracle: OracleApplicability
  /** Set when only a person can settle it; the queue this batch produces. */
  needsManual: boolean
  /** Exactly what a run returned, so a corrected or a new oracle can be run
   *  over this again without touching the origin. */
  items: Item[]
  itemCount: number
  cost: { httpRequests: number; browserRuns: number; elapsedMs: number }
  error?: string
}

export interface SkipRecord {
  baseline: string
  site: string
  taskId: string
  reason: 'skipped_by_robots' | 'no_plan' | 'teach_failed'
  detail: string
}

/** One learned plan and the inputs it is judged on. */
export interface DiscoveryCase {
  site: string
  intent: BenchTask['intent']
  taught: BenchTask
  unseen: BenchTask[]
}

/** At most four, plus every task that expects an empty result: those carry a
 *  deterministic oracle and are worth more than another ordinary query. */
const UNSEEN_PER_CASE = 4

export function buildCases(tasks: BenchTask[], domains: string[]): DiscoveryCase[] {
  const groups = new Map<string, BenchTask[]>()
  for (const task of tasks) {
    if (!domains.includes(task.site)) continue
    const key = `${task.site}\u0000${task.intent}`
    groups.set(key, [...(groups.get(key) ?? []), task])
  }

  return [...groups.values()].map((all) => {
    const [taught, ...rest] = all
    const empty = rest.filter((t) => t.expectEmpty === true)
    const ordinary = rest.filter((t) => t.expectEmpty !== true).slice(0, UNSEEN_PER_CASE - empty.length)
    return { site: taught!.site, intent: taught!.intent, taught: taught!, unseen: [...ordinary, ...empty] }
  })
}

/** Reads the signals each verifier already records; no verifier was changed. */
export function classifyNotTested(evidence: EvidenceEntry | undefined): NotTestedReason {
  if (evidence === undefined) return 'insufficient_evidence'
  const declined = (evidence.probes ?? []).find((p) => p.unavailable !== undefined)?.unavailable ?? ''
  if (/429|retry later/i.test(declined)) return 'rate_limited'
  if (declined !== '') return 'transport_failure'

  const s = evidence.signals ?? {}
  if (s.stable === false) return 'volatile'
  if (s.applicable === false) return 'no_visible_lexical_match'
  if (s.consistent === false) return 'lexical_inconsistent'
  if (s.agreed === false) return 'browser_disagreement'
  if (s.moved === false) return 'page_control_ambiguous'
  if ((evidence.probes ?? []).some((p) => p.role === 'alternate' && p.items === 0)) return 'empty_alternate_page'
  if (!(evidence.probes ?? []).some((p) => p.role === 'contrast' || p.role === 'alternate')) return 'insufficient_evidence'
  return 'unclassified'
}

const WORD = /^[a-z][a-z0-9-]{3,}$/
const tokens = (text: string): string[] =>
  [...new Set(text.toLowerCase().split(/[^a-z0-9-]+/i).filter((t) => WORD.test(t)))]

const carriesId = (items: Item[], id: string): boolean => {
  const wanted = id.toLowerCase()
  return items.some((item) => Object.values(item).some((v) => String(v ?? '').toLowerCase().includes(wanted)))
}

/**
 * Whether the id rule can be applied to this plan at all.
 *
 * Decided from the taught observation, which is the browser's reading of the
 * url the task names and so is the right entity by the task's own definition.
 * If the id cannot be seen even there, this plan does not extract anything that
 * carries one and the rule tells us nothing about any other input.
 *
 * This answers only "can this oracle be used here". It is never the answer to
 * "was this result right", which is what keeps it from grading itself.
 */
export function entityIdApplicable(taught: BenchTask, taughtItems: Item[] | null): OracleApplicability {
  const type: JudgementSource = 'entity_id'
  if (taught.intent !== 'detail') return { type, applicable: false, reason: 'not a detail lookup' }
  const id = taught.input.id
  if (id === undefined || String(id) === '') return { type, applicable: false, reason: 'the task names no entity id' }
  if (taughtItems === null || taughtItems.length === 0) return { type, applicable: false, reason: 'the taught observation could not be read' }
  return carriesId(taughtItems, String(id))
    ? { type, applicable: true, reason: `the taught output carries the entity id ${id}` }
    : { type, applicable: false, reason: 'requested entity id is not observable in the taught output' }
}

export interface OracleResult { judgement: Judgement; source: JudgementSource; reason: string; oracle: OracleApplicability }

/**
 * T1. A deterministic reading of the task itself, owing nothing to the probes.
 */
export function judgeByTask(
  task: BenchTask, items: Item[], role: 'taught' | 'unseen', entityId: OracleApplicability,
): OracleResult {
  if (task.expectEmpty === true) {
    const oracle: OracleApplicability = { type: 'expect_empty', applicable: true, reason: 'the task declares this query matches nothing' }
    return items.length === 0
      ? { judgement: 'correct', source: 'expect_empty', reason: 'a query declared to match nothing returned nothing', oracle }
      : { judgement: 'wrong', source: 'expect_empty', reason: `a query declared to match nothing returned ${items.length} rows`, oracle }
  }

  if (!entityId.applicable) return { judgement: 'indeterminate', source: 'none', reason: entityId.reason, oracle: entityId }

  // The input the gate was calibrated on cannot also be judged by it.
  if (role === 'taught') {
    return {
      judgement: 'indeterminate', source: 'none',
      reason: 'this is the observation the id oracle was calibrated on, so it cannot also answer for it',
      oracle: { ...entityId, applicable: false, reason: 'calibration input' },
    }
  }

  const id = String(task.input.id)
  if (items.length === 0) {
    return { judgement: 'indeterminate', source: 'none', reason: 'nothing returned to check the id against', oracle: entityId }
  }
  return carriesId(items, id)
    ? { judgement: 'correct', source: 'entity_id', reason: `the requested id ${id} appears in the answer`, oracle: entityId }
    : { judgement: 'wrong', source: 'entity_id', reason: `the requested id ${id} appears nowhere in the answer`, oracle: entityId }
}

/**
 * T2. One-sided on purpose.
 *
 * A row that does not appear on the page it links to is a row describing
 * something else, which is evidence the answer is wrong. A row that does appear
 * there proves only that the row and its own link agree: move a whole row to
 * the wrong entity — title, url and all — and this check still passes it. So a
 * match settles nothing and goes to the next tier.
 */
export async function detailMismatch(
  items: Item[], net: PolitenessLayer, origin: string, sample = 2,
): Promise<{ wrong: boolean; reason: string; requests: number }> {
  let requests = 0
  for (const item of items.slice(0, sample)) {
    const href = String(item.url ?? '')
    const title = String(item.title ?? '')
    if (href === '' || title === '') continue
    const wanted = tokens(title)
    if (wanted.length === 0) continue

    let url: string
    try { url = new URL(href, origin).toString() } catch { continue }
    if (new URL(url).origin !== origin) continue
    if (!(await net.isAllowed(url))) continue

    let text: string
    try {
      requests += 1
      const res = await net.fetch(url)
      if (res.status !== 200) continue
      text = load(res.body).text().toLowerCase()
    } catch { continue }

    // A shell that rendered nothing cannot disagree with anything.
    if (text.length < 500) continue
    if (!wanted.some((t) => text.includes(t))) {
      return { wrong: true, requests, reason: `the row "${title}" shares no word with the page at ${href} that it links to` }
    }
  }
  return { wrong: false, requests, reason: '' }
}

export const DISCOVERY_DOMAINS = [
  'hex.pm', 'docs.rs', 'jsr.io', 'bandcamp.com',
  'meta.discourse.org', 'lemmy.world', 'openlibrary.org', 'dev.to',
]

/** Untouched by this batch, and run once when a changed verifier is first evaluated. */
export const HELD_OUT_DOMAINS = ['npmjs.com', 'musicbrainz.org', 'mastodon.social', 'itch.io']

export interface RunOptions {
  outDir: string
  /** Fixtures pass 0; a real run keeps the one-second ceiling. */
  minIntervalMs?: number
  onRecord?: (record: DiscoveryRecord) => void
  onSkip?: (skip: SkipRecord) => void
}

export async function runDiscovery(cases: DiscoveryCase[], opts: RunOptions): Promise<{
  records: DiscoveryRecord[]; skips: SkipRecord[]
}> {
  await mkdir(join(opts.outDir, 'evidence'), { recursive: true })
  const records: DiscoveryRecord[] = []
  const skips: SkipRecord[] = []
  const net = new PolitenessLayer({ minIntervalMs: opts.minIntervalMs })

  const skip = async (s: SkipRecord) => {
    skips.push(s); opts.onSkip?.(s)
    await appendFile(join(opts.outDir, 'skips.jsonl'), `${JSON.stringify(s)}\n`)
  }
  const keep = async (r: DiscoveryRecord) => {
    records.push(r); opts.onRecord?.(r)
    await appendFile(join(opts.outDir, 'runs.jsonl'), `${JSON.stringify(r)}\n`)
  }

  for (const one of cases) {
    const origin = WILD_ORIGINS[one.site]
    const plan = PLANS[one.site]?.[one.intent]
    if (origin === undefined || plan === undefined) {
      await skip({ baseline: BASELINE, site: one.site, taskId: one.taught.id, reason: 'no_plan', detail: 'no hand-written plan for this site and intent' })
      continue
    }

    const taughtUrl = plan.url(origin, one.taught)
    if (!(await net.isAllowed(taughtUrl))) {
      await skip({ baseline: BASELINE, site: one.site, taskId: one.taught.id, reason: 'skipped_by_robots', detail: taughtUrl })
      continue
    }

    const planDir = await mkdtemp(join(tmpdir(), 'disc-plans-'))
    const recipeDir = await mkdtemp(join(tmpdir(), 'disc-recipes-'))
    const startedTeach = performance.now()
    let taught: Awaited<ReturnType<typeof teach>>
    try {
      taught = await teach({
        site: one.site, intent: one.intent, url: taughtUrl, input: one.taught.input,
        itemSelector: plan.itemSelector, fields: plan.fields,
        planDir, recipeDir, minIntervalMs: opts.minIntervalMs,
      })
    } catch (error) {
      await skip({ baseline: BASELINE, site: one.site, taskId: one.taught.id, reason: 'teach_failed', detail: error instanceof Error ? error.message : String(error) })
      continue
    }
    const teachMs = Math.round(performance.now() - startedTeach)

    const verification = taught.plan.verification
    const contract = verification?.contract.required ?? []
    const notTestedReasons: DiscoveryRecord['notTestedReasons'] = {}
    for (const check of contract) {
      const evidence = verification?.evidence[check]
      if (check === 'non_empty' || check === 'required_fields') continue
      if (evidence?.status === 'passed' || evidence?.status === 'failed') continue
      notTestedReasons[check] = classifyNotTested(evidence)
    }

    await writeFile(
      join(opts.outDir, 'evidence', `${one.site}-${one.intent}.json`),
      `${JSON.stringify({ baseline: BASELINE, site: one.site, intent: one.intent, taughtUrl, plan: taught.plan, refused: taught.refused, sample: taught.sample }, null, 2)}\n`,
    )

    const sites = new StaticSiteResolver({ [one.site]: origin })
    const fields = Object.keys(plan.fields)

    // Calibrated once per plan, from the browser's reading of the url the task
    // names. It decides whether the id rule applies here, never what the answer was.
    const entityId = entityIdApplicable(one.taught, taught.sample)

    for (const [role, task] of [['taught', one.taught], ...one.unseen.map((t) => ['unseen', t] as const)] as const) {
      const url = plan.url(origin, task)
      if (!(await net.isAllowed(url))) {
        await skip({ baseline: BASELINE, site: one.site, taskId: task.id, reason: 'skipped_by_robots', detail: url })
        continue
      }

      const started = performance.now()
      let items: Item[] | null = null
      let error: string | undefined
      let requests = 0
      if (taught.recipe !== null) {
        const strategy = taught.recipe.output.type === 'json' ? new HttpJsonStrategy(net, sites) : new HttpHtmlStrategy(net, sites)
        try {
          requests += 1
          const result = await strategy.execute(taught.recipe, { id: task.id, site: one.site, intent: one.intent, input: task.input })
          items = result.status !== undefined && result.status !== taught.recipe.validation.status ? null : result.items
          if (items === null) error = `status ${result.status}`
        } catch (err) { error = err instanceof Error ? err.message : String(err) }
      } else { error = `no recipe: ${taught.refused ?? 'unknown'}` }

      let finalStatus: DiscoveryRecord['finalStatus'] = 'error'
      let checks: DiscoveryRecord['checks'] = {}
      if (items !== null) {
        try {
          const read = verifyReadable(items, fields, verification)
          finalStatus = read.status
          checks = read.checks
        } catch (err) {
          finalStatus = 'unverified'
          if (err instanceof UserError) error = err.message
        }
      }

      let { judgement, source, reason, oracle } = items === null
        ? {
            judgement: 'indeterminate' as Judgement, source: 'none' as JudgementSource,
            reason: error ?? 'no answer',
            oracle: { type: 'none' as JudgementSource, applicable: false, reason: 'no answer to judge' },
          }
        : judgeByTask(task, items, role, entityId)

      if (judgement === 'indeterminate' && items !== null && items.length > 0 && one.intent !== 'detail') {
        const probe = await detailMismatch(items, net, origin)
        requests += probe.requests
        if (probe.wrong) {
          judgement = 'wrong'; source = 'detail_mismatch'; reason = probe.reason
          oracle = { type: 'detail_mismatch', applicable: true, reason: 'a returned row could be checked against the page it links to' }
        }
      }

      // A person settles what reached verified, and a sample of what did not.
      const needsManual = judgement === 'indeterminate' && (finalStatus === 'verified' || finalStatus === 'partially_verified')

      await keep({
        baseline: BASELINE, cached: false, site: one.site, taskId: task.id, intent: one.intent,
        inputRole: role, input: task.input, contract, checks, finalStatus, notTestedReasons,
        judgement, judgementSource: source, judgementReason: reason, oracle, needsManual,
        items: items ?? [], itemCount: items?.length ?? 0,
        cost: { httpRequests: requests, browserRuns: role === 'taught' ? 3 : 0, elapsedMs: Math.round(performance.now() - started) + (role === 'taught' ? teachMs : 0) },
        ...(error === undefined ? {} : { error }),
      })
    }
  }
  return { records, skips }
}

export function formatDiscovery(records: DiscoveryRecord[], skips: SkipRecord[], eligible: number): string {
  const lines: string[] = []
  const judged = (j: Judgement) => (r: DiscoveryRecord) => r.judgement === j
  const status = (s: string) => (r: DiscoveryRecord) => r.finalStatus === s
  const count = (f: (r: DiscoveryRecord) => boolean) => records.filter(f).length
  const both = (a: (r: DiscoveryRecord) => boolean, b: (r: DiscoveryRecord) => boolean) => count((r) => a(r) && b(r))

  const domains = new Set(records.map((r) => r.site))
  lines.push(`baseline: ${BASELINE}   cached: false (every request hit the origin)`)
  lines.push(`domains: ${domains.size}   learned tasks: ${eligible}   evaluated inputs: ${records.length}`)
  const byReason = new Map<string, number>()
  for (const s of skips) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1)
  lines.push(`skipped: ${skips.length}${skips.length === 0 ? '' : ` (${[...byReason].map(([k, v]) => `${k} ${v}`).join(', ')})`}`)
  lines.push('')
  lines.push('                  correct   wrong   indeterminate')
  for (const s of ['verified', 'partially_verified', 'structural', 'unverified', 'error']) {
    const row = records.filter(status(s))
    if (row.length === 0) continue
    lines.push(`  ${s.padEnd(20)}${String(both(status(s), judged('correct'))).padStart(5)}${String(both(status(s), judged('wrong'))).padStart(8)}${String(both(status(s), judged('indeterminate'))).padStart(14)}`)
  }
  lines.push('')

  const falseSuccess = records.filter((r) => r.finalStatus === 'verified' && r.judgement === 'wrong')
  lines.push(`false success (verified + wrong): ${falseSuccess.length}`)
  for (const r of falseSuccess) lines.push(`  ${r.site} ${r.taskId} ${JSON.stringify(r.input)} — ${r.judgementReason}`)
  lines.push('')

  lines.push('correct but not verified, by reason:')
  const reasons = new Map<string, number>()
  for (const r of records) {
    if (r.judgement !== 'correct' || r.finalStatus === 'verified') continue
    for (const reason of Object.values(r.notTestedReasons)) reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    if (Object.keys(r.notTestedReasons).length === 0) reasons.set('structural_only', (reasons.get('structural_only') ?? 0) + 1)
  }
  for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) lines.push(`  ${reason.padEnd(26)} ${n}`)
  lines.push('')

  const queue = records.filter((r) => r.needsManual)
  lines.push(`awaiting manual judgement: ${queue.length}`)
  for (const r of queue.slice(0, 40)) lines.push(`  [${r.finalStatus}] ${r.site} ${r.taskId} ${JSON.stringify(r.input)} items=${r.itemCount}`)
  return lines.join('\n')
}
