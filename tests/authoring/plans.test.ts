import { describe, it, expect } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnedPlanSchema, saveLearnedPlan, loadLearnedPlans, mergePlans, type LearnedPlan } from '../../src/authoring/plans.js'

const plan = {
  origin: 'https://news.ycombinator.com',
  urlTemplate: '/news?p={{page}}',
  itemSelector: 'tr.athing',
  fields: { id: '@id', title: 'span.titleline > a' },
}

describe('LearnedPlanSchema', () => {
  it('accepts a complete plan', () => {
    expect(LearnedPlanSchema.parse(plan).itemSelector).toBe('tr.athing')
  })

  it('rejects an origin that is not a url', () => {
    expect(() => LearnedPlanSchema.parse({ ...plan, origin: 'news.ycombinator.com' })).toThrow()
  })

  it('rejects a plan with no fields, which would extract nothing', () => {
    expect(() => LearnedPlanSchema.parse({ ...plan, fields: {} })).toThrow()
  })
})

describe('saving and loading', () => {
  it('round-trips a plan into a BrowserPlan that renders its template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plans-'))
    await saveLearnedPlan(dir, 'news.ycombinator.com', 'list', plan)

    const { plans, origins } = await loadLearnedPlans(dir)
    expect(origins).toEqual({ 'news.ycombinator.com': 'https://news.ycombinator.com' })

    const loaded = plans['news.ycombinator.com']?.list
    expect(loaded).toBeDefined()
    expect(loaded!.itemSelector).toBe('tr.athing')
    expect(loaded!.url('https://news.ycombinator.com', {
      id: 't', site: 'news.ycombinator.com', intent: 'list', input: { page: 2 },
    })).toBe('https://news.ycombinator.com/news?p=2')
  })

  it('returns empty maps when the directory does not exist', async () => {
    expect(await loadLearnedPlans(join(tmpdir(), 'plans-absent-xyz'))).toEqual({ plans: {}, origins: {}, verifications: {}, raw: {} })
  })

  it('names the file when a stored plan fails to parse', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plans-'))
    await mkdir(join(dir, 'siteC'), { recursive: true })
    const path = join(dir, 'siteC', 'list.json')
    await writeFile(path, '{ not json', 'utf8')

    await expect(loadLearnedPlans(dir)).rejects.toThrow(path)
  })
})

describe('mergePlans', () => {
  it('keeps a hand-written intent for a site whose other intent was taught', () => {
    const stub = { url: () => 'x', itemSelector: 'li', fields: { a: '' } }
    const merged = mergePlans(
      { siteA: { list: stub, detail: stub } },
      { siteA: { search: stub } },
    )
    expect(Object.keys(merged.siteA!).sort()).toEqual(['detail', 'list', 'search'])
  })

  it('lets a learned plan replace a hand-written one for the same intent', () => {
    const hand = { url: () => 'hand', itemSelector: 'li', fields: { a: '' } }
    const taught = { url: () => 'taught', itemSelector: 'li', fields: { a: '' } }
    const merged = mergePlans({ siteA: { search: hand } }, { siteA: { search: taught } })
    expect(merged.siteA!.search!.url('', { id: 't', site: 'siteA', intent: 'search', input: {} })).toBe('taught')
  })
})

describe('stored verification', () => {
  const contracted = {
    ...plan,
    verification: {
      contract: { required: ['non_empty', 'required_fields', 'pagination_honored'] },
      evidence: { non_empty: { status: 'passed' } },
    },
  } satisfies LearnedPlan

  it('rejects a check name it does not implement, at load rather than at run', () => {
    expect(() => LearnedPlanSchema.parse({
      ...plan, verification: { contract: { required: ['non_empty', 'freshness'] }, evidence: {} },
    })).toThrow()
    expect(() => LearnedPlanSchema.parse({
      ...plan, verification: { contract: { required: ['non_empty'] }, evidence: { non_empty: { status: 'probably' } } },
    })).toThrow()
  })

  it('round-trips the contract and evidence beside the plan', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plans-'))
    await saveLearnedPlan(dir, 'news.ycombinator.com', 'list', contracted)

    const { verifications } = await loadLearnedPlans(dir)
    expect(verifications['news.ycombinator.com']?.list).toEqual(contracted.verification)
  })

  // Plans taught before contracts existed must keep working; they simply cannot
  // claim more than structural validity.
  it('loads a plan that has no verification at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plans-'))
    await saveLearnedPlan(dir, 'news.ycombinator.com', 'list', plan)

    const { plans, verifications } = await loadLearnedPlans(dir)
    expect(plans['news.ycombinator.com']?.list).toBeDefined()
    expect(verifications['news.ycombinator.com']).toBeUndefined()
  })
})
