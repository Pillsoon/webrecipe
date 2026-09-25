import { elementsOf, generateCandidates, loadPage, normalize, perceivedText, type Candidate, type El } from '../authoring/candidates.js'
import type { Label } from './labels.js'
import * as cheerio from 'cheerio'

export interface Score {
  /** Matches that carry at least one labeled item, over all matches. */
  precision: number
  /** Labeled items carried by at least one match, over all labeled items. */
  recall: number
  /** One match per labeled item and one labeled item per match. */
  exact: boolean
}

/** `/item/1` must not answer for `/item/12`, so the match has to end at a boundary. */
function hrefCovers(href: string, item: string): boolean {
  let from = 0
  for (;;) {
    const at = href.indexOf(item, from)
    if (at === -1) return false
    const after = href[at + item.length]
    if (after === undefined || !/[A-Za-z0-9_-]/.test(after)) return true
    from = at + 1
  }
}

function coversOf($: cheerio.CheerioAPI, el: El, label: Label): number[] {
  if (label.identifier === 'text') {
    const text = perceivedText($, el)
    return label.items.flatMap((item, i) => (text.includes(normalize(item)) ? [i] : []))
  }
  const own = $(el).attr('href')
  const hrefs = [...(own === undefined ? [] : [own]), ...$(el).find('[href]').map((_, n) => $(n).attr('href') ?? '').toArray()]
  return label.items.flatMap((item, i) => (hrefs.some((href) => hrefCovers(href, item)) ? [i] : []))
}

function scoreAgainst($: cheerio.CheerioAPI, selector: string, label: Label): Score {
  const matched = elementsOf($, selector)
  if (matched.length === 0) return { precision: 0, recall: 0, exact: false }

  const covers = matched.map((el) => coversOf($, el, label))
  const covered = new Set(covers.flat())

  const precision = covers.filter((c) => c.length > 0).length / matched.length
  const recall = covered.size / label.items.length

  // A single <ul> wrapping every item scores 1.00 on both ratios and is not an
  // item selector, so exactness asks for a one-to-one correspondence as well.
  const onePerMatch = covers.every((c) => c.length === 1)
  const onePerItem = label.items.every(
    (_, i) => covers.filter((c) => c.includes(i)).length === 1,
  )
  const exact = matched.length === label.items.length && onePerMatch && onePerItem

  return { precision, recall, exact }
}

export function scoreSelector(html: string, selector: string, label: Label): Score {
  return scoreAgainst(loadPage(html), selector, label)
}

export interface SnapshotReport {
  snapshot: string
  labeled: number
  rows: Array<{ candidate: Candidate; score: Score }>
  /** 1-based rank of the first exact candidate — the generator's answer. */
  exactRank: number | null
  /** Whether the heuristic put it first — the ranker's answer. */
  topIsExact: boolean
}

export function scoreSnapshot(snapshot: string, html: string, label: Label): SnapshotReport {
  const $ = loadPage(html)
  const rows = generateCandidates(html).map((candidate) => ({
    candidate,
    score: scoreAgainst($, candidate.selector, label),
  }))
  const found = rows.findIndex((r) => r.score.exact)
  return {
    snapshot,
    labeled: label.items.length,
    rows,
    exactRank: found === -1 ? null : found + 1,
    topIsExact: rows[0]?.score.exact === true,
  }
}

const pct = (value: number): string => value.toFixed(2)
/** Rows are for a human to scan; the measurement itself runs over the full list. */
const MAX_ROWS_SHOWN = 50

function formatSnapshotReport(report: SnapshotReport): string {
  const lines = [
    `${report.snapshot}  (${report.labeled} labeled items)`,
    `  generator: an exact candidate is present   ${report.exactRank === null ? 'no' : `yes  (rank ${report.exactRank} of ${report.rows.length})`}`,
    `  heuristic: top candidate is exact          ${report.topIsExact ? 'yes' : 'no'}`,
  ]
  report.rows.slice(0, MAX_ROWS_SHOWN).forEach(({ candidate, score }, i) => {
    const mark = score.exact ? '  <- exact' : ''
    const scope = candidate.scoped ? '' : '  (unscoped)'
    lines.push(
      `  ${String(i + 1).padStart(2)}. ${candidate.selector.padEnd(44)} ${String(candidate.count).padStart(4)}` +
      `  p=${pct(score.precision)} r=${pct(score.recall)}${mark}${scope}`,
    )
  })
  if (report.rows.length > MAX_ROWS_SHOWN) {
    lines.push(`  ... and ${report.rows.length - MAX_ROWS_SHOWN} further candidates, not shown`)
  }
  return lines.join('\n')
}

export function formatCorpus(reports: SnapshotReport[]): string {
  const generated = reports.filter((r) => r.exactRank !== null).length
  const ranked = reports.filter((r) => r.topIsExact).length
  return [
    ...reports.map(formatSnapshotReport),
    '',
    `generator recall:  ${generated}/${reports.length}`,
    `ranking accuracy:  ${ranked}/${reports.length}`,
  ].join('\n\n')
}
