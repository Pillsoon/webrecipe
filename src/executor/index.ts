import { measureResult } from '../measurement.js'
import type { RecipeRegistry } from '../recipes/registry.js'
import type { Recipe } from '../recipes/schema.js'
import { validate } from '../validator/index.js'
import { isRobotsRefusal } from '../local.js'
import { addMeta, type ExecutionMeta, type Item, type Result, type Strategy, type Task } from '../types.js'

/** How long a site stays off the recipe path after it refused one. */
export const BLOCK_COOLDOWN_MS = 10 * 60_000

/** Statuses a site uses to say no: auth wall, forbidden, rate limit, shed load. */
const BLOCK_STATUSES = new Set([401, 403, 429, 503])

/** Replaced in place once the healer reports why the compiler refused. */
const NO_RECIPE = 'no recipe registered'

export interface ExecutionOutcome extends Result {
  recipeUsed: boolean
  fellBack: boolean
  /** The site refused the recipe; the recipe is not rotted and must not be healed. */
  blocked: boolean
  reasons: string[]
}

export interface FallbackEvent {
  task: Task
  recipe: Recipe | null
  reasons: string[]
}

export interface ExecutorOptions {
  registry: RecipeRegistry
  strategies: Strategy[]
  /**
   * Reports whether the re-record it performed produced the same recipe, and
   * why the compiler refused when it did. A healer that changed nothing saw the
   * page the recipe was learned from, so the page did not rot and the engine's
   * own client is being served something else.
   */
  onFallback?: (event: FallbackEvent) => Promise<{ unchanged: boolean; refused?: string; meta?: ExecutionMeta } | void>
  /** Injectable clock, so the block cooldown is testable without waiting it out. */
  now?: () => number
}

/**
 * What the recipe attempt observed, or null when it threw, never ran, or came
 * back without a status. A browser `Result` carries no status and is never a
 * refusal, so the absence has to stay distinguishable from a real 200.
 */
interface RecipeAttempt {
  status: number
  items: Item[]
  recordedShape: boolean
}

/** Only a json signature reports whether the recipe's items path still resolved. */
function keptRecordedShape(recipe: Recipe, payload: unknown): boolean {
  // An html recipe has no items path to test, so its challenge pages are caught
  // only because this returns false; narrowing this line away kills rule (b) for
  // every html site, with nothing but the siteRefusing test to notice.
  if (recipe.output.type !== 'json') return false
  return (payload as { itemsPath?: string } | null | undefined)?.itemsPath === recipe.output.items.path
}

export class Executor {
  /** Site -> the time until which it is treated as refusing us. */
  private readonly blockedUntil = new Map<string, number>()

  constructor(private readonly opts: ExecutorOptions) {}

  private strategy(name: Strategy['name']): Strategy {
    const found = this.opts.strategies.find((s) => s.name === name)
    if (!found) throw new Error(`no strategy registered for "${name}"`)
    return found
  }

  /**
   * Descends the browser levels rather than jumping to the bottom. A warm pool
   * still needs a browser but does not pay to start one, and hardcoding the
   * cold browser here made that distinction unobservable: the level split
   * reported L2 at zero because nothing could ever reach it.
   */
  private async fallback(
    recipe: Recipe | null,
    task: Task,
    reasons: string[],
  ): Promise<Omit<ExecutionOutcome, 'blocked'>> {
    const ladder = this.opts.strategies.filter((s) => s.name === 'warm-browser' || s.name === 'browser')
    ladder.sort((a, b) => (a.name === 'warm-browser' ? -1 : 1) - (b.name === 'warm-browser' ? -1 : 1))

    let lastError: unknown = new Error('no browser strategy registered')
    for (const strategy of ladder) {
      try {
        const result = await strategy.execute(recipe ?? ({} as Recipe), task)
        return { ...result, recipeUsed: false, fellBack: true, reasons }
      } catch (err) {
        if (isRobotsRefusal(err)) throw err
        lastError = err
        reasons.push(err instanceof Error ? err.message : String(err))
      }
    }
    throw lastError
  }

