import { PolitenessLayer, DEFAULT_USER_AGENT } from './net/politeness.js'
import { RecipeRegistry } from './recipes/registry.js'
import { Executor } from './executor/index.js'
import { HttpJsonStrategy } from './executor/strategies/http-json.js'
import { HttpHtmlStrategy } from './executor/strategies/http-html.js'
import { BrowserStrategy, type BrowserPlan } from './executor/strategies/browser.js'
import { WarmBrowserStrategy } from './executor/strategies/warm-browser.js'
import { SelfHealer } from './healing/index.js'
import { StaticSiteResolver, WILD_ORIGINS, type SiteResolver } from './sites.js'
import type { Intent } from './types.js'

export interface EngineOptions {
  recipeDir: string
  plans: Record<string, Partial<Record<Intent, BrowserPlan>>>
  /** Extra origins, e.g. fixture servers on ephemeral ports. */
  origins?: Record<string, string>
  heal?: boolean
  /** Per-host request spacing. Fixtures pass 0; wild runs keep the 1s default. */
  minIntervalMs?: number
  /** Refuse any URL or redirect target robots.txt disallows, over HTTP and in the browser. */
  enforceRobots?: boolean
}

export interface Engine {
  executor: Executor
  browser: BrowserStrategy
  warm: WarmBrowserStrategy
  healer: SelfHealer
  registry: RecipeRegistry
  sites: SiteResolver
  net: PolitenessLayer
}

export function buildEngine(opts: EngineOptions): Engine {
  const net = new PolitenessLayer({
    userAgent: DEFAULT_USER_AGENT,
    minIntervalMs: opts.minIntervalMs,
    enforceRobots: opts.enforceRobots,
  })
  const guard = opts.enforceRobots ? (url: string) => net.isAllowed(url) : undefined
  const sites = new StaticSiteResolver({ ...WILD_ORIGINS, ...(opts.origins ?? {}) })
  const registry = new RecipeRegistry(opts.recipeDir)
  const browser = new BrowserStrategy(sites, opts.plans, true, guard)
  const warm = new WarmBrowserStrategy(sites, opts.plans, guard)
  const healer = new SelfHealer({ registry, sites, plans: opts.plans, guard })

  const executor = new Executor({
    registry,
    strategies: [new HttpJsonStrategy(net, sites), new HttpHtmlStrategy(net, sites), warm, browser],
    onFallback: opts.heal === false ? undefined : async (event) => {
      const result = await healer.heal(event)
      return {
        unchanged: result.healed && result.changes.length === 0,
        ...(result.refused === null ? {} : { refused: result.refused }),
        ...(result.meta === null ? {} : { meta: result.meta }),
      }
    },
  })

  return { executor, browser, warm, healer, registry, sites, net }
}
