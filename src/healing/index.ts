import type { NavigationGuard } from '../browser/navigate.js'
import { record } from '../recorder/index.js'
import { HeuristicCompiler } from '../compiler/heuristic.js'
import { compileHtmlRecipe } from '../compiler/html.js'
import { isRefused, type Compiler } from '../compiler/types.js'
import type { RecipeRegistry } from '../recipes/registry.js'
import type { Recipe } from '../recipes/schema.js'
import type { FallbackEvent } from '../executor/index.js'
import type { BrowserPlan } from '../executor/strategies/browser.js'
import type { SiteResolver } from '../sites.js'
import { emptyMeta, type ExecutionMeta, type Intent } from '../types.js'
import type { Trace } from '../recorder/types.js'

export interface HealResult {
  healed: boolean
  recipe: Recipe | null
  changes: string[]
  /** Why the compiler would not produce a recipe, when that is what stopped it. */
  refused: string | null
  /**
   * What the re-record cost, or null when no browser ran. Healing is a second
   * real visit to the site; reported as nothing, the one run that pays for
   * learning looks as cheap as every run that reuses what it learned.
   */
  meta: ExecutionMeta | null
}

/** The visit's cost, read off the trace it already produced. */
function costOf(trace: Trace, latencyMs: number): ExecutionMeta {
  return {
    ...emptyMeta('browser'),
    latencyMs,
    browserLaunches: 1,
    pageNavigations: trace.actions.filter((a) => a.type === 'navigate').length,
    networkRequests: trace.requests.length,
    bytesDownloaded: trace.requests.reduce((total, r) => total + r.bodySize, 0),
    ...trace.cost,
  }
}

export function diffRecipes(before: Recipe | null, after: Recipe): string[] {
  if (before === null) return [`new recipe for ${after.site}/${after.intent} -> ${after.request.path}`]

  const changes: string[] = []
  if (before.request.path !== after.request.path) {
    changes.push(`endpoint ${before.request.path} -> ${after.request.path}`)
  }
  if (before.strategy.type !== after.strategy.type) {
    changes.push(`strategy ${before.strategy.type} -> ${after.strategy.type}`)
  }
  if (JSON.stringify(before.request.query) !== JSON.stringify(after.request.query)) {
    changes.push(`query ${JSON.stringify(before.request.query)} -> ${JSON.stringify(after.request.query)}`)
  }
  if (before.fingerprint.hash !== after.fingerprint.hash) {
    changes.push(`fingerprint ${before.fingerprint.hash} -> ${after.fingerprint.hash}`)
  }
  if (JSON.stringify(before.output) !== JSON.stringify(after.output)) {
    changes.push('output mapping changed')
  }
  return changes
}

export interface SelfHealerOptions {
  registry: RecipeRegistry
  sites: SiteResolver
  plans: Record<string, Partial<Record<Intent, BrowserPlan>>>
  /** Checks the relearning visit against robots.txt, like the fetch it follows. */
  guard?: NavigationGuard
  compiler?: Compiler
}

export class SelfHealer {
  /**
   * Pairs whose trace cannot be compiled at all — an API that cannot meet the
   * browser plan's field contract, say — against why they were given up on.
   * Retrying costs a second browser launch per task and always fails the same
   * way, but the reason is still the answer to every later task's "why is there
   * no recipe", so it is kept rather than forgotten after the first report.
   */
  private readonly hopeless = new Map<string, string>()

  constructor(private readonly opts: SelfHealerOptions) {}

  /**
   * The compiler is told which output names the browser plan produces, so a
   * learned recipe is a drop-in replacement rather than a narrower one.
   */
  private compilerFor(plan: BrowserPlan): Compiler {
    return this.opts.compiler ?? new HeuristicCompiler(plan)
  }

  /**
   * Re-records the task with a browser, recompiles, and stores the result.
   * An http-json recipe is preferred; an http-html one is accepted when the
   * raw navigation response already carries the items.
   */
  async heal(event: FallbackEvent): Promise<HealResult> {
    const key = `${event.task.site}/${event.task.intent}`
    const given = this.hopeless.get(key) ?? await this.opts.registry.learningFailure(event.task.site, event.task.intent) ?? undefined
    if (given !== undefined) return { healed: false, recipe: null, changes: [], refused: given, meta: null }

    const plan = this.opts.plans[event.task.site]?.[event.task.intent]
    if (!plan) return { healed: false, recipe: null, changes: [], refused: null, meta: null }

    const started = performance.now()
    const trace = await record(plan, event.task, this.opts.sites, this.opts.guard)
    try {
      const meta = costOf(trace, Math.round(performance.now() - started))

      // Every compiler that ran and refused, not only the last. The html one
      // reports little more than that the raw response did not carry the items,
      // so on a json site its reason alone hides the diagnosis.
      const refusals: string[] = []
      let compiled: Recipe | null = null

      const json = await this.compilerFor(plan).compile(trace)
      if (isRefused(json)) refusals.push(`json: ${json.refused}`)
      else compiled = json

      if (compiled === null) {
        const html = compileHtmlRecipe(trace, plan)
        if (isRefused(html)) refusals.push(`html: ${html.refused}`)
        else compiled = html
      }

      if (compiled && plan.sameOriginOnly && compiled.request.origin && compiled.request.origin !== this.opts.sites.origin(event.task.site)) {
        refusals.push('recipe reaches outside the taught origin')
        compiled = null
      }

      if (compiled === null) {
        const refused = refusals.join('; ')
        this.hopeless.set(key, refused)
        await this.opts.registry.setLearningFailure(event.task.site, event.task.intent, refused)
        return { healed: false, recipe: null, changes: [], refused, meta }
      }

      const changes = diffRecipes(event.recipe, compiled)
      await this.opts.registry.save(compiled)
      return { healed: true, recipe: compiled, changes, refused: null, meta }
    } finally {
      await trace.dispose?.()
    }
  }
}
