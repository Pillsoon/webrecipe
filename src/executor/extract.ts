import * as cheerio from 'cheerio'
import { resolvePath } from '../recipes/paths.js'
import { renderRowTemplate } from '../compiler/derive.js'
import type { Recipe } from '../recipes/schema.js'
import type { Item } from '../types.js'

/** Strings are trimmed: browser extraction trims, and the two must agree. */
function coerce(value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return value
  return String(value).trim()
}

/** A path that resolves to one object yields a single item; an array yields many. */
export function extractJsonItems(recipe: Recipe, payload: unknown): Item[] {
  if (recipe.output.type !== 'json') throw new Error('extractJsonItems requires a json recipe')

  const located = resolvePath(payload, recipe.output.items.path)
  if (located === undefined || located === null) return []

  const rows = Array.isArray(located) ? located : [located]
  const fields = Object.entries(recipe.output.items.fields)

  // A spec starting with `$` reads a value; anything else composes one from the
  // row, reproducing a derivation the page performs on top of its API.
  return rows.map((row) =>
    Object.fromEntries(fields.map(([name, spec]) => [
      name,
      spec.startsWith('$')
        ? coerce(resolvePath(row, spec))
        : renderRowTemplate(spec, row as Record<string, unknown>).trim(),
    ])),
  )
}

export function extractHtmlItems(recipe: Recipe, html: string): Item[] {
  if (recipe.output.type !== 'html') throw new Error('extractHtmlItems requires an html recipe')
  return extractBySelector(html, recipe.output.items.selector, recipe.output.items.fields)
}

/**
 * The structural signature of an HTML response: which of the recipe's declared
 * fields actually resolved. Fingerprinting the raw HTML would change on every
 * content edit; fingerprinting the recipe's own selectors would never change at
 * all. What matters is whether the selectors still find anything.
 */
export function htmlSignature(recipe: Recipe, items: Item[]): { selector: string; fields: string[] } {
  if (recipe.output.type !== 'html') throw new Error('htmlSignature requires an html recipe')

  const first = items[0]
  const fields = first === undefined
    ? []
    : Object.keys(first).filter((name) => first[name] !== null && first[name] !== '').sort()

  return { selector: recipe.output.items.selector, fields }
}

/**
 * The structural signature of a JSON response, limited to what the recipe
 * actually reads. Hashing every path in the payload treats content-driven
 * variation as schema drift — Algolia's per-hit _highlightResult carries
 * different keys for different queries — so a recipe would be judged broken
 * every time the search term changed.
 */
export function jsonSignature(
  recipe: { output: { type: 'json'; items: { path: string; fields: Record<string, string> } } },
  payload: unknown,
): { itemsPath: string; fields: string[] } {
  const located = resolvePath(payload, recipe.output.items.path)
  const rows = Array.isArray(located) ? located : located === undefined || located === null ? [] : [located]
  const sample = rows[0]

  const fields = sample === undefined
    ? []
    : Object.entries(recipe.output.items.fields)
        .filter(([, spec]) => (spec.startsWith('$') ? resolvePath(sample, spec) !== undefined : true))
        .map(([name]) => name)
        .sort()

  return { itemsPath: located === undefined || located === null ? '(missing)' : recipe.output.items.path, fields }
}

/** Elements HTML parsing only accepts inside a particular parent. */
const FRAGMENT_WRAPPERS: Array<[RegExp, (html: string) => string]> = [
  [/^<tr[\s>]/i, (h) => `<table><tbody>${h}</tbody></table>`],
  [/^<(td|th)[\s>]/i, (h) => `<table><tbody><tr>${h}</tr></tbody></table>`],
  [/^<(li)[\s>]/i, (h) => `<ul>${h}</ul>`],
  [/^<(option)[\s>]/i, (h) => `<select>${h}</select>`],
  [/^<(dt|dd)[\s>]/i, (h) => `<dl>${h}</dl>`],
]

/**
 * Parses HTML that may be a fragment rather than a document.
 *
 * A response can be a bare run of `<tr>` elements, which an XHR splices into an
 * existing table — remoteok.com answers a search that way. Parsing that as a
 * document silently discards every row, because a table row outside a table is
 * invalid HTML, and the result is an empty extraction with no error to explain
 * it. Supplying the missing parent keeps the rows.
 */
export function parseHtmlFragment(html: string): cheerio.CheerioAPI {
  const head = html.replace(/^\s*(?:<!--[\s\S]*?-->\s*)*/, '')
  const wrapper = FRAGMENT_WRAPPERS.find(([pattern]) => pattern.test(head))
  return cheerio.load(wrapper ? wrapper[1](head) : html)
}

export type FieldPlan =
  | { name: string; mode: 'own-text' }
  | { name: string; mode: 'own-attr'; attribute: string }
  | { name: string; mode: 'find-attr'; selector: string; attribute: string }
  | { name: string; mode: 'find-text'; selector: string }

/** One interpretation of a field spec, shared by cheerio and the browser. */
export function planFields(fields: Record<string, string>): FieldPlan[] {
  return Object.entries(fields).map(([name, spec]) => {
    if (spec === '') return { name, mode: 'own-text' as const }
    if (spec.startsWith('@')) return { name, mode: 'own-attr' as const, attribute: spec.slice(1) }
    const suffix = attributeSuffix(spec)
    return suffix
      ? { name, mode: 'find-attr' as const, selector: suffix.selector, attribute: suffix.attribute }
      : { name, mode: 'find-text' as const, selector: spec }
  })
}

/**
 * Splits `selector@attr`, tolerating an `@` inside the selector itself — jsr.io
 * links start with `/@`, so `a[href^="/@"]@href` must split on the trailing
 * suffix and not on the first one it finds. The suffix only counts outside
 * brackets and quotes.
 */
function attributeSuffix(spec: string): { selector: string; attribute: string } | null {
  const match = /@([a-zA-Z][\w-]*)$/.exec(spec)
  if (!match) return null

  const selector = spec.slice(0, match.index)
  let depth = 0
  let quote: string | null = null
  for (const ch of selector) {
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '[') depth += 1
    else if (ch === ']') depth -= 1
  }
  // An unbalanced selector means the @ we matched belongs inside it.
  if (depth !== 0 || quote !== null || selector === '') return null
  return { selector, attribute: match[1]! }
}

/**
 * Extracts items from HTML with a bare selector and field map, independent of a
 * recipe. Used to reconstruct what the browser saw so a candidate recipe can be
 * checked against it.
 */
export function extractBySelector(
  html: string,
  selector: string,
  fields: Record<string, string>,
): Item[] {
  const $ = parseHtmlFragment(html)
  const plans = planFields(fields)

  return $(selector).toArray().map((element) => {
    const item = $(element)
    const row: Item = {}
    // Field candidates ask for `a`, `a@href` and `a@id` of the same item; one find serves all three.
    const found = new Map<string, ReturnType<typeof item.find>>()
    const find = (sel: string) => {
      let f = found.get(sel)
      if (f === undefined) { f = item.find(sel); found.set(sel, f) }
      return f
    }

    for (const f of plans) {
      switch (f.mode) {
        case 'own-text': row[f.name] = item.text().trim(); break
        case 'own-attr': row[f.name] = item.attr(f.attribute) ?? null; break
        case 'find-attr': row[f.name] = find(f.selector).attr(f.attribute) ?? null; break
        default: {
          const matches = find(f.selector)
          row[f.name] = matches.length === 0 ? null : matches.first().text().trim()
        }
      }
    }
    return row
  })
}
