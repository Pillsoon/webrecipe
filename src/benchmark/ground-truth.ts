import { DATASET, PAGE_SIZE, search } from '../../fixtures/data.js'
import type { Item } from '../types.js'

/**
 * What the fixtures were built to return, stated from their own dataset.
 *
 * This replaces judging the answer by whether the query's token appears in it.
 * That rule is close enough to the one a production verifier would use that the
 * two would start agreeing by construction, and a benchmark that shares its
 * reasoning with the thing it grades cannot report a false success — the wrong
 * answer and the grade agreeing is what a false success is.
 *
 * Identity is the item's url path, which every fixture derives from the record
 * id; the origin is left out because a fixture's port changes on every run.
 */

export interface GroundTruth {
  /** Every record this input should be able to return. */
  expected: (input: Record<string, string | number>) => Set<string>
  /**
   * Rows the fixture is declared to invent, such as a freshly posted listing.
   * Narrow on purpose: without it a rule like "ignore anything unrecognised"
   * would let a fixture return arbitrary rubbish and still be graded correct.
   */
  ephemeral?: RegExp
}

const identity = (item: Item): string => {
  const url = String(item.url ?? '')
  try { return new URL(url).pathname } catch { return url }
}

const KNOWN: ReadonlySet<string> = new Set(DATASET.map((r) => `/item/${r.id}`))

const PAGES = Math.ceil(DATASET.length / PAGE_SIZE)

/** Every match, not just page one: a different ranking is not a wrong answer. */
export const datasetMatches = (query: string): Set<string> =>
  new Set(Array.from({ length: PAGES }, (_, i) => search(query, i + 1))
    .flat()
    .map((r) => `/item/${r.id}`))

/** Any page's worth of matches: a different ranking is not a wrong answer. */
export const DATASET_TRUTH: GroundTruth = { expected: (input) => datasetMatches(String(input.query ?? '')) }

/** The one window this page should hold, which is what a page asks about. */
export const pageWindow = (input: Record<string, string | number>): Set<string> =>
  new Set(search(String(input.query ?? ''), Number(input.page ?? 1)).map((r) => `/item/${r.id}`))

export const PAGE_TRUTH: GroundTruth = { expected: pageWindow }

export interface OracleVerdict {
  /** Null when there is nothing to judge. */
  match: boolean | null
  reason: string
}

/**
 * Judges precision, not recall: every row returned must be one this query
 * should have returned. Whether it returned all of them is a question about
 * ranking and paging, which this benchmark does not ask and which a listing
 * that inserts a fresh row would fail for no good reason.
 */
export function judgeByGroundTruth(items: Item[], input: Record<string, string | number>, truth: GroundTruth): OracleVerdict {
  if (items.length === 0) return { match: null, reason: 'no items to judge' }
  const expected = truth.expected(input)

  for (const item of items) {
    const id = identity(item)
    if (expected.has(id)) continue
    if (truth.ephemeral?.test(id) === true) continue
    return KNOWN.has(id)
      ? { match: false, reason: `returned ${id}, a record this query does not match` }
      : { match: false, reason: `returned ${id}, which is neither a known record nor a declared ephemeral row` }
  }
  return { match: true, reason: '' }
}
