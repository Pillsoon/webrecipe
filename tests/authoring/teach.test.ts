import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSsrFixture } from '../../fixtures/ssr.js'
import type { FixtureServer } from '../../fixtures/harness.js'
import { teach } from '../../src/authoring/teach.js'
import { loadLearnedPlans } from '../../src/authoring/plans.js'
import { RecipeRegistry } from '../../src/recipes/registry.js'

let ssr: FixtureServer
beforeAll(async () => { ssr = await startSsrFixture() })
afterAll(async () => { await ssr.close() })

const run = async () => {
  const planDir = await mkdtemp(join(tmpdir(), 'teach-plans-'))
  const recipeDir = await mkdtemp(join(tmpdir(), 'teach-recipes-'))
  const result = await teach({
    site: 'siteLearned',
    intent: 'search',
    url: `${ssr.url}/search?q=rust`,
    input: { query: 'rust' },
    itemSelector: 'li.result',
    fields: { title: 'a.title', url: 'a.title@href' },
    planDir,
    recipeDir,
  })
  return { result, planDir, recipeDir }
}

describe('teach', () => {
  it('derives a url template from the concrete url and the input', async () => {
    const { result } = await run()
    expect(result.plan.urlTemplate).toBe('/search?q={{query}}')
    expect(result.plan.itemSelector).toBe('li.result')
  })

  it('compiles a recipe that needs no browser', async () => {
    const { result, recipeDir } = await run()
    expect(result.refused).toBeNull()
    expect(result.recipe?.strategy.type).toBe('http-html')
    const stored = await new RecipeRegistry(recipeDir).load('siteLearned', 'search')
    expect(stored?.output).toMatchObject({ type: 'html', items: { selector: 'li.result' } })
  })

  it('stores a plan the loader turns back into a usable BrowserPlan', async () => {
    const { planDir } = await run()
    const { plans, origins } = await loadLearnedPlans(planDir)
    expect(origins.siteLearned).toBe(ssr.url)
    const plan = plans.siteLearned?.search
    expect(plan!.url(ssr.url, {
      id: 't', site: 'siteLearned', intent: 'search', input: { query: 'go' },
    })).toBe(`${ssr.url}/search?q=go`)
  })

  // The contract comes from what the plan can vary, not from what the recorded
  // result happened to satisfy, so a search that templates its query is on the
  // hook for query_honored from the moment it is taught.
  it('writes a verification contract derived from what the plan can vary', async () => {
    const { planDir } = await run()
    const { verifications } = await loadLearnedPlans(planDir)
    expect(verifications.siteLearned?.search?.contract).toEqual({
      required: ['non_empty', 'required_fields', 'query_honored', 'lexical_query_consistency'],
    })
  })

  it('leaves the required semantic check untested when probing is skipped', async () => {
    const planDir = await mkdtemp(join(tmpdir(), 'teach-plans-'))
    const recipeDir = await mkdtemp(join(tmpdir(), 'teach-recipes-'))
    const result = await teach({
      site: 'siteLearned', intent: 'search',
      url: `${ssr.url}/search?q=rust`, input: { query: 'rust' },
      itemSelector: 'li.result', fields: { title: 'a.title', url: 'a.title@href' },
      planDir, recipeDir, skipSemanticVerification: true,
    })
    expect(result.plan.verification?.contract.required).toContain('query_honored')
    expect(result.plan.verification?.evidence.query_honored).toBeUndefined()
    expect(result.plan.verification?.evidence.non_empty).toEqual({ status: 'passed' })
  })

  it('rejects a url that does not template a required input, before a browser launches', async () => {
    const planDir = await mkdtemp(join(tmpdir(), 'teach-plans-'))
    const recipeDir = await mkdtemp(join(tmpdir(), 'teach-recipes-'))
    // Unreachable: if the guard did not run before `record()`, this would fail
    // on a browser navigation error instead of the validation message asserted
    // below, so the assertion also proves the ordering.
    await expect(teach({
      site: 'siteLearned', intent: 'search', url: 'http://127.0.0.1:1/search',
      input: { query: 'rust' }, itemSelector: 'li.result', fields: { title: 'a.title' },
      planDir, recipeDir,
    })).rejects.toThrow(/does not template input\(s\): query/)
  })

  it('refuses a plan whose fields would extract nothing', async () => {
    const planDir = await mkdtemp(join(tmpdir(), 'teach-plans-'))
    const recipeDir = await mkdtemp(join(tmpdir(), 'teach-recipes-'))
    await expect(teach({
      site: 'siteLearned', intent: 'search', url: `${ssr.url}/search?q=rust`,
      input: { query: 'rust' }, itemSelector: 'li.result', fields: {},
      planDir, recipeDir,
    })).rejects.toThrow()
  })
})
