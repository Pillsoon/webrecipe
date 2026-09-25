import { describe, expect, it } from 'vitest'
import { buildCases, classifyNotTested, judgeByTask, entityIdApplicable, detailMismatch, DISCOVERY_DOMAINS, HELD_OUT_DOMAINS } from '../../src/benchmark/discovery.js'
import { PolitenessLayer } from '../../src/net/politeness.js'
import { startFixture, sendHtml } from '../../fixtures/harness.js'
import type { BenchTask } from '../../src/benchmark/runner.js'

const task = (over: Partial<BenchTask> & { id: string }): BenchTask => ({
  set: 'wild', site: 'hex.pm', intent: 'search', input: { query: 'plug' }, ...over,
} as BenchTask)

describe('the corpus split', () => {
  // Domain-level, so one site's idiosyncrasy cannot inform a verifier and then
  // be met again in what is meant to be untouched.
  it('shares no domain between discovery and held-out', () => {
    expect(DISCOVERY_DOMAINS.filter((d) => HELD_OUT_DOMAINS.includes(d))).toEqual([])
  })

  it('teaches on one input per site and intent, and judges the rest', () => {
    const cases = buildCases([
      task({ id: 'a' }), task({ id: 'b', input: { query: 'ecto' } }),
      task({ id: 'c', intent: 'detail', input: { id: 'plug' } }),
      task({ id: 'd', site: 'itch.io' }),
    ], ['hex.pm'])

    expect(cases).toHaveLength(2)
    const search = cases.find((c) => c.intent === 'search')!
    expect(search.taught.id).toBe('a')
    expect(search.unseen.map((t) => t.id)).toEqual(['b'])
    // A held-out domain does not appear at all.
    expect(cases.some((c) => c.site === 'itch.io')).toBe(false)
  })

  it('always keeps a task that expects nothing, which carries its own oracle', () => {
    const many = Array.from({ length: 8 }, (_, i) => task({ id: `t${i}`, input: { query: `q${i}` } }))
    const cases = buildCases([...many, task({ id: 'empty', expectEmpty: true })], ['hex.pm'])
    expect(cases[0]!.unseen.map((t) => t.id)).toContain('empty')
    expect(cases[0]!.unseen.length).toBeLessThanOrEqual(4)
  })
})

describe('classifying why a check went untested', () => {
  it.each([
    ['rate_limited', { status: 'not_tested', probes: [{ role: 'nonce', value: 'x', items: null, unavailable: 'site declined with 429' }] }],
    ['transport_failure', { status: 'not_tested', probes: [{ role: 'nonce', value: 'x', items: null, unavailable: 'site declined with 503' }] }],
    ['volatile', { status: 'not_tested', signals: { stable: false } }],
    ['no_visible_lexical_match', { status: 'not_tested', signals: { applicable: false } }],
    ['lexical_inconsistent', { status: 'not_tested', signals: { applicable: true, consistent: false } }],
    ['browser_disagreement', { status: 'not_tested', signals: { stable: true, agreed: false } }],
    ['page_control_ambiguous', { status: 'not_tested', signals: { stable: true, moved: false } }],
    ['empty_alternate_page', { status: 'not_tested', signals: { stable: true }, probes: [{ role: 'alternate', value: '2', items: 0 }] }],
    ['insufficient_evidence', undefined],
  ] as const)('reads %s off the evidence the verifier already records', (expected, evidence) => {
    expect(classifyNotTested(evidence as never)).toBe(expected)
  })

  // The signal that the taxonomy needs a new entry, rather than a silent bucket.
  it('says so when nothing recorded explains it', () => {
    expect(classifyNotTested({ status: 'not_tested', signals: { stable: true }, probes: [{ role: 'contrast', value: 'x', items: 3 }] } as never)).toBe('unclassified')
  })
})

describe('whether the id oracle can be applied at all', () => {
  const lookup = task({ id: 'd1', intent: 'detail', input: { id: 'phoenix' } })

  it('applies when the taught output carries the entity id', () => {
    const gate = entityIdApplicable(lookup, [{ title: 'phoenix', url: '/packages/phoenix' }])
    expect(gate.applicable).toBe(true)
  })

  /**
   * The v1 defect, in the two shapes that produced it. dev.to's plan takes a
   * title and an author; lemmy's `url` is the outbound link a post points at
   * rather than the post. Both answers were right and the rule called them
   * wrong, because it never asked whether it could see an id here.
   */
  it.each([
    ['nothing extracted could carry one', [{ title: 'Jev vs Claude: Who Wins?', author: 'Ben Greenberg' }]],
    ['the url points somewhere else', [{ title: 'Why Personal Websites Are Coming Back', url: 'https://deadparrotbbs.com/x/' }]],
  ])('does not apply when %s', (_why, taughtItems) => {
    const numeric = task({ id: 'd2', intent: 'detail', input: { id: '51987178' } })
    const gate = entityIdApplicable(numeric, taughtItems)
    expect(gate.applicable).toBe(false)
    expect(gate.reason).toMatch(/not observable in the taught output/)
  })

  it.each([
    ['the task is a search', task({ id: 's1' }), [{ title: 'x' }]],
    ['the task names no id', task({ id: 'd3', intent: 'detail', input: {} }), [{ title: 'x' }]],
    ['the taught observation is missing', lookup, null],
  ])('does not apply when %s', (_why, given, items) => {
    expect(entityIdApplicable(given, items).applicable).toBe(false)
  })
})

