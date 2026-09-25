// Inside fieldCandidates for the top candidates: spec discovery loop vs the one big extraction.
import { readFileSync } from 'node:fs'
import { generateCandidates, isEl, signatureOf, type El } from '../../../../src/authoring/candidates.js'
import { extractBySelector, parseHtmlFragment } from '../../../../src/executor/extract.js'

const label = process.argv[2]!
const html = readFileSync(new URL(`./${label}.html`, import.meta.url), 'utf8')
const cands = generateCandidates(html).slice(0, 3)
for (const c of cands) {
  const $ = parseHtmlFragment(html)
  const items = $(c.selector).toArray().filter(isEl)
  let descendants = 0, finds = 0
  const t0 = performance.now()
  const specs = new Set<string>()
  for (const item of items) {
    for (const el of $(item).find('*').toArray().filter(isEl)) {
      descendants++
      let spec = signatureOf($, el); let node: El = el; let rel: string | null = null
      for (let d = 0; d < 3; d++) {
        finds++
        if ($(item).find(spec).length === 1) { rel = spec; break }
        const p = node.parent
        if (p === null || !isEl(p) || p === item) break
        spec = `${signatureOf($, p)} > ${spec}`; node = p
      }
      if (rel !== null) specs.add(rel)
    }
  }
  const loopMs = Math.round(performance.now() - t0)
  const named = Object.fromEntries([...specs].filter((s) => !s.includes('\\@')).map((s, i) => [`f${i}`, s]))
  const t1 = performance.now()
  extractBySelector(html, c.selector, named)
  const extractMs = Math.round(performance.now() - t1)
  console.log(JSON.stringify({ label, selector: c.selector, items: items.length, descendants, finds, specs: specs.size, loopMs, extractMs }))
}
