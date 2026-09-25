import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { RecipeRegistry } from '../recipes/registry.js'
import { HttpHtmlStrategy } from '../executor/strategies/http-html.js'
import { HttpJsonStrategy } from '../executor/strategies/http-json.js'
import { validate } from '../validator/index.js'
import type { PolitenessLayer } from '../net/politeness.js'
import type { SiteResolver } from '../sites.js'
import type { BenchTask } from './runner.js'
import type { Intent } from '../types.js'

/**
 * Whether the recipes already on disk still work.
 *
 * `bench run` cannot answer this. It pairs every task with a fresh browser
 * baseline, which doubles what the site is asked for, and it grades against
 * goldens captured days earlier, which reads a site editing its content as a
 * recipe that broke. Durability is a narrower question — does the stored
 * recipe still fetch and validate — and it is asked by replaying the recipe
 * and nothing else.
 */

/** The statuses `src/executor/index.ts` treats as a refusal, for the same reason. */
const BLOCK_STATUSES = new Set([401, 403, 429, 503])

export type Verdict = 'alive' | 'blocked' | 'broken'

export interface RecipeHealth {
  site: string
  intent: Intent
  /** When the stored recipe was last written, which is how old it is. */
  compiledAt: Date
  samples: number
  valid: number
  statuses: number[]
  verdict: Verdict
  reasons: string[]
}

export interface HealthOptions {
  recipeDir: string
  tasks: BenchTask[]
  /** How many tasks to replay per recipe. A block is a property of the site. */
  samples: number
  net: PolitenessLayer
  sites: SiteResolver
}

export async function checkRecipes(opts: HealthOptions): Promise<RecipeHealth[]> {
  const registry = new RecipeRegistry(opts.recipeDir)
  const html = new HttpHtmlStrategy(opts.net, opts.sites)
  const json = new HttpJsonStrategy(opts.net, opts.sites)

  const wanted = new Map<string, BenchTask[]>()
  for (const task of opts.tasks) {
    const key = `${task.site}\u0000${task.intent}`
    const run = wanted.get(key)
    if (run) run.push(task)
    else wanted.set(key, [task])
  }

  const health: RecipeHealth[] = []
  for (const [key, all] of wanted) {
    const [site, intent] = key.split('\u0000') as [string, Intent]
    const recipe = await registry.load(site, intent)
    // A browser recipe has no HTTP path to outlive, so there is nothing here
    // to measure.
    if (recipe === null || recipe.strategy.type === 'browser') continue

    const strategy = recipe.strategy.type === 'http-json' ? json : html
    const statuses: number[] = []
    const reasons: string[] = []
    let valid = 0

    const samples = all.slice(0, opts.samples)
    for (const task of samples) {
      try {
        const result = await strategy.execute(recipe, task)
        if (result.status !== undefined) statuses.push(result.status)
        const outcome = validate(recipe, {
          status: result.status ?? recipe.validation.status,
          payload: result.payload,
          items: result.items,
        })
        if (outcome.valid) valid += 1
        else reasons.push(`${task.id}: ${outcome.reasons.join('; ')}`)
      } catch (err) {
        reasons.push(`${task.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // A refusal outranks a mismatch: a site that answered 403 has stopped
    // serving this client, and whatever the recipe would have parsed is moot.
    const verdict: Verdict = statuses.some((s) => BLOCK_STATUSES.has(s))
      ? 'blocked'
      : valid === samples.length ? 'alive' : 'broken'

    health.push({
      site,
      intent,
      compiledAt: (await stat(join(opts.recipeDir, site, `${intent}.yaml`))).mtime,
      samples: samples.length,
      valid,
      statuses: [...new Set(statuses)],
      verdict,
      reasons,
    })
  }
  return health
}

const age = (from: Date, now: Date): string => {
  const hours = Math.round((now.getTime() - from.getTime()) / 3_600_000)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

export function formatHealth(health: RecipeHealth[], now = new Date()): string {
  const lines = health.map((h) =>
    `  ${h.verdict.padEnd(8)} ${`${h.site} ${h.intent}`.padEnd(34)} ` +
    `${h.valid}/${h.samples} valid  age ${age(h.compiledAt, now).padStart(4)}` +
    `${h.statuses.length > 0 ? `  status ${h.statuses.join(',')}` : ''}`)

  const count = (v: Verdict): number => health.filter((h) => h.verdict === v).length
  return [
    ...lines,
    '',
    `  alive ${count('alive')}   blocked ${count('blocked')}   broken ${count('broken')}   of ${health.length}`,
  ].join('\n')
}
