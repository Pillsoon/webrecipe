import { HttpHtmlStrategy } from '../executor/strategies/http-html.js'
import { HttpJsonStrategy } from '../executor/strategies/http-json.js'
import { browserItemsOf } from '../compiler/verify.js'
import { record } from '../recorder/index.js'
import type { BrowserPlan } from '../executor/strategies/browser.js'
import type { PolitenessLayer } from '../net/politeness.js'
import type { Recipe } from '../recipes/schema.js'
import type { SiteResolver } from '../sites.js'
import type { ProbeRecord } from '../local.js'
import type { Intent, Item } from '../types.js'

/**
 * The requests every check is built from, issued once and read by all of them.
 *
 * Kept apart from any one check so that no check can only run when another
 * does. Pagination has nothing to do with a query and must be verifiable on a
 * task that has none; it reuses the baseline when a query check has already
 * paid for it, and issues it itself when nothing has.
 */

export type ProbeRole = ProbeRecord['role']

export interface ProbeObservation {
  role: ProbeRole
  value: string
  /** Null when the probe never completed. An empty array is a real observation. */
  items: Item[] | null
  unavailable?: string
}

/** The baseline pair, plus two probes each for the query checks and one for pagination. */
export const HTTP_PROBE_BUDGET = 5

/** Statuses that mean the site declined, which is never a semantic verdict. */
const BLOCK_STATUSES = new Set([401, 403, 429, 503])

export interface ProbeContext {
  recipe: Recipe
  /** Templated against each probe's input, for the reference observations. */
  browserPlan: BrowserPlan
  site: string
  intent: Intent
  input: Record<string, string | number>
  net: PolitenessLayer
  sites: SiteResolver
}

/**
 * Drives the strategies directly rather than through `Executor`, which falls
 * back to a browser and re-learns on failure: a probe routed through it would
 * measure whatever managed to answer instead of the recipe being judged.
 * Writes nothing to the registry or the plan.
 */
export class Probes {
  private spent = 0

  constructor(private readonly ctx: ProbeContext) {}

  private get strategy() {
    return this.ctx.recipe.output.type === 'json'
      ? new HttpJsonStrategy(this.ctx.net, this.ctx.sites)
      : new HttpHtmlStrategy(this.ctx.net, this.ctx.sites)
  }

  /** One request, never retried by us; the budget is what stops a storm. */
  async http(role: ProbeRole, value: string, input: Record<string, string | number>): Promise<ProbeObservation> {
    if (this.spent >= HTTP_PROBE_BUDGET) return { role, value, items: null, unavailable: 'probe budget spent' }
    this.spent += 1
    try {
      const result = await this.strategy.execute(this.ctx.recipe, { id: `probe-${role}`, site: this.ctx.site, intent: this.ctx.intent, input })
      const status = result.status
      if (status !== undefined && BLOCK_STATUSES.has(status)) return { role, value, items: null, unavailable: `site declined with ${status}` }
      if (status !== undefined && status !== this.ctx.recipe.validation.status) return { role, value, items: null, unavailable: `unexpected status ${status}` }
      return { role, value, items: result.items }
    } catch (error) {
      return { role, value, items: null, unavailable: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * A second reading of the same page, not a statement of what is true. The
   * browser can be wrong in its own way, which is why the benchmark's oracle
   * has to stay a separate thing.
   */
  async browser(input: Record<string, string | number>): Promise<Item[] | null> {
    const task = { id: 'probe-reference', site: this.ctx.site, intent: this.ctx.intent, input }
    let trace: Awaited<ReturnType<typeof record>> | undefined
    try {
      trace = await record(this.ctx.browserPlan, task, this.ctx.sites)
      return browserItemsOf(trace, this.ctx.browserPlan)
    } catch {
      // A browser that could not run leaves a check untested, never failed.
      return null
    } finally { await trace?.dispose?.() }
  }
}

export interface Baseline {
  input: Record<string, string | number>
  taught: ProbeObservation
  repeat: ProbeObservation
  /** What the browser saw at the taught input. Free: teaching already recorded it. */
  browserTaught: Item[] | null
}

/**
 * The taught input, asked twice.
 *
 * Twice because a site whose answer changes between two identical requests
 * cannot be judged by comparing sets, in either direction, and every check
 * below rests on that comparison.
 */
export async function runBaseline(
  probes: Probes, input: Record<string, string | number>, parameter: string, browserTaught: Item[] | null,
): Promise<Baseline> {
  const value = String(input[parameter] ?? '')
  return {
    input,
    taught: await probes.http('taught', value, input),
    repeat: await probes.http('repeat', value, input),
    browserTaught,
  }
}

const identity = (item: Item): string =>
  item.url !== undefined && item.url !== null && item.url !== ''
    ? `url:${String(item.url)}`
    : JSON.stringify(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))

export const setOf = (items: Item[]): Set<string> => new Set(items.map(identity))

export const sameSet = (a: Item[], b: Item[]): boolean => {
  const [x, y] = [setOf(a), setOf(b)]
  return x.size === y.size && [...x].every((k) => y.has(k))
}

export const overlapShare = (a: Item[], b: Item[]): number => {
  const [x, y] = [setOf(a), setOf(b)]
  if (y.size === 0) return 0
  return [...y].filter((k) => x.has(k)).length / y.size
}

export const asRecords = (observations: ProbeObservation[]): ProbeRecord[] =>
  observations.map(({ role, value, items, unavailable }) => ({
    role, value, items: items === null ? null : items.length,
    ...(unavailable === undefined ? {} : { unavailable }),
  }))
