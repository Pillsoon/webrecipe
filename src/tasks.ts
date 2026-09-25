import { localPaths, verifyReadable, verificationWarnings, UserError, type ReadabilityVerification } from './local.js'
import { buildEngine } from './wiring.js'
import { loadLearnedPlans, mergePlans } from './authoring/plans.js'
import { PLANS } from '../benchmark/plans.js'
import { WILD_ORIGINS } from './sites.js'
import type { ExecutionOutcome } from './executor/index.js'
import type { Intent } from './types.js'

/**
 * What the CLI and the MCP server share: a saved recipe, fetched.
 *
 * Both front ends print differently and log differently, so the printing and
 * the logging stay with them. The work — load what was saved, refuse a task
 * that was never saved, run it, verify what came back — is the same in both
 * and lives here once.
 */

export type TaskInput = Record<string, string | number>

export interface FetchResult {
  outcome: ExecutionOutcome
  verification: ReadabilityVerification
  warnings: string[]
}

/** The hand-written plans, with anything saved layered over them. */
export async function allPlans(planDir: string) {
  const learned = await loadLearnedPlans(planDir)
  return { plans: mergePlans(PLANS, learned.plans), origins: learned.origins, verifications: learned.verifications }
}

/** Every saved task, as `site/intent`, with its storage directory. */
export async function listTasks(dataDir?: string): Promise<{ root: string; tasks: string[] }> {
  const paths = localPaths(dataDir)
  const { plans } = await loadLearnedPlans(paths.plans)
  const tasks = Object.entries(plans).flatMap(([site, intents]) => Object.keys(intents).map((intent) => `${site}/${intent}`))
  return { root: paths.root, tasks }
}

export async function fetchTask(
  site: string,
  intent: Intent,
  input: TaskInput,
  opts: { dataDir?: string; heal?: boolean; runId?: string } = {},
): Promise<FetchResult> {
  const paths = localPaths(opts.dataDir)
  const { plans, origins, verifications } = await allPlans(paths.plans)
  const plan = plans[site]?.[intent]
  if (!plan) throw new UserError('NOT_TAUGHT', `No recipe saved as ${site}/${intent}. Run inspect on the page, then save.`)
  // Reject missing placeholders before starting a browser or making a request.
  plan.url(origins[site] ?? WILD_ORIGINS[site]!, { id: 'check', site, intent, input })
  const engine = buildEngine({ recipeDir: paths.recipes, plans, origins, heal: opts.heal })
  try {
    const outcome = await engine.executor.run({ id: opts.runId ?? 'fetch', site, intent, input })
    const verification = verifyReadable(outcome.items, Object.keys(plan.fields), verifications[site]?.[intent])
    // Derived from the checks, so a run that proves more says less.
    const warnings = [...outcome.reasons, ...verificationWarnings(verification)]
    return { outcome, verification, warnings }
  } finally { await engine.warm.close() }
}
