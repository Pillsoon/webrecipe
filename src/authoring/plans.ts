import { atomicWrite, siteName, intentName, publicUrl, PlanVerificationSchema, type PlanVerification } from '../local.js'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { renderUrlTemplate } from '../recipes/template.js'
import type { BrowserPlan } from '../executor/strategies/browser.js'
import type { Intent } from '../types.js'

/**
 * A plan an agent taught, as a file.
 *
 * `benchmark/plans.ts` is the benchmark's fixed input and must not start
 * varying with what anyone has learned, so learned plans live apart and carry
 * their own origin. That is what removes the need to edit two TypeScript files
 * before the engine can visit a site it has never seen.
 */
export const LearnedPlanSchema = z.object({
  origin: z.string().url(),
  /** Rendered against the task's input, so one plan serves every input. */
  urlTemplate: z.string().min(1),
  itemSelector: z.string().min(1),
  fields: z.record(z.string()).refine((f) => Object.keys(f).length > 0, 'a plan with no fields extracts nothing'),
  /**
   * What this task must prove, and what it has proven. Optional because plans
   * taught before contracts existed must keep loading; without one a run is
   * reported as structural and never as verified.
   */
  verification: PlanVerificationSchema.optional(),
})

export type LearnedPlan = z.infer<typeof LearnedPlanSchema>

const INTENTS: Intent[] = ['search', 'list', 'detail']

export async function saveLearnedPlan(
  dir: string, site: string, intent: Intent, plan: LearnedPlan,
): Promise<string> {
  siteName(site); intentName(intent)
  const parsed = LearnedPlanSchema.parse(plan)
  publicUrl(parsed.origin)
  await mkdir(join(dir, site), { recursive: true })
  const path = join(dir, site, `${intent}.json`)
  await atomicWrite(path, `${JSON.stringify(parsed, null, 2)}\n`)
  return path
}

/**
 * Hand-written plans with learned ones layered over them, per intent.
 *
 * Merging at the site key instead would drop every hand-written intent for a
 * site the moment one of its intents was taught.
 */
export function mergePlans(
  hand: Record<string, Partial<Record<Intent, BrowserPlan>>>,
  learned: Record<string, Partial<Record<Intent, BrowserPlan>>>,
): Record<string, Partial<Record<Intent, BrowserPlan>>> {
  const merged: Record<string, Partial<Record<Intent, BrowserPlan>>> = { ...hand }
  for (const [site, intents] of Object.entries(learned)) {
    merged[site] = { ...merged[site], ...intents }
  }
  return merged
}

export async function loadLearnedPlans(dir: string): Promise<{
  plans: Record<string, Partial<Record<Intent, BrowserPlan>>>
  origins: Record<string, string>
  verifications: Record<string, Partial<Record<Intent, PlanVerification>>>
  /** The stored plan itself, which an observation digests to say what question it answered. */
  raw: Record<string, Partial<Record<Intent, LearnedPlan>>>
}> {
  const sites = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
  const plans: Record<string, Partial<Record<Intent, BrowserPlan>>> = {}
  const origins: Record<string, string> = {}
  const verifications: Record<string, Partial<Record<Intent, PlanVerification>>> = {}
  const rawPlans: Record<string, Partial<Record<Intent, LearnedPlan>>> = {}

  for (const entry of sites) {
    if (!entry.isDirectory()) continue
    for (const intent of INTENTS) {
      const path = join(dir, entry.name, `${intent}.json`)
      const raw = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (raw === null) continue

      let plan: LearnedPlan
      try {
        plan = LearnedPlanSchema.parse(JSON.parse(raw))
      } catch (cause) {
        throw new Error(`corrupt learned plan at ${path}`, { cause })
      }
      publicUrl(plan.origin)
      if (origins[entry.name] && origins[entry.name] !== plan.origin) throw new Error(`conflicting origins for ${entry.name}`)
      origins[entry.name] = plan.origin
      if (plan.verification) verifications[entry.name] = { ...verifications[entry.name], [intent]: plan.verification }
      rawPlans[entry.name] = { ...rawPlans[entry.name], [intent]: plan }
      plans[entry.name] = {
        ...plans[entry.name],
        [intent]: {
          url: (origin, task) => renderUrlTemplate(origin, plan.urlTemplate, task.input),
          sameOriginOnly: true,
          itemSelector: plan.itemSelector,
          fields: plan.fields,
        } satisfies BrowserPlan,
      }
    }
  }
  return { plans, origins, verifications, raw: rawPlans }
}
