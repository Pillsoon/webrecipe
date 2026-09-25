import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { teach } from '../authoring/teach.js'
import { HttpHtmlStrategy } from '../executor/strategies/http-html.js'
import { HttpJsonStrategy } from '../executor/strategies/http-json.js'
import { PolitenessLayer } from '../net/politeness.js'
import { StaticSiteResolver } from '../sites.js'
import { judgeByGroundTruth, DATASET_TRUTH, PAGE_TRUTH, pageWindow, type GroundTruth } from './ground-truth.js'
import { structurallySuccessful, type CaseOutcome, type VerifierVerdict } from './verification-matrix.js'
import { CheckNameSchema, type CheckName } from '../local.js'
import { startSsrFixture } from '../../fixtures/ssr.js'
import { startIgnoringFixture } from '../../fixtures/ignoring.js'
import { startShiftedFixture } from '../../fixtures/shifted.js'
import { startVolatileFixture } from '../../fixtures/volatile.js'
import { startLimitingFixture } from '../../fixtures/limiting.js'
import { startCloakingFixture } from '../../fixtures/cloaking.js'
import { startPageIgnoringFixture, startPinnedFixture, startPageLimitedFixture } from '../../fixtures/paging.js'
import { search } from '../../fixtures/data.js'
import type { FixtureServer } from '../../fixtures/harness.js'
import type { Item } from '../types.js'

export interface VerificationCase {
  id: string
  start: () => Promise<FixtureServer>
  query: string
  /** The page the task is taught on; templating it is what makes it required. */
  page?: number
  /**
   * The input whose answer is judged — the one a user exercising this task's
   * promise would send. For a pagination case that is a page other than the one
   * taught, because a broken page control is invisible on the taught page.
   */
  answerInput?: Record<string, string | number>
  /**
   * What a right answer is, stated from the fixture's own dataset. Never
   * derived from a run, and never from anything the verifier produced.
   */
  truth: GroundTruth
}

/**
 * The first set: one fixture per behaviour the verifier has to tell apart.
 *
 * Small on purpose. What is being measured is whether the plumbing can show a
 * false success at all, not how a large site population behaves.
 */
export const VERIFICATION_CASES: VerificationCase[] = [
  { id: 'honest', start: startSsrFixture, query: 'rust', truth: DATASET_TRUTH },
  { id: 'ignoring', start: startIgnoringFixture, query: 'rust', truth: DATASET_TRUTH },
  { id: 'shifted', start: startShiftedFixture, query: 'rust', truth: DATASET_TRUTH },
  // The one fixture that invents a row, and the only one allowed to.
  { id: 'volatile', start: startVolatileFixture, query: 'rust',
    truth: { expected: DATASET_TRUTH.expected, ephemeral: /^\/item\/live-\d+$/ } },
  { id: 'rate-limited', start: () => startLimitingFixture(429), query: 'rust', truth: DATASET_TRUTH },
  { id: 'cloaking', start: startCloakingFixture, query: 'rust', truth: DATASET_TRUTH },
]

const FIELDS = { title: 'a.title', url: 'a.title@href' }

/**
 * Pagination cases, counted apart from the query ones.
 *
 * A separate denominator on purpose: these fixtures are built to exercise a
 * page control and the query ones are not, so pooling them would produce a rate
 * over a population nobody chose.
 */
export const PAGINATION_CASES: VerificationCase[] = [
  { id: 'paged', start: startSsrFixture, query: 'senior', page: 1,
    answerInput: { query: 'senior', page: 2 }, truth: PAGE_TRUTH },

  { id: 'page-ignored', start: () => startPageIgnoringFixture({ browserPaginates: false }), query: 'senior', page: 1,
    answerInput: { query: 'senior', page: 2 }, truth: PAGE_TRUTH },

  { id: 'page-stale', start: () => startPageIgnoringFixture({ browserPaginates: true }), query: 'senior', page: 1,
    answerInput: { query: 'senior', page: 2 }, truth: PAGE_TRUTH },

  // Eight matches, so page two is genuinely empty and page one is the answer.
  { id: 'single-page', start: startSsrFixture, query: 'elixir', page: 1,
    answerInput: { query: 'elixir', page: 1 }, truth: PAGE_TRUTH },

  // Its pinned row belongs to page one and is declared, not tolerated by a
  // general rule that would excuse any unrecognised row.
  { id: 'page-pinned', start: startPinnedFixture, query: 'senior', page: 1,
    answerInput: { query: 'senior', page: 2 },
    truth: { expected: (input) => new Set([...pageWindow(input), `/item/${search(String(input.query ?? ''), 1)[0]!.id}`]) } },

  { id: 'page-volatile', start: startVolatileFixture, query: 'senior', page: 1,
    answerInput: { query: 'senior', page: 2 },
    truth: { expected: pageWindow, ephemeral: /^\/item\/live-\d+$/ } },

  // Answers page one and declines the rest, so the probe is declined while the
  // answer being judged is fine.
  { id: 'page-limited', start: () => startPageLimitedFixture(503, 1), query: 'senior', page: 1,
    answerInput: { query: 'senior', page: 1 }, truth: PAGE_TRUTH },

  { id: 'page-cloaking', start: startCloakingFixture, query: 'senior', page: 1,
    answerInput: { query: 'senior', page: 2 }, truth: PAGE_TRUTH },
]

