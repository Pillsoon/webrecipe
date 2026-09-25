import { siteName, intentName, publicUrl, requireReadable } from '../local.js'
import { browserItemsOf } from '../compiler/verify.js'
import { record } from '../recorder/index.js'
import { HeuristicCompiler, templatePath, templatedInputs } from '../compiler/heuristic.js'
import { compileHtmlRecipe } from '../compiler/html.js'
import { isRefused } from '../compiler/types.js'
import { RecipeRegistry } from '../recipes/registry.js'
import { StaticSiteResolver } from '../sites.js'
import { LearnedPlanSchema, saveLearnedPlan, type LearnedPlan } from './plans.js'
import { buildContract } from './contract.js'
import { runQueryProbes, verifyQueryHonored } from '../verification/query-honored.js'
import { verifyLexicalConsistency } from '../verification/lexical-consistency.js'
import { runPaginationProbes, verifyPaginationHonored } from '../verification/pagination-honored.js'
import { Probes, runBaseline } from '../verification/probes.js'
import { renderUrlTemplate } from '../recipes/template.js'
import { PolitenessLayer } from '../net/politeness.js'
import type { BrowserPlan } from '../executor/strategies/browser.js'
import type { Recipe } from '../recipes/schema.js'
import type { Intent, Item } from '../types.js'

/**
 * An agent's answer, turned into a plan and a recipe.
 *
 * Everything below the plan already existed: `SelfHealer` records, compiles and
 * stores, and the only thing it could not do for an unknown site was invent the
 * plan. This supplies one.
 */

export interface TeachOptions {
  site: string
  intent: Intent
  /** A concrete url for a concrete input; the template is derived from both. */
  url: string
  input: Record<string, string | number>
  itemSelector: string
  fields: Record<string, string>
  planDir: string
  recipeDir: string
  /**
   * Skips the probes that cost extra requests. It does not weaken the contract:
   * the check stays required and reads back as untested, so the task is
   * partially verified rather than quietly promoted.
   */
  skipSemanticVerification?: boolean
  /** Per-host spacing for probe requests; fixtures pass 0. */
  minIntervalMs?: number
}

export interface TeachResult {
  plan: LearnedPlan
  sample: Item[]
  planPath: string
  recipe: Recipe | null
  /** Why no HTTP recipe could be built. The plan is stored either way. */
  refused: string | null
}

