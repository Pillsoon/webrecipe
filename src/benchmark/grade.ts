import type { OracleSpec } from './oracle.js'
import type { Item } from '../types.js'

export interface Validity {
  usable: boolean
  reason: string | null
}

/** The fields the oracle compares; all of them when it names none. */
function comparedFields(items: Item[], oracle: OracleSpec): string[] {
  return oracle.compare.fields ?? [...new Set(items.flatMap((i) => Object.keys(i)))]
}

const present = (value: unknown): boolean =>
  value !== null && value !== undefined && value !== ''

/**
 * Layer 1. Decides whether the adjacent browser run is usable at all, before
 * the engine is judged against it. Checks exactly the fields Layer 2 compares:
 * disqualifying a baseline over a column nobody scores would throw away a
 * usable measurement.
 */
export function baselineValidity(
  items: Item[],
  oracle: OracleSpec,
  opts: { threw: boolean; expectEmpty: boolean },
): Validity {
  if (opts.threw) return { usable: false, reason: 'baseline threw' }

  if (items.length === 0) {
    return opts.expectEmpty
      ? { usable: true, reason: null }
      : { usable: false, reason: 'baseline returned no items' }
  }

  for (const field of comparedFields(items, oracle)) {
    const missing = items.filter((i) => !present(i[field])).length
    if (missing > items.length / 2) {
      return { usable: false, reason: `baseline field "${field}" missing in ${missing}/${items.length} items` }
    }
  }
  return { usable: true, reason: null }
}

function keyOf(item: Item, fields: string[]): string {
  return JSON.stringify(fields.map((f) => [f, item[f] ?? null]))
}

/** Layer 2a. The same items, as a set, on the fields the oracle compares. */
export function entityEquivalence(
  reference: Item[],
  actual: Item[],
  oracle: OracleSpec,
): { match: boolean; reasons: string[] } {
  const fields = comparedFields([...reference, ...actual], oracle)
  const pool = actual.map((i) => keyOf(i, fields))
  const reasons: string[] = []

  let missing = 0
  for (const key of reference.map((i) => keyOf(i, fields))) {
    const at = pool.indexOf(key)
    if (at === -1) missing += 1
    else pool.splice(at, 1)
  }

  if (missing > 0) reasons.push(`${missing} baseline item(s) missing from the result`)
  if (pool.length > 0) reasons.push(`${pool.length} unexpected item(s) in the result`)
  return { match: reasons.length === 0, reasons }
}

/**
 * Layer 2b. The result answers the question that was asked.
 *
 * arbeitnow.com discards its search parameter on redirect and serves the same
 * unfiltered front page for every query — a result that is internally
 * consistent, matches its own baseline, and answers nothing. Entity equivalence
 * alone cannot see that.
 *
 * Judged only where an oracle declares a rule, and returns null otherwise.
 * Applying a generic "the query must appear in the results" heuristic
 * everywhere would fail honest engines: a search for `senior rust engineer` may
 * legitimately return `Systems Engineer`, a search for `cars` may return
 * `automobile`, and a match may live in a description the oracle does not
 * compare. A rule that fires on sites it was never designed for is an oracle
 * bug wearing a correctness check's clothes.
 */
export function querySemantics(
  actual: Item[],
  input: Record<string, string | number>,
  oracle: OracleSpec,
): { match: boolean | null; reasons: string[] } {
  const rule = oracle.semantics
  if (!rule) return { match: null, reasons: [] }
  if (actual.length === 0) return { match: null, reasons: [] }

  const raw = input[rule.input]
  if (raw === undefined || String(raw).trim() === '') return { match: null, reasons: [] }

  // Token-wise, so a multi-word query is not required to appear verbatim.
  const tokens = String(raw).toLowerCase().split(/\s+/).filter((t) => t.length >= 2)
  if (tokens.length === 0) return { match: null, reasons: [] }

  const hits = actual.filter((item) =>
    rule.fields.some((f) => {
      const value = String(item[f] ?? '').toLowerCase()
      return tokens.some((t) => value.includes(t))
    }),
  ).length

  return hits >= actual.length * rule.minShare
    ? { match: true, reasons: [] }
    : { match: false, reasons: [`no token of "${String(raw)}" in ${actual.length - hits}/${actual.length} items`] }
}

/** Layer 2c. Null when the oracle ignores order, or when the sets differ. */
export function orderingAgreement(
  reference: Item[],
  actual: Item[],
  oracle: OracleSpec,
): boolean | null {
  if (oracle.compare.ordering === 'ignore') return null
  if (!entityEquivalence(reference, actual, oracle).match) return null

  const fields = comparedFields([...reference, ...actual], oracle)
  return reference.every((item, i) => actual[i] !== undefined && keyOf(actual[i]!, fields) === keyOf(item, fields))
}

/** A result this much smaller than its golden suggests the plan, not the site. */
const COLLAPSE_RATIO = 0.5

/**
 * Compares a fresh browser result against its stored golden structurally rather
 * than by content.
 *
 * Under `paired-live` the golden no longer scores correctness, but it still
 * answers one question nothing else does: does the browser plan still see the
 * page the way it used to? Items may legitimately all differ; the shape should
 * not. Returns a description of the decay, or null.
 */
export function planAging(
  golden: Item[] | undefined,
  baseline: Item[],
  oracle: OracleSpec,
): string | null {
  if (golden === undefined || golden.length === 0) return null

  // A count change is a hint, not a verdict: a search that legitimately returns
  // forty results today where it returned a hundred last week has not aged its
  // plan. Field disappearance below is the far stronger signal.
  if (baseline.length <= golden.length * COLLAPSE_RATIO) {
    return `possible plan aging: item count changed ${golden.length} -> ${baseline.length}`
  }

  for (const field of comparedFields(golden, oracle)) {
    const hadIt = golden.filter((i) => present(i[field])).length > golden.length / 2
    const hasIt = baseline.filter((i) => present(i[field])).length > baseline.length / 2
    if (hadIt && !hasIt) return `plan aging: field "${field}" no longer resolves`
  }
  return null
}

export interface PairGrade {
  usable: boolean
  validityReason: string | null
  /**
   * Why a task left the denominator, when it did. Two causes look identical as
   * "usable: false" but mean different things to a reader: `baseline` means the
   * browser run itself was unhealthy; `no-golden` means it was fine but there
   * was nothing stored to grade the engine against. Null when the task was
   * graded.
   */
  excludeReason: 'baseline' | 'no-golden' | null
  entities: boolean | null
  query: boolean | null
  ordering: boolean | null
  reasons: string[]
}

/** Engine equivalence, defined once so a report and a printed line cannot diverge. */
export const isEquivalent = (grade: PairGrade): boolean => grade.entities === true && grade.query !== false

/** An unusable baseline leaves layer two unjudged rather than failed. */
export function gradePair(
  reference: Item[],
  actual: Item[],
  oracle: OracleSpec,
  opts: { threw: boolean; expectEmpty: boolean; input: Record<string, string | number> },
): PairGrade {
  const validity = baselineValidity(reference, oracle, opts)
  if (!validity.usable) {
    return {
      usable: false, validityReason: validity.reason, excludeReason: 'baseline',
      entities: null, query: null, ordering: null, reasons: [validity.reason ?? 'baseline unusable'],
    }
  }

  const entities = entityEquivalence(reference, actual, oracle)
  const query = querySemantics(actual, opts.input, oracle)

  return {
    usable: true,
    validityReason: null,
    excludeReason: null,
    entities: entities.match,
    query: query.match,
    ordering: orderingAgreement(reference, actual, oracle),
    reasons: [...entities.reasons, ...query.reasons],
  }
}
