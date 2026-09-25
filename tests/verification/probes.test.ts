import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSsrFixture } from '../../fixtures/ssr.js'
import { startIgnoringFixture } from '../../fixtures/ignoring.js'
import { startShiftedFixture } from '../../fixtures/shifted.js'
import { startVolatileFixture } from '../../fixtures/volatile.js'
import { startLimitingFixture } from '../../fixtures/limiting.js'
import { startCloakingFixture } from '../../fixtures/cloaking.js'
import type { FixtureServer } from '../../fixtures/harness.js'
import { teach } from '../../src/authoring/teach.js'
import { HTTP_PROBE_BUDGET } from '../../src/verification/query-honored.js'
import { querySemantics } from '../../src/benchmark/grade.js'
import { DEFAULT_ORACLE } from '../../src/benchmark/oracle.js'

let honest: FixtureServer
let ignoring: FixtureServer
let shifted: FixtureServer
let volatile_: FixtureServer
let limited: FixtureServer
let down: FixtureServer
let cloaking: FixtureServer

beforeAll(async () => {
  ;[honest, ignoring, shifted, volatile_, limited, down] = await Promise.all([
    startSsrFixture(), startIgnoringFixture(), startShiftedFixture(), startVolatileFixture(),
    startLimitingFixture(429), startLimitingFixture(503),
  ])
  cloaking = await startCloakingFixture()
})
afterAll(async () => {
  await Promise.all([honest.close(), ignoring.close(), shifted.close(), volatile_.close(), limited.close(), down.close(), cloaking.close()])
})

const teachFrom = async (fixture: FixtureServer, site: string, opts: { skip?: boolean } = {}) => {
  const planDir = await mkdtemp(join(tmpdir(), 'probe-plans-'))
  const recipeDir = await mkdtemp(join(tmpdir(), 'probe-recipes-'))
  const result = await teach({
    site, intent: 'search',
    url: `${fixture.url}/search?q=rust`,
    input: { query: 'rust' },
    itemSelector: 'li.result',
    fields: { title: 'a.title', url: 'a.title@href' },
    planDir, recipeDir,
    minIntervalMs: 0,
    ...(opts.skip === true ? { skipSemanticVerification: true } : {}),
  })
  return { result, planDir, recipeDir }
}

const evidenceOf = (plan: { verification?: { evidence: Record<string, unknown> } }) =>
  plan.verification?.evidence.query_honored as
    | { status: string; probes?: { role: string; items: number | null }[]; signals?: Record<string, boolean>; reason?: string }
    | undefined

describe('an endpoint that filters on its query', () => {
  it('is proven to honour it, and the plan reaches verified', async () => {
    const { result } = await teachFrom(honest, 'siteHonest')
    const evidence = evidenceOf(result.plan)
    expect(evidence?.status).toBe('passed')
    expect(evidence?.signals).toEqual({ stable: true, responsive: true, nonce_rejected: true, agreed: true })
    expect(result.plan.verification?.contract.required).toEqual(['non_empty', 'required_fields', 'query_honored', 'lexical_query_consistency'])
  })

  it('spends its request budget and no more', async () => {
    const before = honest.requestLog.length
    await teachFrom(honest, 'siteHonest')
    const probeRequests = honest.requestLog.slice(before).filter((u) => u.startsWith('/search'))
    // The taught record, the four probes, and the browser reference page. No
    // retry storm, and nothing re-fetched after a verdict was reached.
    expect(probeRequests.length).toBeLessThanOrEqual(HTTP_PROBE_BUDGET + 2)
  })
})

describe('an endpoint that discards its query', () => {
  it('is caught, and the failure names the evidence rather than a status code', async () => {
    const { result } = await teachFrom(ignoring, 'siteIgnoring')
    const evidence = evidenceOf(result.plan)
    expect(evidence?.status).toBe('failed')
    expect(evidence?.reason).toMatch(/returned the taught result unchanged/)
    // The probe that proved it is stored with the value it used, so the same
    // run can be repeated later.
    expect(evidence?.probes?.find((p) => p.role === 'nonce')?.items).toBe(10)
  })

  it('still compiles and stores a recipe, because verification is not execution', async () => {
    const { result } = await teachFrom(ignoring, 'siteIgnoring')
    expect(result.recipe).not.toBeNull()
    expect(result.refused).toBeNull()
  })
})