describe('the deterministic task oracle', () => {
  const lookup = task({ id: 'd1', intent: 'detail', input: { id: 'phoenix' } })
  const gate = entityIdApplicable(lookup, [{ title: 'phoenix', url: '/packages/phoenix' }])

  it('settles an unseen lookup by whether the answer carries the id asked for', () => {
    expect(judgeByTask(lookup, [{ title: 'phoenix', url: '/packages/phoenix' }], 'unseen', gate).judgement).toBe('correct')
    expect(judgeByTask(lookup, [{ title: 'ecto', url: '/packages/ecto' }], 'unseen', gate).judgement).toBe('wrong')
  })

  // Judging the input the gate was calibrated on would be the oracle agreeing
  // with itself.
  it('will not judge the input it was calibrated on', () => {
    const verdict = judgeByTask(lookup, [{ title: 'phoenix', url: '/packages/phoenix' }], 'taught', gate)
    expect(verdict.judgement).toBe('indeterminate')
    expect(verdict.oracle.reason).toBe('calibration input')
  })

  it('withholds a verdict entirely where the gate is shut', () => {
    const shut = entityIdApplicable(lookup, [{ title: 'something else' }])
    const verdict = judgeByTask(lookup, [{ title: 'anything' }], 'unseen', shut)
    expect(verdict.judgement).toBe('indeterminate')
    expect(verdict.judgement).not.toBe('wrong')
  })

  it('settles a query declared to match nothing, whatever the id gate says', () => {
    const none = task({ id: 'e1', expectEmpty: true })
    const shut = entityIdApplicable(none, null)
    expect(judgeByTask(none, [], 'unseen', shut).judgement).toBe('correct')
    expect(judgeByTask(none, [{ title: 'something', url: '/x' }], 'unseen', shut).judgement).toBe('wrong')
  })

  it('leaves an ordinary search to another tier', () => {
    const shut = entityIdApplicable(task({ id: 's1' }), [{ title: 'plug' }])
    expect(judgeByTask(task({ id: 's1' }), [{ title: 'plug', url: '/x' }], 'unseen', shut).judgement).toBe('indeterminate')
  })
})

describe('the detail consistency check', () => {
  /**
   * One-sided by design. It can say a row describes something other than what
   * it links to; it cannot say the row is the right answer, because a row moved
   * wholesale to the wrong entity agrees with its own link perfectly.
   */
  it('reports a row that shares no word with the page it links to', async () => {
    const fx = await startFixture('detail', (req, res) => {
      sendHtml(res, `<html><body><h1>Completely different subject</h1><p>${'filler '.repeat(120)}</p></body></html>`)
    })
    try {
      const probe = await detailMismatch([{ title: 'Phoenix framework', url: '/packages/phoenix' }], new PolitenessLayer({ minIntervalMs: 0 }), fx.url)
      expect(probe.wrong).toBe(true)
      expect(probe.reason).toMatch(/shares no word/)
    } finally { await fx.close() }
  })

  it('reports nothing when the row does appear there, and claims no correctness', async () => {
    const fx = await startFixture('detail', (req, res) => {
      sendHtml(res, `<html><body><h1>Phoenix framework</h1><p>${'filler '.repeat(120)}</p></body></html>`)
    })
    try {
      const probe = await detailMismatch([{ title: 'Phoenix framework', url: '/packages/phoenix' }], new PolitenessLayer({ minIntervalMs: 0 }), fx.url)
      expect(probe.wrong).toBe(false)
    } finally { await fx.close() }
  })

  // A rendered-by-script page has no text to disagree with, and must not be
  // read as a row pointing somewhere else.
  it('stays silent on a page that rendered nothing', async () => {
    const fx = await startFixture('detail', (req, res) => { sendHtml(res, '<html><body><div id="root"></div></body></html>') })
    try {
      expect((await detailMismatch([{ title: 'Phoenix framework', url: '/x' }], new PolitenessLayer({ minIntervalMs: 0 }), fx.url)).wrong).toBe(false)
    } finally { await fx.close() }
  })
})
