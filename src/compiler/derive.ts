/**
 * Learns the derivation a page performs on top of its API.
 *
 * An API is not a machine-readable version of a page; it is the input the page
 * renders from. The page composes: crates.io builds `/crates/serde` from the
 * crate id, and `serde v1.0.229` from a name and a version. A recipe that can
 * only read fields verbatim cannot reproduce those, so it is refused as a
 * narrower replacement for the browser. Synthesising the template recovers them.
 */

/** Shorter values match by coincidence far more often than they mean anything. */
const MIN_VALUE_LENGTH = 2

function scalarEntries(row: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(row)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([k, v]) => [k, String(v)] as [string, string])
    .filter(([, v]) => v.length >= MIN_VALUE_LENGTH)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Rebuilds `target` from the row's own values, longest value first so that a
 * version like `1.0.229` is not broken up by the `1` sitting in another field.
 * Returns null when no value contributes.
 */
export function synthesizeTemplate(target: string, row: Record<string, unknown>): string | null {
  const candidates = scalarEntries(row).sort((a, b) => b[1].length - a[1].length)

  let template = target
  let used = false

  for (const [key, value] of candidates) {
    if (!template.includes(value)) continue
    template = template.replace(new RegExp(escapeRegExp(value), 'g'), `{{${key}}}`)
    used = true
  }

  return used ? template : null
}

/** Renders a synthesized template back against a row, for verification. */
export function renderRowTemplate(template: string, row: Record<string, unknown>): string {
  // `{{k1 ?? k2}}` renders the first key that has a value, so a page rule
  // conditional on a null field is expressible.
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+(?:\s*\?\?\s*[a-zA-Z0-9_]+)*)\s*\}\}/g, (_match, keys: string) => {
    for (const key of keys.split('??')) {
      const value = row[key.trim()]
      if (value !== null && value !== undefined && value !== '') return String(value)
    }
    return ''
  })
}

function placeholderCount(template: string): number {
  return [...template.matchAll(/\{\{/g)].length
}

/**
 * Accepts a template only if it reproduces the browser's value for **every**
 * row. One row cannot tell `id` from `name`, or `objectID` from `story_id`;
 * ten rows can. Where several templates still survive, the choice is made
 * deterministically so that the same trace always compiles to the same recipe.
 */
export function synthesizeAcrossRows(
  targets: Array<string | number | null>,
  rows: Array<Record<string, unknown>>,
): string | null {
  if (rows.length === 0 || targets.length !== rows.length) return null
  if (targets.some((t) => t === null || t === undefined)) return null

  const strings = targets.map((t) => String(t))

  // Every template that explains the first row is a candidate; the rest filter.
  const seeds = new Set<string>()
  const first = synthesizeTemplate(strings[0]!, rows[0]!)
  if (first === null) return null
  seeds.add(first)

  // Single-field alternatives, so an ambiguous pair is not collapsed too early.
  for (const [key, value] of scalarEntries(rows[0]!)) {
    if (!strings[0]!.includes(value)) continue
    seeds.add(strings[0]!.replace(new RegExp(escapeRegExp(value), 'g'), `{{${key}}}`))
  }

  const survives = (template: string): boolean =>
    strings.every((expected, i) => renderRowTemplate(template, rows[i]!) === expected)

  const survivors = [...seeds].filter(survives)

  // Only when nothing plain fits: the page's rule may be conditional on a null
  // field, as bandcamp renders `title by (album_artist ?? band_name)`.
  if (survivors.length === 0) {
    // Across every row, not just the first: the field a page falls back to is
    // null on the rows that made the fallback visible.
    const keys = [...new Set(rows.flatMap((row) => scalarEntries(row).map(([k]) => k)))].sort()
    for (const seed of seeds) {
      for (const slot of seed.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)) {
        const key = slot[1]!
        for (const other of keys) {
          if (other === key) continue
          for (const pair of [`${key} ?? ${other}`, `${other} ?? ${key}`]) {
            const candidate = seed.slice(0, slot.index) + `{{${pair}}}`
              + seed.slice(slot.index + slot[0]!.length)
            if (survives(candidate)) survivors.push(candidate)
          }
        }
      }
    }
  }
  if (survivors.length === 0) return null

  // Prefer the most parameterised survivor. A literal left in the template is a
  // value baked in from the recording: `{{id}} v1.0.229` reproduces the crate it
  // was learned from and reports that same version for every other crate. An
  // over-parameterised template at least varies with the data, and the
  // equivalence check and golden diff still judge it.
  survivors.sort((a, b) => placeholderCount(b) - placeholderCount(a) || a.localeCompare(b))
  return survivors[0]!
}

/**
 * Decides what a field's spec should be, given what the browser produced for it.
 *
 * A spec can be absent, or present and wrong: hn.algolia's payload has a `url`,
 * so `url` maps onto it by name, but the page's link is the discussion thread
 * while the payload's is the article. Mapping by name is a guess; the browser's
 * own values are the evidence. Returns null when neither the existing spec nor
 * any synthesis reproduces them.
 */
export function reconcileField(
  spec: string | undefined,
  browserValues: Array<string | number | null>,
  rows: Array<Record<string, unknown>>,
  readSpec: (spec: string, row: Record<string, unknown>) => unknown = defaultRead,
): string | null {
  if (spec !== undefined) {
    const reproduces = rows.every((row, i) => {
      const expected = browserValues[i]
      if (expected === null || expected === undefined) return false
      const actual = readSpec(spec, row)
      return actual !== undefined && actual !== null && String(actual) === String(expected)
    })
    if (reproduces) return spec
  }

  return synthesizeAcrossRows(browserValues, rows)
}

function defaultRead(spec: string, row: Record<string, unknown>): unknown {
  if (!spec.startsWith('$')) return renderRowTemplate(spec, row)
  if (spec === '$') return row
  return spec
    .slice(2)
    .split('.')
    .reduce<unknown>((node, key) => (node === null || typeof node !== 'object' ? undefined : (node as Record<string, unknown>)[key]), row)
}
