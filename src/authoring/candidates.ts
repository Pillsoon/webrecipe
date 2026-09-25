import * as cheerio from 'cheerio'
import { parseHtmlFragment } from '../executor/extract.js'

/**
 * Every repeated run of sibling elements on a page, ranked, so that choosing an
 * item selector becomes a choice among named options instead of an unrecorded
 * judgement. `bench screen` returns the largest run alone; three rounds were
 * lost to selectors that a list of the alternatives would have made obvious.
 */
export interface Candidate {
  selector: string
  count: number
  /** The first few matched elements' text, so the list reads without re-running it. */
  samples: string[]
  /** False when the run could not be addressed through its parent — see addressOf. */
  scoped: boolean
}

const SAMPLE_COUNT = 3
/** How far up the tree an address may walk before the chain gets too brittle to trust. */
const ADDRESS_DEPTH = 8
/** Text these carry is code, not content, and it would dominate the ranking. */
const NOISE = 'script, style, noscript, template'

/**
 * The document every part of this harness works on. The generator and the
 * scorer have to agree on what is on the page: scored against a document that
 * still holds its `<template>` contents, a correct selector reads as
 * over-matching and a wrong one can read as exact.
 */
export function loadPage(html: string): cheerio.CheerioAPI {
  const $ = parseHtmlFragment(html)
  $(NOISE).remove()
  return $
}

function nodesOf($: cheerio.CheerioAPI, selector: string) { return $(selector).toArray() }
type Node = ReturnType<typeof nodesOf>[number]
export type El = Extract<Node, { tagName: string }>
export const isEl = (n: Node): n is El => 'tagName' in n
export function elementsOf($: cheerio.CheerioAPI, selector: string): El[] {
  return nodesOf($, selector).filter(isEl)
}

export const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim()

/**
 * Everything this element says: its rendered text, and the alternative text of
 * any image it holds. A shelf of books says nothing in text at all — each item
 * is a cover, and the title is the cover's `alt` — so a definition that stops
 * at `.text()` cannot tell one item from another. The generator, the label
 * dump and the scorer all read the page through this, for the same reason they
 * all parse it through `loadPage`.
 */
export function perceivedText($: cheerio.CheerioAPI, el: El): string {
  const own = el.tagName.toLowerCase() === 'img' ? $(el).attr('alt') ?? '' : ''
  const alts = $(el).find('img[alt]').map((_, img) => $(img).attr('alt') ?? '').toArray()
  return normalize([own, $(el).text(), ...alts].join(' '))
}

const textOf = perceivedText

