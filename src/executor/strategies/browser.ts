import { measureResult } from '../../measurement.js'
import type { SiteResolver } from '../../sites.js'
import type { Recipe } from '../../recipes/schema.js'
import { openSession } from '../../browser/session.js'
import { navigateAndSettle, guardPage, type NavigationGuard } from '../../browser/navigate.js'
import { planFields, resolveUrlFields, type FieldPlan } from '../extract.js'
import { countTokens } from '../tokens.js'
import { emptyMeta, type Intent, type Item, type Result, type Strategy, type Task } from '../../types.js'

export interface BrowserPlan {
  /** User-taught plans may only compile replay requests on their chosen origin. */
  sameOriginOnly?: boolean
  url: (origin: string, task: Task) => string
  itemSelector: string
  /** `@attr` reads an attribute; `''` reads the element's own text; anything else is a descendant selector. */
  fields: Record<string, string>
}

export const BROWSER_PLANS: Record<string, Partial<Record<Intent, BrowserPlan>>> = {}

export class BrowserStrategy implements Strategy {
  readonly name = 'browser' as const

  constructor(
    private readonly sites: SiteResolver,
    private readonly plans: Record<string, Partial<Record<Intent, BrowserPlan>>> = BROWSER_PLANS,
    /** The token count costs a page read of its own; a timing benchmark can decline to pay it. */
    private readonly countAgentTokens = true,
    private readonly guard?: NavigationGuard,
  ) {}

  async execute(recipe: Recipe, task: Task): Promise<Result> {
    return measureResult(this.name, () => this.executeAttempt(recipe, task))
  }

  private async executeAttempt(_recipe: Recipe, task: Task): Promise<Result> {
    const plan = this.plans[task.site]?.[task.intent]
    if (!plan) throw new Error(`no browser plan for ${task.site}/${task.intent}`)

    const meta = emptyMeta(this.name)
    const started = performance.now()
    const session = await openSession()
    meta.browserLaunches = 1

    try {
      const guard = this.guard ? await guardPage(session.page, this.guard) : undefined
      await navigateAndSettle(session.page, plan.url(this.sites.origin(task.site), task), plan.itemSelector, guard)

      // The field specs are interpreted once, in node, so that the browser and
      // cheerio cannot drift apart on what a spec means.
      const items = (await session.page.$$eval(
        plan.itemSelector,
        (elements, plans: FieldPlan[]) =>
          elements.map((el) =>
            Object.fromEntries(
              plans.map((f) => {
                switch (f.mode) {
                  case 'own-text': return [f.name, el.textContent?.trim() ?? null]
                  case 'own-attr': return [f.name, el.getAttribute(f.attribute)]
                  case 'find-attr': return [f.name, el.querySelector(f.selector)?.getAttribute(f.attribute) ?? null]
                  default: return [f.name, el.querySelector(f.selector)?.textContent?.trim() ?? null]
                }
              }),
            ),
          ),
        planFields(plan.fields),
      )) as Item[]
      // Resolved in node rather than in the page, by the same rule the http path uses.
      resolveUrlFields(items, planFields(plan.fields), await session.page.evaluate(() => document.baseURI))

      meta.pageNavigations = session.cost.pageNavigations
      meta.networkRequests = session.cost.networkRequests
      meta.bytesDownloaded = session.cost.bytesDownloaded
      meta.latencyMs = Math.round(performance.now() - started)

      // After the latency line: taking the snapshot and tokenising it both take
      // real time, and charging that to the baseline would flatter the engine.
      // The read is allowed to fail — a late client-side navigation destroys
      // the execution context — because instrumentation must never turn a
      // graded run into a thrown one.
      const snapshot = this.countAgentTokens ? await session.page.locator('body').ariaSnapshot().catch(() => '') : ''
      meta.llmTokens = countTokens(snapshot)

      // After reading, so a page that moved somewhere disallowed while it was read is not answered from.
      guard?.check()
      return { items, meta }
    } finally {
      await session.close()
    }
  }
}
