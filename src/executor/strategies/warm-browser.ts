import { measureResult } from '../../measurement.js'
import type { SiteResolver } from '../../sites.js'
import type { Recipe } from '../../recipes/schema.js'
import { BrowserPool } from '../../browser/pool.js'
import { navigateAndSettle, guardPage, type NavigationGuard } from '../../browser/navigate.js'
import { planFields, type FieldPlan } from '../extract.js'
import { countTokens } from '../tokens.js'
import { BROWSER_PLANS, type BrowserPlan } from './browser.js'
import { emptyMeta, type Intent, type Item, type Result, type Strategy, type Task } from '../../types.js'

/** A browser run that does not pay to start a browser. */
export class WarmBrowserStrategy implements Strategy {
  readonly name = 'warm-browser' as const
  private readonly pool = new BrowserPool()

  constructor(
    private readonly sites: SiteResolver,
    private readonly plans: Record<string, Partial<Record<Intent, BrowserPlan>>> = BROWSER_PLANS,
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
    const warm = await this.pool.acquire()

    try {
      const guard = this.guard ? await guardPage(warm.page, this.guard) : undefined
      await navigateAndSettle(warm.page, plan.url(this.sites.origin(task.site), task), plan.itemSelector, guard)

      const items = (await warm.page.$$eval(
        plan.itemSelector,
        (elements, plans: FieldPlan[]) =>
          elements.map((el) =>
            Object.fromEntries(plans.map((f) => {
              switch (f.mode) {
                case 'own-text': return [f.name, el.textContent?.trim() ?? null]
                case 'own-attr': return [f.name, el.getAttribute(f.attribute)]
                case 'find-attr': return [f.name, el.querySelector(f.selector)?.getAttribute(f.attribute) ?? null]
                default: return [f.name, el.querySelector(f.selector)?.textContent?.trim() ?? null]
              }
            })),
          ),
        planFields(plan.fields),
      )) as Item[]

      // Zero only when the pool already had a browser. The first call starts
      // Chromium like any cold run does, and reporting none said otherwise.
      meta.browserLaunches = warm.launched ? 1 : 0
      meta.pageNavigations = warm.cost.pageNavigations
      meta.networkRequests = warm.cost.networkRequests
      meta.bytesDownloaded = warm.cost.bytesDownloaded
      meta.latencyMs = Math.round(performance.now() - started)

      // After the latency line, and allowed to fail, for the reasons in browser.ts.
      const snapshot = await warm.page.locator('body').ariaSnapshot().catch(() => '')
      meta.llmTokens = countTokens(snapshot)

      // After reading, so a page that moved somewhere disallowed while it was read is not answered from.
      guard?.check()
      return { items, meta }
    } finally {
      await warm.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.close()
  }
}
