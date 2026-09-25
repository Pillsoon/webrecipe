// Full learn output on the saved HTML, so an optimization can be checked against it byte for byte.
import { readFileSync, writeFileSync } from 'node:fs'
import { learnFromHtml } from '../../../../src/authoring/learn.js'
const [label, tag] = [process.argv[2]!, process.argv[3]!]
const html = readFileSync(new URL(`./${label}.html`, import.meta.url), 'utf8')
const t0 = performance.now()
const report = learnFromHtml(`file://${label}`, html)
const ms = Math.round(performance.now() - t0)
writeFileSync(new URL(`./${label}.${tag}.json`, import.meta.url), JSON.stringify(report, null, 1))
console.log(JSON.stringify({ label, tag, ms, candidates: report.items.length, fields: report.items.map((i) => i.fields.length) }))
