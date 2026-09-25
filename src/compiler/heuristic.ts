import { scoreRequests, type ScoredRequest } from '../analyzer/score.js'
import { computeFingerprint } from '../recipes/fingerprint.js'
import { jsonSignature } from '../executor/extract.js'
import { resolvePath } from '../recipes/paths.js'
import { RecipeSchema, type Recipe } from '../recipes/schema.js'
import { extractJsonItems } from '../executor/extract.js'
import type { Item } from '../types.js'
import { verifyAgainstBrowser, browserItemsOf } from './verify.js'
import { reconcileField } from './derive.js'
import type { BrowserPlan } from '../executor/strategies/browser.js'
import type { Trace } from '../recorder/types.js'
import { readBody } from '../recorder/body.js'
import { equivalenceRefusal, isRefused, type Compiler, type CompileResult, type Refused } from './types.js'

/** Values worth substituting; anything shorter matches by coincidence. */
const MIN_INPUT_LENGTH = 2

/** No response got far enough to fail for a reason of its own. */
export const NO_CANDIDATE = "no candidate response carries the browser's items"

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const TITLE_KEYS = ['title', 'name', 'headline', 'label']
const ID_KEYS = ['id', 'slug', 'key', 'uuid']
const URL_KEYS = ['url', 'href', 'link', 'permalink']

function isObjectArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))
  )
}

/** The longest array of objects at depth 1 or 2 is the result set. */
export function findItemsPath(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null

  let bestPath: string | null = null
  let bestLength = 0

  const consider = (path: string, value: unknown): void => {
    if (!isObjectArray(value)) return
    if (bestPath === null || value.length > bestLength) {
      bestPath = path
      bestLength = value.length
    }
  }

  for (const [key, value] of Object.entries(payload)) {
    consider(`$.${key}`, value)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k2, v2] of Object.entries(value)) consider(`$.${key}.${k2}`, v2)
    }
  }
  return bestPath
}

const RECORD_KEYS = ['result', 'item', 'record', 'data', 'crate', 'entry']
const MIN_RECORD_FIELDS = 2