/** A class like Tailwind's `md:flex` is not a bare CSS identifier; escape it. */
export function escapeIdent(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

export function signatureOf($: cheerio.CheerioAPI, el: El): string {
  const classes = ($(el).attr('class') ?? '').trim().split(/\s+/).filter(Boolean)
  return el.tagName.toLowerCase() + classes.map((c) => `.${escapeIdent(c)}`).join('')
}

/**
 * The shortest selector that addresses this one element, or null when eight
 * ancestors were not enough to find one. Uniqueness is checked by running each
 * form rather than assumed, because an escaped class or an unusual document can
 * make a plausible-looking address match something else.
 */
function addressOf($: cheerio.CheerioAPI, el: El, depth = ADDRESS_DEPTH, memo = new Map<El, Map<number, string | null>>()): string | null {
  // Groups under one parent share that parent, and parents share ancestors: on a
  // 10k-element page the same address was recomputed, whole-document query and
  // all, hundreds of times.
  const known = memo.get(el)?.get(depth)
  if (known !== undefined) return known
  const address = uncachedAddressOf($, el, depth, memo)
  if (!memo.has(el)) memo.set(el, new Map())
  memo.get(el)!.set(depth, address)
  return address
}

function uncachedAddressOf($: cheerio.CheerioAPI, el: El, depth: number, memo: Map<El, Map<number, string | null>>): string | null {
  if (depth === 0) return null
  const tag = el.tagName.toLowerCase()
  if (tag === 'body' || tag === 'html') return tag

  const id = $(el).attr('id')
  if (id !== undefined && id !== '') {
    const byId = `#${escapeIdent(id)}`
    if (elementsOf($, byId).length === 1) return byId
  }

  const own = signatureOf($, el)
  if (elementsOf($, own).length === 1) return own

  const parent = el.parent
  if (parent === null || !isEl(parent)) return null
  const parentAddress = addressOf($, parent, depth - 1, memo)
  if (parentAddress === null) return null

  const nth = $(el).prevAll(tag).length + 1
  const chained = `${parentAddress} > ${tag}:nth-of-type(${nth})`
  return elementsOf($, chained).length === 1 ? chained : null
}

interface Group { parent: El; signature: string; elements: El[] }

function groupsOf($: cheerio.CheerioAPI): Group[] {
  const groups: Group[] = []
  for (const parent of elementsOf($, '*')) {
    const bySignature = new Map<string, El[]>()
    for (const child of $(parent).children().toArray().filter(isEl)) {
      const signature = signatureOf($, child)
      const run = bySignature.get(signature)
      if (run) run.push(child)
      else bySignature.set(signature, [child])
    }
    for (const [signature, elements] of bySignature) {
      if (elements.length >= 2) groups.push({ parent, signature, elements })
    }
  }
  return groups
}

/** Materialises a proposed selector: what it matches is what gets reported. */
function materialize($: cheerio.CheerioAPI, selector: string, scoped: boolean): Candidate | null {
  const matched = elementsOf($, selector)
  if (matched.length < 2) return null
  if (matched.every((el) => textOf($, el) === '')) return null
  const samples = matched.slice(0, SAMPLE_COUNT).map((el) => textOf($, el))
  return { selector, count: matched.length, samples, scoped }
}

function weightOf($: cheerio.CheerioAPI, selector: string): number {
  return elementsOf($, selector).reduce((total, el) => total + textOf($, el).length, 0)
}

export function generateCandidates(html: string): Candidate[] {
  const $ = loadPage(html)

  const groups = groupsOf($)
  const proposals = new Map<string, boolean>()

  // The bare signature first, so that when a scoped form turns out to select
  // the same elements the shorter one is the survivor.
  for (const group of groups) proposals.set(group.signature, false)

  const addresses = new Map<El, Map<number, string | null>>()
  for (const group of groups) {
    const parentAddress = addressOf($, group.parent, ADDRESS_DEPTH, addresses)
    if (parentAddress === null) continue
    const scoped = `${parentAddress} > ${group.signature}`
    const matched = new Set(elementsOf($, scoped))

    // The scoped form has to still reach every element of the group it came
    // from — an escape this code got wrong would show up here as a selector
    // that no longer finds its own elements. It does not have to stop there:
    // a class selector matches by subset while a group is one exact class set,
    // so a carousel that marks some slides active splits twenty items into
    // three groups whose shared selector legitimately selects all twenty.
    // Requiring the group back exactly discarded that selector, which was the
    // only exact candidate openlibrary had.
    const reaches = group.elements.every((el) => matched.has(el))
    if (reaches && matched.size >= 2 && !proposals.has(scoped)) proposals.set(scoped, true)
  }

  const built: Candidate[] = []
  const seen = new Set<string>()
  const index = new Map<El, number>()
  elementsOf($, '*').forEach((el, i) => index.set(el, i))

  for (const [selector, scoped] of proposals) {
    const candidate = materialize($, selector, scoped)
    if (candidate === null) continue
    const identity = elementsOf($, selector).map((el) => index.get(el)).join(',')
    if (seen.has(identity)) continue
    seen.add(identity)
    built.push(candidate)
  }

  // Once per candidate, not once per comparison: the sort asked for each weight
  // a few thousand times, and each answer read the text of every match.
  const weights = new Map(built.map((c) => [c.selector, weightOf($, c.selector)]))
  return built
    .sort((a, b) => weights.get(b.selector)! - weights.get(a.selector)! || b.count - a.count)
}
