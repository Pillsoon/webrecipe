// Where generateCandidates spends its time, by re-running its phases on saved HTML.
import { readFileSync } from 'node:fs'
import { loadPage, elementsOf, isEl, signatureOf, perceivedText } from '../../../../src/authoring/candidates.js'
import { generateCandidates } from '../../../../src/authoring/candidates.js'
const label = process.argv[2]!
const html = readFileSync(new URL(`./${label}.html`, import.meta.url), 'utf8')
let t = performance.now(); const $ = loadPage(html); const loadMs = Math.round(performance.now() - t)
t = performance.now()
let groups = 0
for (const parent of elementsOf($, '*')) {
  const by = new Map<string, number>()
  for (const child of $(parent).children().toArray().filter(isEl)) { const s = signatureOf($, child); by.set(s, (by.get(s) ?? 0) + 1) }
  for (const n of by.values()) if (n >= 2) groups++
}
const groupsMs = Math.round(performance.now() - t)
t = performance.now(); const all = elementsOf($, '*'); const textMs = (() => { const s = performance.now(); for (const el of all) perceivedText($, el); return Math.round(performance.now() - s) })()
t = performance.now(); const cands = generateCandidates(html); const totalMs = Math.round(performance.now() - t)
let weightCalls = 0
console.log(JSON.stringify({ label, elements: all.length, loadMs, groups, groupsMs, perceivedTextAllMs: textMs, candidates: cands.length, generateTotalMs: totalMs, weightCalls }))
