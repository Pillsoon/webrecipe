import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { startSsrFixture } from '../../fixtures/ssr.js'
import { startRefusingFixture } from '../../fixtures/refusing.js'
import type { FixtureServer } from '../../fixtures/harness.js'
import { checkRecipes } from '../../src/benchmark/health.js'
import { PolitenessLayer } from '../../src/net/politeness.js'
import { StaticSiteResolver } from '../../src/sites.js'
import type { BenchTask } from '../../src/benchmark/runner.js'

let ssr: FixtureServer
let refusing: FixtureServer

const RECIPE_DIR = join(process.cwd(), 'recipes')

const tasks: BenchTask[] = [
  { id: 'a-1', set: 'wild', site: 'siteA', intent: 'search', input: { query: 'rust' } },
  { id: 'r-1', set: 'wild', site: 'siteRefusing', intent: 'search', input: { query: 'rust' } },
]

beforeAll(async () => { ssr = await startSsrFixture(); refusing = await startRefusingFixture() })
afterAll(async () => { await ssr.close(); await refusing.close() })

const check = () => checkRecipes({
  recipeDir: RECIPE_DIR,
  tasks,
  samples: 1,
  net: new PolitenessLayer({ minIntervalMs: 0 }),
  sites: new StaticSiteResolver({ siteA: ssr.url, siteRefusing: refusing.url }),
})

describe('checkRecipes', () => {
  it('calls a recipe alive when its own site still answers it', async () => {
    const alive = (await check()).find((h) => h.site === 'siteA')
    expect(alive).toMatchObject({ intent: 'search', samples: 1, valid: 1, verdict: 'alive' })
  })

  it('calls a recipe blocked when the site refuses its client', async () => {
    const blocked = (await check()).find((h) => h.site === 'siteRefusing')
    expect(blocked).toMatchObject({ samples: 1, valid: 0, verdict: 'blocked' })
    expect(blocked!.statuses).toContain(403)
  })

  it('reports nothing for a site with no task to replay', async () => {
    const health = await checkRecipes({
      recipeDir: RECIPE_DIR,
      tasks: [],
      samples: 1,
      net: new PolitenessLayer({ minIntervalMs: 0 }),
      sites: new StaticSiteResolver({}),
    })
    expect(health).toEqual([])
  })
})