  async run(task: Task): Promise<ExecutionOutcome> {
    return measureResult('browser', () => this.runTask(task))
  }

  private async runTask(task: Task): Promise<ExecutionOutcome> {
    const now = this.opts.now ?? Date.now
    const recipe = await this.opts.registry.load(task.site, task.intent)
    const reasons: string[] = []

    const cooldown = this.blockedUntil.get(task.site)
    if (cooldown !== undefined && cooldown > now()) {
      reasons.push(`blocked: cooling down for ${task.site}`)
      const cooling = await this.fallback(recipe, task, reasons)
      return { ...cooling, blocked: true, reasons: [...reasons] }
    }

    let attempt: RecipeAttempt | null = null
    /** What was spent before the answer arrived, kept so the total can include it. */
    const spent: ExecutionMeta[] = []

    if (recipe && recipe.strategy.type !== 'browser') {
      try {
        const result = await this.strategy(recipe.strategy.type).execute(recipe, task)
        const outcome = validate(recipe, {
          status: result.status ?? recipe.validation.status,
          payload: result.payload,
          items: result.items,
        })

        if (outcome.valid) {
          return { ...result, recipeUsed: true, fellBack: false, blocked: false, reasons: [] }
        }
        reasons.push(...outcome.reasons)
        spent.push(result.meta)
        // The raw status, never the expected one standing in for it: reading a
        // missing status as the expected one would make every browser result a
        // 200 that carried nothing, which is half of rule (b).
        if (result.status !== undefined) {
          attempt = {
            status: result.status,
            items: result.items,
            recordedShape: keptRecordedShape(recipe, result.payload),
          }
        }
      } catch (err) {
        // Not a reason to try the browser: it would request the page robots.txt excluded.
        if (isRobotsRefusal(err)) throw err
        reasons.push(err instanceof Error ? err.message : String(err))
      }
    } else if (!recipe) {
      reasons.push(NO_RECIPE)
    }

    // (a) is settled before the browser runs. A site that answered 403 has
    // earned the cooldown whatever the browser then does, and deciding it after
    // would lose the entry whenever the fallback throws.
    let blocked = false
    if (attempt && BLOCK_STATUSES.has(attempt.status)) {
      reasons.push(`blocked: status ${attempt.status}`)
      this.blockedUntil.set(task.site, now() + BLOCK_COOLDOWN_MS)
      blocked = true
    }

    const fellBack = await this.fallback(recipe, task, reasons)

    // (b) cannot be settled any earlier: a 200 that carried nothing is only a
    // challenge page if the browser beside it could not read the page either.
    // Drift the browser can still read is a rotted recipe, and heals.
    // An empty result and a challenge page both carry no items; only the empty
    // result still has the response shape the recipe recorded.
    if (!blocked && attempt?.status === 200 && attempt.items.length === 0
        && !attempt.recordedShape && fellBack.items.length === 0) {
      reasons.push('blocked: 200 with no items, browser also empty')
      this.blockedUntil.set(task.site, now() + BLOCK_COOLDOWN_MS)
      blocked = true
    }

    // (c) costs this one task a re-record, and has to: comparing the recipe the
    // browser yields now against the stored one is the measurement, and there
    // is no way to learn it changed nothing without performing it once.
    if (!blocked) {
      const healResult = await this.opts.onFallback?.({ task, recipe, reasons })
      if (healResult?.meta) spent.push(healResult.meta)

      // On the run that learned it, not a later one: a benchmark task runs
      // once, so a reason held back for next time is a reason nothing reports.
      if (healResult?.refused !== undefined) {
        const bare = reasons.indexOf(NO_RECIPE)
        const line = `no recipe: ${healResult.refused}`
        if (bare === -1) reasons.push(line)
        else reasons[bare] = line
      }

      if (healResult && healResult.unchanged) {
        reasons.push('blocked: re-record produced the same recipe — the site serves the engine a different page')
        this.blockedUntil.set(task.site, now() + BLOCK_COOLDOWN_MS)
        blocked = true
      }
    }
    return { ...fellBack, meta: addMeta(fellBack.meta, ...spent), blocked, reasons: [...reasons] }
  }
}
