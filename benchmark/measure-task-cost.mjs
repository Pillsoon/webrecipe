// Run with: node --import tsx benchmark/measure-task-cost.mjs [source-root] [output.json]
// A fresh recipe directory; only local fixture requests. No existing recipes are changed.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(process.argv[2] ?? '.')
const fromRoot = (path) => import(pathToFileURL(resolve(root, path)).href)
const { startXhrFixture } = await fromRoot('fixtures/xhr.ts')
const { buildEngine } = await fromRoot('src/wiring.ts')
const { PLANS } = await fromRoot('benchmark/plans.ts')
const dir = await mkdtemp('/tmp/fwa-task-cost-')
const fixture = await startXhrFixture()
const engine = buildEngine({ recipeDir: dir, origins: { siteB: fixture.url }, plans: PLANS, minIntervalMs: 0 })
const rows = []
let reference
try {
  for (const phase of ['first-learn', 'repeat-http', 'endpoint-drift', 'repeat-after-healing']) {
    if (phase === 'endpoint-drift') fixture.setVersion('v2')
    const requestsBefore = fixture.requestLog.length
    const started = performance.now()
    const result = await engine.executor.run({ id: phase, site: 'siteB', intent: 'search', input: { query: 'rust' } })
    const wallMs = Math.round(performance.now() - started)
    reference ??= JSON.stringify(result.items)
    rows.push({ phase, wallMs, actualRequests: fixture.requestLog.length - requestsBefore,
      matchesFirst: reference === JSON.stringify(result.items), items: result.items.length,
      meta: result.meta, reasons: result.reasons })
  }
} finally {
  await engine.warm.close(); await fixture.close(); await rm(dir, { recursive: true, force: true })
}
const output = JSON.stringify({ fixture: 'siteB', input: { query: 'rust' }, rows }, null, 2) + '\n'
if (process.argv[3]) await writeFile(process.argv[3], output)
console.log(output)