describe('the boundary of what these probes prove', () => {
  // The case that has to stay visible: every signal the verifier reads is true
  // and the answer is about the wrong records.
  it('passes an endpoint that honours the query and answers with the wrong records', async () => {
    const { result } = await teachFrom(shifted, 'siteShifted')
    expect(evidenceOf(result.plan)?.status).toBe('passed')
  })

  it('and the benchmark oracle, judging independently, says the answer is wrong', async () => {
    const { result } = await teachFrom(shifted, 'siteShifted')
    expect(evidenceOf(result.plan)?.status).toBe('passed')

    const oracle = {
      ...DEFAULT_ORACLE,
      semantics: { input: 'query', fields: ['title'], match: 'contains-token' as const, minShare: 0.5 },
    }
    const verdict = querySemantics(result.sample, { query: 'rust' }, oracle)
    expect(verdict.match).toBe(false)
    expect(verdict.reasons.join(' ')).toMatch(/no token of "rust"/)
  })

  it('and the honest endpoint satisfies that same oracle, so the fixture is not simply broken', async () => {
    const { result } = await teachFrom(honest, 'siteHonest')
    const oracle = {
      ...DEFAULT_ORACLE,
      semantics: { input: 'query', fields: ['title'], match: 'contains-token' as const, minShare: 0.5 },
    }
    expect(querySemantics(result.sample, { query: 'rust' }, oracle).match).toBe(true)
  })
})

describe('sites the probes decline to judge', () => {
  // taught != repeat => stability false => never passed.
  it('refuses to judge a listing that changes between identical requests', async () => {
    const { result } = await teachFrom(volatile_, 'siteVolatile')
    const evidence = evidenceOf(result.plan)
    expect(evidence?.signals?.stable).toBe(false)
    expect(evidence?.status).toBe('not_tested')
    expect(evidence?.reason).toMatch(/two identical requests/)
  })

  // A transport failure is never a semantic verdict. Were either of these
  // `failed`, an afternoon of rate limits or one bad deploy would mark every
  // working integration unverified.
  // The rate limit states an hour-long Retry-After, which the politeness layer
  // refuses rather than serves, so it reaches the verifier as a thrown refusal
  // and the outage reaches it as a status. Both are transport, neither is a
  // verdict, and the reasons are asserted as they actually arrive.
  it.each([
    ['a rate limit', () => limited, /retry later/],
    ['an outage', () => down, /site declined with 503/],
  ])('reads %s as undecided rather than as a broken query', async (_label, fixture, expected) => {
    const { result } = await teachFrom(fixture(), 'siteLimiting')
    const evidence = evidenceOf(result.plan)
    expect(evidence?.status).toBe('not_tested')
    expect(evidence?.status).not.toBe('failed')
    expect(evidence?.reason).toMatch(expected)
    // The taught query is the one this site answers; every probe that asks
    // anything else is turned away, and none of them is read as a verdict.
    expect(evidence?.probes?.filter((p) => p.items === null).length).toBeGreaterThan(0)
  })

  // Every HTTP-only signal holds and the two transports still disagree, so the
  // browser reference is doing work no amount of HTTP probing could.
  it('refuses to judge a site that answers the recipe and the browser differently', async () => {
    const { result } = await teachFrom(cloaking, 'siteCloaking')
    const evidence = evidenceOf(result.plan)
    expect(evidence?.signals).toMatchObject({ stable: true, responsive: true, nonce_rejected: true, agreed: false })
    expect(evidence?.status).toBe('not_tested')
    expect(evidence?.reason).toMatch(/recipe and the browser saw different items/)
  })

  it('does not sit out an hour-long Retry-After while probing', async () => {
    const before = Date.now()
    await teachFrom(limited, 'siteLimiting')
    expect(Date.now() - before).toBeLessThan(30_000)
  })
})

describe('skipping the probes', () => {
  it('leaves the requirement standing and the check untested', async () => {
    const { result } = await teachFrom(honest, 'siteHonest', { skip: true })
    expect(result.plan.verification?.contract.required).toContain('query_honored')
    expect(evidenceOf(result.plan)).toBeUndefined()
  })

  it('costs no probe requests at all', async () => {
    const before = honest.requestLog.length
    await teachFrom(honest, 'siteHonest', { skip: true })
    expect(honest.requestLog.slice(before).filter((u) => u.startsWith('/search')).length).toBe(1)
  })
})

describe('what probing must not touch', () => {
  it('stores the same recipe whether or not the probes ran', async () => {
    const probed = await teachFrom(honest, 'siteHonest')
    const skipped = await teachFrom(honest, 'siteHonest', { skip: true })
    const read = (dir: string) => readFile(join(dir, 'siteHonest', 'search.yaml'), 'utf8')
    expect(await read(probed.recipeDir)).toBe(await read(skipped.recipeDir))
  })

  it('records a failed check without weakening the plan it was taught', async () => {
    const probed = await teachFrom(ignoring, 'siteIgnoring')
    const skipped = await teachFrom(ignoring, 'siteIgnoring', { skip: true })
    expect(probed.result.plan.urlTemplate).toBe(skipped.result.plan.urlTemplate)
    expect(probed.result.plan.fields).toEqual(skipped.result.plan.fields)
    expect(probed.result.plan.verification?.contract).toEqual(skipped.result.plan.verification?.contract)
  })
})
