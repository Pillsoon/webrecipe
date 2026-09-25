import { extractBySelector, parseHtmlFragment } from '../executor/extract.js'
import { isEl, normalize, signatureOf, type El } from './candidates.js'
import * as cheerio from 'cheerio'

/**
 * What each item on a page could be read as, so that choosing a field mapping
 * becomes a choice among named options with their values attached.
 *
 * The ranking carries the whole idea: a value present on every item and
 * different on every item is data, and a value present on every item and the
 * same on all of them is a label. That is what separates a title from
 * `Borrow`, `Follow` and `4 min read`, which is the noise every real listing
 * carries.
 */
export interface FieldCandidate {
  /** Exactly what `planFields` parses, so a chosen spec needs no translation. */
  spec: string
  /** Items whose value is non-empty, over all items. */
  coverage: number
  /** Distinct non-empty values, over all items. */
  distinct: number
  samples: string[]
}

const SAMPLE_COUNT = 3
const MAX_CANDIDATES = 40
/** How many ancestors a descendant's spec may name before it is too brittle. */
const SPEC_DEPTH = 3
/** Attributes worth reading. Everything else on a page is styling or state. */
const ATTRIBUTES = ['href', 'src', 'id']
/** Elements whose content is not data: script, style, noscript, template. */
const NOISE = new Set(['script', 'style', 'noscript', 'template'])

const attributesOf = ($: cheerio.CheerioAPI, el: El): string[] =>
  [...ATTRIBUTES, ...Object.keys(el.attribs ?? {}).filter((a) => a.startsWith('data-'))]
    .filter((a) => ($(el).attr(a) ?? '') !== '')

/**
 * The shortest selector naming this descendant inside its item, or null when
 * three levels were not enough to name it alone. Ambiguity is dropped rather
 * than guessed at: with many descendants to choose from, one that cannot be
 * addressed uniquely is not worth offering.
 */
function relativeSpec($: cheerio.CheerioAPI, item: El, el: El, matches: (spec: string) => number): string | null {
  let spec = signatureOf($, el)
  let node: El = el
  for (let depth = 0; depth < SPEC_DEPTH; depth++) {
    if (matches(spec) === 1) return spec
    const parent = node.parent
    if (parent === null || !isEl(parent) || parent === item) return null
    spec = `${signatureOf($, parent)} > ${spec}`
    node = parent
  }
  return null
}

export function fieldCandidates(html: string, itemSelector: string, limit = MAX_CANDIDATES): FieldCandidate[] {
  const $ = parseHtmlFragment(html)
  const items = $(itemSelector).toArray().filter(isEl)
  if (items.length === 0) return []

  const specs = new Set<string>()
  for (const item of items) {
    specs.add('')
    for (const attr of attributesOf($, item)) specs.add(`@${attr}`)
    // Descendants of one item share most signatures, and each `find` walks the
    // whole item subtree: on a page-sized item that was 60 seconds of asking
    // the same question. Same call, asked once per spec.
    const counts = new Map<string, number>()
    const matches = (spec: string): number => {
      let n = counts.get(spec)
      if (n === undefined) { n = $(item).find(spec).length; counts.set(spec, n) }
      return n
    }
    for (const el of $(item).find('*').toArray().filter(isEl)) {
      if (NOISE.has(el.tagName.toLowerCase())) continue
      const rel = relativeSpec($, item, el, matches)
      if (rel === null) continue
      specs.add(rel)
      for (const attr of attributesOf($, el)) specs.add(`${rel}@${attr}`)
    }
  }

  // Filter out specs with escaped @ before extraction, as they would be misparsed by the engine
  const validSpecs = [...specs].filter((spec) => !spec.includes('\\@'))

  // One extraction with every spec as its own field: the values are then read
  // exactly as the engine would read them, in a single parse.
  const named = validSpecs.map((spec, i) => [`f${i}`, spec] as const)
  const rows = extractBySelector(html, itemSelector, Object.fromEntries(named))

  const built = named.map(([name, spec]) => {
    const values = rows.map((row) => normalize(String(row[name] ?? '')))
    const present = values.filter((v) => v !== '')
    return {
      spec,
      coverage: present.length / values.length,
      distinct: new Set(present).size / values.length,
      samples: present.slice(0, SAMPLE_COUNT),
    }
  })

  return built
    .filter((c) => c.coverage > 0)
    .sort((a, b) => b.coverage - a.coverage || b.distinct - a.distinct || a.spec.length - b.spec.length)
    .slice(0, limit)
}