function scalarFieldCount(value: unknown): number {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 0
  return Object.values(value).filter(
    (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  ).length
}

/**
 * A detail response carries one record, not a list, so there is no array for
 * findItemsPath to latch onto. Picks the wrapped object that looks most like a
 * record, falling back to the payload root when nothing wraps it.
 */
export function findRecordPath(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null

  const entries = Object.entries(payload)

  for (const key of RECORD_KEYS) {
    const value = (payload as Record<string, unknown>)[key]
    if (scalarFieldCount(value) >= MIN_RECORD_FIELDS) return `$.${key}`
  }

  let bestKey: string | null = null
  let bestCount = 0
  for (const [key, value] of entries) {
    const count = scalarFieldCount(value)
    if (count >= MIN_RECORD_FIELDS && count > bestCount) {
      bestKey = key
      bestCount = count
    }
  }
  if (bestKey !== null) return `$.${bestKey}`

  return scalarFieldCount(payload) >= MIN_RECORD_FIELDS ? '$' : null
}

function pick(sample: Record<string, unknown>, candidates: string[]): string | null {
  return candidates.find((k) => k in sample && sample[k] !== null) ?? null
}

const SYNONYMS: Record<string, string[]> = {
  id: ID_KEYS,
  title: TITLE_KEYS,
  url: URL_KEYS,
  author: ['author', 'by', 'owner', 'user', 'creator'],
}

/**
 * When `expected` is given the recipe must be a drop-in replacement for the
 * browser plan, so it maps those exact output names onto whatever the payload
 * calls them. Without it, falls back to the conventional id/title/url guess.
 */
export function inferFields(
  sample: Record<string, unknown>,
  expected?: string[],
): Record<string, string> {
  const fields: Record<string, string> = {}

  if (expected && expected.length > 0) {
    for (const name of expected) {
      const key = pick(sample, SYNONYMS[name] ?? [name])
      if (key) fields[name] = `$.${key}`
    }
    return fields
  }

  const id = pick(sample, ID_KEYS) ?? Object.entries(sample).find(([, v]) => typeof v === 'string')?.[0]
  if (id) fields.id = `$.${id}`

  const title = pick(sample, TITLE_KEYS)
  if (title) fields.title = `$.${title}`

  const url = pick(sample, URL_KEYS)
  if (url) fields.url = `$.${url}`

  return fields
}

/**
 * Substitutes input values anywhere in a path, not only as whole segments.
 *
 * A filter is routinely welded into a segment rather than given a query
 * parameter — `/games/genre-puzzle`, `/remote-python-jobs`. Matching whole
 * segments only left those literal, and a recipe carrying no placeholder for
 * its input is refused as a snapshot, so two working sites compiled to nothing.
 *
 * A match must be bounded by a non-word character on both sides, so a value is
 * recognised inside a segment but not inside a longer number or word. Longest
 * value first, so one value is not broken up by a shorter one sitting inside
 * it. Anything that still slips through is caught downstream: a path templated
 * too eagerly returns the wrong thing for a different input and fails the
 * equivalence check.
 */
export function templatePath(pathname: string, input: Record<string, string | number>): string {
  const values = Object.entries(input)
    .map(([name, v]) => [name, String(v)] as const)
    .filter(([, v]) => v.length >= MIN_INPUT_LENGTH)
    .sort((a, b) => b[1].length - a[1].length)

  let out = pathname
  for (const [name, value] of values) {
    for (const candidate of [value, encodeURIComponent(value)]) {
      // Bounded by something that is not a word character, so `100` is found in
      // `/item/100` and in `/genre-100` but not inside `/1000`, where
      // substituting it would render `/2000` for an id of 200.
      const bounded = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(candidate)}(?![A-Za-z0-9])`, 'g')
      out = out.replace(bounded, `{{${name}}}`)
    }
  }

  // A value below the floor would match by coincidence almost anywhere, so it
  // is templated only where it fills an entire path segment: `2` is the page in
  // `/page/2`, but not the tail of `/1000`, the version in `/v2` or part of
  // `/item-2`.
  const short = Object.entries(input)
    .map(([name, v]) => [name, String(v)] as const)
    .filter(([, v]) => v.length > 0 && v.length < MIN_INPUT_LENGTH)

  for (const [name, value] of short) {
    const candidates = new Set([value, encodeURIComponent(value)])
    out = out
      .split('/')
      .map((segment) => (candidates.has(segment) ? `{{${name}}}` : segment))
      .join('/')
  }
  return out
}

/**
 * Finds which query parameter carried an input value and replaces it with a
 * placeholder. A parameter is only templated on an exact value match, so a
 * coincidental substring cannot turn a constant into a variable.
 */
function templateQuery(url: URL, input: Record<string, string | number>): Record<string, string> {
  const query: Record<string, string> = {}

  for (const [key, value] of url.searchParams.entries()) {
    const match = Object.entries(input).find(([, v]) => String(v) === value)
    query[key] = match ? `{{${match[0]}}}` : value
  }
  return query
}

/**
 * Templates input values inside a POST body. Algolia and friends put the search
 * term in the body rather than the URL, so a recipe that does not template it
 * returns the results it was recorded with for every query it is ever asked.
 *
 * Only exact whole-value matches are replaced, so prose that merely mentions
 * the query is left alone. Returns null when the body carries no input value.
 */
export function templateBody(
  postData: string,
  input: Record<string, string | number>,
): string | null {
  const wanted = Object.entries(input).filter(([, v]) => String(v) !== '')
  if (wanted.length === 0) return null

  const placeholderFor = (value: string): string | null => {
    const match = wanted.find(([, v]) => String(v) === value)
    return match ? `{{${match[0]}}}` : null
  }

  try {
    const parsed: unknown = JSON.parse(postData)
    let replaced = false

    const walk = (node: unknown): unknown => {
      if (typeof node === 'string') {
        const placeholder = placeholderFor(node)
        if (placeholder === null) return node
        replaced = true
        return placeholder
      }
      if (Array.isArray(node)) return node.map(walk)
      if (node !== null && typeof node === 'object') {
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]))
      }
      return node
    }

    const out = walk(parsed)
    return replaced ? JSON.stringify(out) : null
  } catch {
    // Not JSON — try form encoding.
  }

  const params = new URLSearchParams(postData)
  let replaced = false
  for (const [key, value] of [...params.entries()]) {
    const placeholder = placeholderFor(value)
    if (placeholder === null) continue
    params.set(key, placeholder)
    replaced = true
  }
  return replaced ? params.toString() : null
}

/** Input names that must appear as a placeholder for the recipe to be parameterised. */
export function templatedInputs(parts: string[]): Set<string> {
  const found = new Set<string>()
  for (const part of parts) {
    for (const match of part.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) found.add(match[1]!)
  }
  return found
}

export class HeuristicCompiler implements Compiler {
  private readonly expectedFields?: string[]

  /**
   * `plan` is the browser behaviour the recipe must reproduce. Given one, every
   * candidate is checked against what the browser actually extracted before it
   * is accepted.
   */
  constructor(expected?: string[] | BrowserPlan) {
    if (Array.isArray(expected)) this.expectedFields = expected
    else if (expected) {
      this.plan = expected
      this.expectedFields = Object.keys(expected.fields)
    }
  }

  private readonly plan?: BrowserPlan

  /**
   * Walks candidates in score order and returns the first that yields a usable
   * recipe. Taking only the top scorer makes the compiler give up whenever the
   * highest-ranked request happens not to be parseable — an autocomplete
   * endpoint returning an array of bare strings, say — even though the real
   * result set sits one place below it.
   */
  async compile(trace: Trace): Promise<CompileResult> {
    // The first substantive refusal, not the last: candidates are walked in
    // score order, so the highest-ranked response that got far enough to fail
    // for a nameable reason is the one worth reporting.
    let refused: string | null = null

    for (const candidate of scoreRequests(trace)) {
      const outcome = this.compileCandidate(trace, candidate)
      if (outcome === null) continue
      if (isRefused(outcome)) {
        refused ??= outcome.refused
        continue
      }
      if (!this.plan) return outcome

      const payload = JSON.parse(readBody(candidate.request)!) as unknown
      const browserItems = browserItemsOf(trace, this.plan)
      const { recipe: complete, unreconciled } = this.reconcileFields(outcome, payload, browserItems)
      const items = extractJsonItems(complete, payload)
      if (verifyAgainstBrowser(trace, this.plan, items).equivalent) return complete

      refused ??= unreconciled ?? equivalenceRefusal(items.length, browserItems.length)
    }
    return { refused: refused ?? NO_CANDIDATE }
  }

  /**
   * Settles every expected field against the values the browser produced.
   *
   * Inferring a field by name is a guess, and it can be absent or simply wrong:
   * hn.algolia's payload carries a `url`, so `url` maps onto it, but the page
   * links to the discussion while the payload holds the article. The browser's
   * own values are the evidence, so each field keeps its inferred spec only if
   * that spec reproduces them, and is otherwise re-derived.
   *
   * Verification still has the last word over the result.
   */
  private reconcileFields(
    recipe: Recipe,
    payload: unknown,
    browserItems: Item[],
  ): { recipe: Recipe; unreconciled: string | null } {
    if (!this.expectedFields || recipe.output.type !== 'json') return { recipe, unreconciled: null }
    if (browserItems.length === 0) return { recipe, unreconciled: null }

    const located = resolvePath(payload, recipe.output.items.path)
    const rows = (Array.isArray(located) ? located : [located]) as Array<Record<string, unknown>>
    if (rows.length !== browserItems.length) return { recipe, unreconciled: null }

    const fields: Record<string, string> = {}
    let unreconciled: string | null = null
    for (const name of this.expectedFields) {
      const settled = reconcileField(
        recipe.output.items.fields[name],
        browserItems.map((item) => item[name] ?? null),
        rows,
      )
      if (settled !== null) fields[name] = settled
      // Verification still has the last word, but when it goes on to reject the
      // recipe this names the field that could not be made to agree.
      else unreconciled ??= `field "${name}" could not be reconciled across ${rows.length} rows`
    }

    return {
      recipe: { ...recipe, output: { ...recipe.output, items: { ...recipe.output.items, fields } } },
      unreconciled,
    }
  }

  /** null means this response is not a json candidate, which diagnoses nothing. */
  private compileCandidate(trace: Trace, picked: ScoredRequest): Recipe | Refused | null {
    const raw = readBody(picked.request)
    if (raw === null) return null

    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      return null
    }

    // A detail response describes one thing; an array in it is a sidecar
    // (a crate's versions, a package's imports) rather than the answer.
    const itemsPath = trace.intent === 'detail'
      ? findRecordPath(payload) ?? findItemsPath(payload)
      : findItemsPath(payload) ?? findRecordPath(payload)
    if (itemsPath === null) return { refused: 'items path not found' }

    const located = resolvePath(payload, itemsPath)
    const rows = (Array.isArray(located) ? located : [located]) as Record<string, unknown>[]
    const sample = rows[0]
    if (!sample || typeof sample !== 'object') return { refused: 'no object row at the items path' }

    const fields = inferFields(sample, this.expectedFields)
    if (Object.keys(fields).length === 0) return { refused: 'no fields could be inferred from the payload' }

    // With a plan, a gap here is not yet fatal: compile() tries to derive the
    // missing field and verification judges the result. Without one there is no
    // safety net, so the field count is all the contract we can enforce.
    if (!this.plan && this.expectedFields && Object.keys(fields).length < this.expectedFields.length) {
      return { refused: `inferred ${Object.keys(fields).length} of ${this.expectedFields.length} expected fields` }
    }

    const url = new URL(picked.request.url)
    const path = templatePath(url.pathname, trace.input)
    const query = templateQuery(url, trace.input)
    const body = picked.request.postData
      ? templateBody(picked.request.postData, trace.input) ?? undefined
      : undefined

    // A recipe that does not carry every input as a placeholder is a snapshot,
    // not a recipe: it returns what it was recorded with whatever it is asked.
    const templated = templatedInputs([path, ...Object.values(query), body ?? ''])
    const required = Object.entries(trace.input).filter(([, v]) => String(v) !== '').map(([k]) => k)
    const untemplated = required.find((name) => !templated.has(name))
    if (untemplated !== undefined) return { refused: `required input "${untemplated}" not templated` }

    const contentType = picked.request.requestHeaders['content-type']
    const outputSpec = { type: 'json' as const, items: { path: itemsPath, fields } }
    const signature = jsonSignature({ output: outputSpec }, payload)

    return RecipeSchema.parse({
      site: trace.site,
      intent: trace.intent,
      inputs: Object.fromEntries(
        Object.entries(trace.input).map(([k, v]) => [k, { type: typeof v === 'number' ? 'number' : 'string' }]),
      ),
      strategy: { type: 'http-json' },
      request: {
        method: picked.request.method === 'POST' ? 'POST' : 'GET',
        // A search vendor's API is a different host than the site itself.
        ...(url.origin === trace.origin ? {} : { origin: url.origin }),
        path,
        query,
        ...(body === undefined ? {} : { body }),
        ...(contentType === undefined ? {} : { headers: { 'content-type': contentType } }),
      },
      output: outputSpec,
      validation: {
        status: 200,
        required: Object.keys(fields).filter((f) => f === 'id' || f === 'title'),
        minItems: 1,
      },
      fingerprint: {
        endpoint: path,
        hash: computeFingerprint(path, signature),
        responseFields: signature.fields,
      },
      fallback: { type: 'browser' },
    } satisfies Recipe)
  }
}
