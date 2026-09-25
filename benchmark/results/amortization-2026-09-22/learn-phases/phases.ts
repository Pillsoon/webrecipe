// Where does `learn` spend its time? Browser load vs candidate generation vs field candidates.
import { writeFileSync } from 'node:fs'
import { captureDom } from '../../../../src/authoring/snapshot.js'
import { generateCandidates } from '../../../../src/authoring/candidates.js'
import { fieldCandidates } from '../../../../src/authoring/fields.js'

const url = process.argv[2]!
const label = process.argv[3]!
const t0 = performance.now()
const { html } = await captureDom(url)
const loadMs = Math.round(performance.now() - t0)
writeFileSync(new URL(`./${label}.html`, import.meta.url), html)

const t1 = performance.now()
const candidates = generateCandidates(html)
const candMs = Math.round(performance.now() - t1)

const t2 = performance.now()
const perField: number[] = []
for (const c of candidates.slice(0, 10)) {
  const s = performance.now()
  fieldCandidates(html, c.selector, 12)
  perField.push(Math.round(performance.now() - s))
}
const fieldMs = Math.round(performance.now() - t2)
console.log(JSON.stringify({ label, htmlKB: Math.round(html.length / 1024), loadMs, candMs, candidates: candidates.length, fieldMs, perField }))
