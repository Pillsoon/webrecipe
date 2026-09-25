import type { Item } from '../types.js'

export interface Golden {
  taskId: string
  capturedAt: string
  items: Item[]
}

export interface DiffResult {
  match: boolean
  reasons: string[]
}

export function diffGolden(golden: Golden, actual: Item[], volatile: string[] = []): DiffResult {
  const reasons: string[] = []

  if (actual.length !== golden.items.length) {
    reasons.push(`item count ${actual.length} !== golden ${golden.items.length}`)
    return { match: false, reasons }
  }

  const volatileSet = new Set(volatile)

  golden.items.forEach((expected, index) => {
    const got = actual[index]
    if (!got) { reasons.push(`item ${index} missing`); return }

    for (const [field, expectedValue] of Object.entries(expected)) {
      const gotValue = got[field]

      if (volatileSet.has(field)) {
        if (!(field in got) || gotValue === null || gotValue === undefined) {
          reasons.push(`item ${index}: volatile field "${field}" absent`)
        } else if (typeof gotValue !== typeof expectedValue) {
          reasons.push(`item ${index}: volatile field "${field}" changed type`)
        }
        continue
      }

      if (gotValue !== expectedValue) {
        reasons.push(`item ${index}: "${field}" ${JSON.stringify(gotValue)} !== ${JSON.stringify(expectedValue)}`)
      }
    }
  })

  return { match: reasons.length === 0, reasons }
}

export interface Grade {
  /** Every field the golden declares is present and correctly typed. */
  schema: boolean
  /** The same items are there, compared as a set, with the same field values. */
  semantic: boolean
  /** They are in the same order. Null when the sets differ, so it cannot be judged. */
  ordering: boolean | null
  reasons: string[]
}

const key = (item: Item, volatile: Set<string>, fields?: string[]): string =>
  JSON.stringify((fields ?? Object.keys(item)).filter((k) => !volatile.has(k)).sort().map((k) => [k, item[k]]))

/**
 * Three separate questions, because collapsing them mixes engine failure with
 * website nondeterminism. flathub and pkg.go.dev reorder equally-ranked results
 * between one request and the next, which failed even the browser baseline
 * against its own golden — that is the site being unstable, not the recipe
 * being wrong, and it should not be reported as the same thing.
 *
 * `fields`, when given, restricts both schema and semantic comparison to that
 * set — the same restriction `oracle.compare.fields` applies under
 * `paired-live`, so a column the oracle does not score cannot fail a golden
 * task either.
 */
export function gradeGolden(golden: Golden, actual: Item[], volatile: string[] = [], fields?: string[]): Grade {
  const volatileSet = new Set(volatile)
  const reasons: string[] = []

  // Schema: does every declared field still exist, with the right type?
  let schema = true
  const declared = new Set(fields ?? golden.items.flatMap((i) => Object.keys(i)))
  for (const field of declared) {
    const expected = golden.items.find((i) => i[field] !== null && i[field] !== undefined)?.[field]
    const missing = actual.filter((i) => !(field in i) || i[field] === null || i[field] === undefined)
    if (actual.length > 0 && missing.length === actual.length) {
      schema = false
      reasons.push(`field "${field}" absent from every item`)
      continue
    }
    const mistyped = actual.filter((i) => i[field] != null && expected != null && typeof i[field] !== typeof expected)
    if (mistyped.length > 0) {
      schema = false
      reasons.push(`field "${field}" changed type in ${mistyped.length} items`)
    }
  }

  // Semantic: the same items, as a set.
  const wanted = golden.items.map((i) => key(i, volatileSet, fields))
  const got = actual.map((i) => key(i, volatileSet, fields))
  const pool = [...got]
  const absent: string[] = []
  for (const k of wanted) {
    const at = pool.indexOf(k)
    if (at === -1) absent.push(k)
    else pool.splice(at, 1)
  }
  const semantic = absent.length === 0 && pool.length === 0
  if (absent.length > 0) reasons.push(`${absent.length} golden item(s) missing from the result`)
  if (pool.length > 0) reasons.push(`${pool.length} unexpected item(s) in the result`)

  // Volatile fields must still be present and of the right type.
  for (const field of volatileSet) {
    const bad = actual.filter((i) => !(field in i) || i[field] === null || i[field] === undefined)
    if (bad.length > 0) {
      schema = false
      reasons.push(`volatile field "${field}" absent in ${bad.length} items`)
    }
  }

  // Ordering: only answerable when the sets agree.
  const ordering = semantic ? wanted.every((k, i) => got[i] === k) : null
  if (ordering === false) reasons.push('same items, different order')

  return { schema, semantic, ordering, reasons }
}