export interface RunOptions {
  /** Changes what the verifier concludes without changing the answer it judges. */
  skipSemanticVerification?: boolean
}

export async function runCase(one: VerificationCase, opts: RunOptions = {}): Promise<CaseOutcome> {
  const fixture = await one.start()
  try {
    const planDir = await mkdtemp(join(tmpdir(), 'matrix-plans-'))
    const recipeDir = await mkdtemp(join(tmpdir(), 'matrix-recipes-'))
    const site = `case-${one.id}`

    const input: Record<string, string | number> = one.page === undefined
      ? { query: one.query }
      : { query: one.query, page: one.page }
    const url = one.page === undefined
      ? `${fixture.url}/search?q=${encodeURIComponent(one.query)}`
      : `${fixture.url}/search?q=${encodeURIComponent(one.query)}&page=${one.page}`

    const taught = await teach({
      site, intent: 'search',
      url,
      input,
      itemSelector: 'li.result', fields: FIELDS,
      planDir, recipeDir, minIntervalMs: 0,
      ...(opts.skipSemanticVerification === true ? { skipSemanticVerification: true } : {}),
    })

    const evidence = taught.plan.verification?.evidence ?? {}
    const checks: Partial<Record<CheckName, VerifierVerdict>> = {}
    const reasons: Partial<Record<CheckName, string>> = {}
    for (const name of CheckNameSchema.options) {
      const entry = evidence[name]
      if (entry === undefined || name === 'non_empty' || name === 'required_fields') continue
      checks[name] = entry.status as VerifierVerdict
      if (entry.reason !== undefined) reasons[name] = entry.reason
    }

    // The answer a run would actually return: the recipe, not the recording.
    const answerInput = one.answerInput ?? input
    const items = taught.recipe === null ? null : await answerOf(taught.recipe, site, fixture.url, answerInput)

    const oracle = items === null
      ? { match: null, reason: 'no answer to judge' }
      : judgeByGroundTruth(items, answerInput, one.truth)

    return {
      id: one.id,
      checks,
      oracleMatch: oracle.match,
      structuralSuccess: items !== null && structurallySuccessful(items, Object.keys(FIELDS)),
      ...(oracle.reason === '' ? {} : { oracleReason: oracle.reason }),
      ...(Object.keys(reasons).length === 0 ? {} : { reasons }),
    }
  } finally { await fixture.close() }
}

async function answerOf(
  recipe: NonNullable<Awaited<ReturnType<typeof teach>>['recipe']>,
  site: string, origin: string, input: Record<string, string | number>,
): Promise<Item[] | null> {
  const net = new PolitenessLayer({ minIntervalMs: 0 })
  const sites = new StaticSiteResolver({ [site]: origin })
  const strategy = recipe.output.type === 'json' ? new HttpJsonStrategy(net, sites) : new HttpHtmlStrategy(net, sites)
  try {
    const result = await strategy.execute(recipe, { id: 'matrix', site, intent: 'search', input })
    return result.status !== undefined && result.status !== recipe.validation.status ? null : result.items
  } catch { return null }
}

export async function runVerificationCases(cases = VERIFICATION_CASES, opts: RunOptions = {}): Promise<CaseOutcome[]> {
  const outcomes: CaseOutcome[] = []
  // Sequential: each case launches a browser, and running them at once would
  // measure contention rather than the sites.
  for (const one of cases) outcomes.push(await runCase(one, opts))
  return outcomes
}
