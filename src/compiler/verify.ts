import { extractBySelector } from '../executor/extract.js'
import { diffGolden } from '../benchmark/golden.js'
import type { BrowserPlan } from '../executor/strategies/browser.js'
import type { Trace } from '../recorder/types.js'
import type { Item } from '../types.js'

export interface Equivalence {
  equivalent: boolean
  reasons: string[]
}

/**
 * Checks a candidate recipe's output against what the browser actually
 * extracted from the same visit. This is the golden diff moved to compile
 * time: without it a recipe can point at a plausible-looking endpoint that
 * carries different data — a crate's owners rather than the crate, an
 * article's own URL rather than the discussion link — and nothing notices
 * until the numbers are already wrong.
 */
/** What the browser extracted from this visit, using the plan's own selectors. */
export function browserItemsOf(trace: Trace, plan: BrowserPlan): Item[] {
  return extractBySelector(trace.finalHtml, plan.itemSelector, plan.fields, trace.finalUrl)
}

export function verifyAgainstBrowser(
  trace: Trace,
  plan: BrowserPlan,
  recipeItems: Item[],
): Equivalence {
  const browserItems = browserItemsOf(trace, plan)

  if (browserItems.length === 0) {
    return { equivalent: false, reasons: ['browser extracted nothing to compare against'] }
  }

  // Two extractions that both found nothing agree vacuously. If the browser
  // side carries no values, the plan's selectors are wrong and there is no
  // behaviour to reproduce.
  const populated = browserItems.some((item) =>
    Object.values(item).some((v) => v !== null && v !== undefined && v !== ''))
  if (!populated) {
    return { equivalent: false, reasons: ['browser extracted items with no field values; check the plan selectors'] }
  }

  const diff = diffGolden(
    { taskId: 'compile-check', capturedAt: new Date().toISOString(), items: browserItems },
    recipeItems,
  )
  return { equivalent: diff.match, reasons: diff.reasons }
}
