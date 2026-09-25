import { captureDom } from './snapshot.js'
import { generateCandidates, type Candidate } from './candidates.js'
import { fieldCandidates, type FieldCandidate } from './fields.js'

/**
 * One browser visit, turned into the options an agent chooses between.
 *
 * Nothing is stored and nothing is decided. The ranking is the order of a list
 * somebody else reads: the item-selector heuristic put the right answer first
 * on none of six labelled pages and second or third on five of them, which is
 * a bad ranker and a fine shortlist. The one site tried outside that corpus,
 * Hacker News, put the answer seventh, so the default has to reach past
 * "second or third" to still be useful off the labelled set.
 */

const DEFAULT_DEPTH = 10
const FIELDS_PER_ITEM = 12

export interface LearnReport {
  url: string
  items: Array<{ candidate: Candidate; fields: FieldCandidate[] }>
}

export function learnFromHtml(url: string, html: string, depth = DEFAULT_DEPTH): LearnReport {
  const items = generateCandidates(html)
    .slice(0, depth)
    .map((candidate) => ({
      candidate,
      fields: fieldCandidates(html, candidate.selector, FIELDS_PER_ITEM),
    }))
  return { url, items }
}

export async function learn(url: string, depth = DEFAULT_DEPTH): Promise<LearnReport> {
  return learnFromHtml(url, (await captureDom(url)).html, depth)
}

const pct = (v: number): string => v.toFixed(2)

/**
 * Every line here is a fragment of a command someone will run, so a spec has
 * to survive being pasted into one. A class carrying `$` or a backtick, which
 * this generator escapes and therefore can produce, is mangled by a
 * double-quoted shell; single quotes are the encoding that matches the context.
 */
export const shell = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`

/** Visibly cut, so a value that diverges past the cut cannot look identical. */
const clip = (value: string, width: number): string =>
  value.length <= width ? value : `${value.slice(0, width - 1)}…`

export function formatLearn(report: LearnReport): string {
  const lines = [report.url, '']
  report.items.forEach(({ candidate, fields }, i) => {
    lines.push(`${i + 1}. --items ${shell(candidate.selector)}   ${candidate.count} items`)
    if (candidate.samples[0] !== undefined) lines.push(`     sample: ${candidate.samples[0].slice(0, 90)}`)
    for (const f of fields) {
      lines.push(
        `     --field NAME=${shell(f.spec).padEnd(34)} ` +
        `cover ${pct(f.coverage)} distinct ${pct(f.distinct)}  ${clip(f.samples[0] ?? '', 60)}`,
      )
    }
    lines.push('')
  })
  return lines.join('\n')
}
