import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSsrFixture } from '../../fixtures/ssr.js'
import { startPageIgnoringFixture } from '../../fixtures/paging.js'
import type { FixtureServer } from '../../fixtures/harness.js'
import { teach } from '../../src/authoring/teach.js'
import { verifyReadable } from '../../src/local.js'
import type { Intent } from '../../src/types.js'

let ssr: FixtureServer
beforeAll(async () => { ssr = await startSsrFixture() })
afterAll(async () => { await ssr.close() })

const FIELDS = { title: 'a.title', url: 'a.title@href' }

const teachOn = async (fixture: FixtureServer, opts: {
  site: string; intent?: Intent; query?: string; page?: number
}) => {
  const planDir = await mkdtemp(join(tmpdir(), 'page-plans-'))
  const recipeDir = await mkdtemp(join(tmpdir(), 'page-recipes-'))
  const params = [
    ...(opts.query === undefined ? [] : [`q=${encodeURIComponent(opts.query)}`]),
    ...(opts.page === undefined ? [] : [`page=${opts.page}`]),
  ].join('&')
  const input: Record<string, string | number> = {
    ...(opts.query === undefined ? {} : { query: opts.query }),
    ...(opts.page === undefined ? {} : { page: opts.page }),
  }
  return teach({
    site: opts.site, intent: opts.intent ?? 'search',
    url: `${fixture.url}/search${params === '' ? '' : `?${params}`}`,
    input, itemSelector: 'li.result', fields: FIELDS,
    planDir, recipeDir, minIntervalMs: 0,
  })
}

const pagination = (plan: { verification?: { evidence: Record<string, unknown> } }) =>
  plan.verification?.evidence.pagination_honored as
    | { status: string; probes?: { role: string; value: string }[]; signals?: Record<string, boolean>; shares?: { overlap?: number }; reason?: string }
    | undefined

describe('a task that never exposes a page', () => {
  // Pagination must not cost coverage to a task that promised nothing about it.
  it('is asked nothing about pagination and can still reach verified', async () => {
    const result = await teachOn(ssr, { site: 'siteNoPage', query: 'rust' })
    const contract = result.plan.verification!.contract
    expect(contract.required).not.toContain('pagination_honored')
    expect(result.plan.verification!.evidence.pagination_honored).toBeUndefined()

    const verification = verifyReadable(result.sample, Object.keys(FIELDS), result.plan.verification)
    expect(verification.status).toBe('verified')
  }, 60_000)
})

describe('a task that pages but takes no query', () => {
  // The structural reason this matters: pagination evidence must not be
  // reachable only through the query verifier's probes.
  it('verifies its pagination with no query check in the contract at all', async () => {
    const result = await teachOn(ssr, { site: 'siteListOnly', intent: 'list', page: 1 })
    const contract = result.plan.verification!.contract
    expect(contract.required).toEqual(['non_empty', 'required_fields', 'pagination_honored'])
    expect(result.plan.verification!.evidence.query_honored).toBeUndefined()

    expect(pagination(result.plan)?.status).toBe('passed')
    const verification = verifyReadable(result.sample, Object.keys(FIELDS), result.plan.verification)
    expect(verification.status).toBe('verified')
  }, 60_000)
})

describe('choosing the page to compare against', () => {
  // Taught on page 3, a probe for page 4 would still work here; what must not
  // happen is reaching past the end on a task taught near it.
  it('reaches for the page before when the task was not taught on the first', async () => {
    const result = await teachOn(ssr, { site: 'sitePageThree', intent: 'list', page: 3 })
    const probes = pagination(result.plan)?.probes ?? []
    expect(probes.find((p) => p.role === 'taught')?.value).toBe('3')
    expect(probes.find((p) => p.role === 'alternate')?.value).toBe('2')
    expect(pagination(result.plan)?.status).toBe('passed')
  }, 60_000)

  it('reaches for the page after when it was', async () => {
    const result = await teachOn(ssr, { site: 'sitePageOne', intent: 'list', page: 1 })
    const probes = pagination(result.plan)?.probes ?? []
    expect(probes.find((p) => p.role === 'alternate')?.value).toBe('2')
  }, 60_000)
})

describe('a recipe whose page control does nothing', () => {
  it('fails when the browser moves between pages and the recipe does not', async () => {
    const fixture = await startPageIgnoringFixture({ browserPaginates: true })
    try {
      const result = await teachOn(fixture, { site: 'sitePageStale', intent: 'list', page: 1 })
      const evidence = pagination(result.plan)
      expect(evidence?.status).toBe('failed')
      expect(evidence?.signals?.moved).toBe(false)
      expect(evidence?.reason).toMatch(/page control does nothing/)
    } finally { await fixture.close() }
  }, 60_000)

  // The same shape from the outside, and not something a verifier can call
  // broken: a site with one page answers this way too.
  it('withholds a verdict when the browser does not move either', async () => {
    const fixture = await startPageIgnoringFixture({ browserPaginates: false })
    try {
      const result = await teachOn(fixture, { site: 'sitePageFixed', intent: 'list', page: 1 })
      const evidence = pagination(result.plan)
      expect(evidence?.status).toBe('not_tested')
      expect(evidence?.status).not.toBe('failed')
      expect(evidence?.reason).toMatch(/clamps the page or has only one/)
    } finally { await fixture.close() }
  }, 60_000)
})