export async function teach(opts: TeachOptions): Promise<TeachResult> {
  siteName(opts.site); intentName(opts.intent)
  const url = publicUrl(opts.url)
  const path = templatePath(url.pathname, opts.input)
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(templatePath(v, opts.input)).replace(/%7B%7B(\w+)%7D%7D/g, '{{$1}}')}`)
    .join('&')

  const urlTemplate = `${path}${query === '' ? '' : `?${query}`}`

  // A url template that does not carry an input as a placeholder returns the
  // recorded page for every value of that input, forever, with validation
  // passing every time — the plan itself would be the broken thing, unlike a
  // refusal from the compiler that just means the browser fallback must answer.
  const templated = templatedInputs([urlTemplate])
  const missing = Object.entries(opts.input)
    .filter(([, v]) => String(v) !== '')
    .map(([name]) => name)
    .filter((name) => !templated.has(name))
  if (missing.length > 0) {
    throw new Error(`urlTemplate "${urlTemplate}" does not template input(s): ${missing.join(', ')}`)
  }

  // The contract is fixed from what the plan can vary, before a single result
  // is seen. Evidence is filled in below by whatever actually ran.
  const contract = buildContract(opts.intent, templated)

  const plan: LearnedPlan = LearnedPlanSchema.parse({
    origin: url.origin,
    urlTemplate,
    itemSelector: opts.itemSelector,
    fields: opts.fields,
    verification: { contract, evidence: {} },
  })

  const browserPlan: BrowserPlan = {
    url: () => opts.url,
    itemSelector: plan.itemSelector,
    fields: plan.fields,
  }

  const sites = new StaticSiteResolver({ [opts.site]: plan.origin })
  const task = { id: 'teach', site: opts.site, intent: opts.intent, input: opts.input }
  const trace = await record(browserPlan, task, sites)

  try {
    const items = browserItemsOf(trace, browserPlan)
    requireReadable(items, Object.keys(plan.fields))
    // Only checks something actually ran are recorded. A required check with no
    // entry reads back as not_tested, which is the truth; writing that status
    // here would store an outcome no verifier produced.
    plan.verification = {
      contract,
      evidence: { non_empty: { status: 'passed' }, required_fields: { status: 'passed' } },
    }
    const refusals: string[] = []
    let recipe: Recipe | null = null

    const json = await new HeuristicCompiler(browserPlan).compile(trace)
    if (isRefused(json)) refusals.push(`json: ${json.refused}`)
    else recipe = json

    if (recipe === null) {
      const html = compileHtmlRecipe(trace, browserPlan)
      if (isRefused(html)) refusals.push(`html: ${html.refused}`)
      else recipe = html
    }

    // A recipe reaching past the site's own host is refused rather than stored.
    // It is tolerable while every recipe is compiled locally from a site the
    // caller chose, and it is not tolerable once recipes are shared, so the rule
    // is set before anything depends on the looser one.
    if (recipe !== null && recipe.request.origin !== undefined && recipe.request.origin !== plan.origin) {
      refusals.push(`recipe reaches ${recipe.request.origin}, outside ${plan.origin}`)
      recipe = null
    }

    // Probing needs a recipe to judge and a contract that asks for something.
    // It reads the compiled recipe and writes nothing, so a failed probe leaves
    // the plan and the registry exactly as a skipped one does.
    const wantsQuery = contract.required.includes('query_honored')
    const wantsPagination = contract.required.includes('pagination_honored')
    if (recipe !== null && (wantsQuery || wantsPagination) && !opts.skipSemanticVerification) {
      const probes = new Probes({
        recipe,
        browserPlan: {
          url: (origin: string, probe: { input: Record<string, string | number> }) =>
            renderUrlTemplate(origin, plan.urlTemplate, probe.input),
          sameOriginOnly: true,
          itemSelector: plan.itemSelector,
          fields: plan.fields,
        },
        site: opts.site,
        intent: opts.intent,
        input: opts.input,
        net: new PolitenessLayer({ minIntervalMs: opts.minIntervalMs }),
        sites,
      })

      // One baseline for every check. Neither check may depend on the other
      // having run: a list task that pages but takes no query still has to be
      // able to prove its pagination.
      const baseline = await runBaseline(probes, opts.input, wantsQuery ? 'query' : 'page', items)

      if (wantsQuery) {
        const session = await runQueryProbes(probes, baseline, 'query')
        plan.verification.evidence.query_honored = verifyQueryHonored(session)
        plan.verification.evidence.lexical_query_consistency = verifyLexicalConsistency(session)
      }
      if (wantsPagination) {
        plan.verification.evidence.pagination_honored = verifyPaginationHonored(
          await runPaginationProbes(probes, baseline, 'page'),
        )
      }
    }

    // A refused compile must not leave an earlier task's recipe active.
    const registry = new RecipeRegistry(opts.recipeDir)
    await registry.remove(opts.site, opts.intent)
    const planPath = await saveLearnedPlan(opts.planDir, opts.site, opts.intent, plan)
    await registry.clearLearningFailure(opts.site, opts.intent)
    const refused = recipe === null ? refusals.join('; ') : null
    if (recipe !== null) await registry.save(recipe)
    else await registry.setLearningFailure(opts.site, opts.intent, refused!)
    return { plan, planPath, recipe, refused, sample: items.slice(0, 3) }
  } finally { await trace.dispose?.() }
}
