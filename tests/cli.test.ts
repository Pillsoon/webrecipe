import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { startXhrFixture } from '../fixtures/xhr.js'
import type { FixtureServer } from '../fixtures/harness.js'
import { buildEngine } from '../src/wiring.js'
import { PLANS } from '../benchmark/plans.js'
import type { Task } from '../src/types.js'

let server: FixtureServer
let dir: string

beforeEach(async () => {
  server = await startXhrFixture()
  dir = await mkdtemp(join(tmpdir(), 'fwa-cli-'))
})
afterEach(async () => { await server.close(); await rm(dir, { recursive: true, force: true }) })

const task: Task = { id: 'demo', site: 'siteB', intent: 'search', input: { query: 'rust' } }
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const run = promisify(execFile)

function engine(d: string, origin: string) {
  return buildEngine({ recipeDir: d, plans: PLANS, origins: { siteB: origin }, minIntervalMs: 0 })
}

describe('buildEngine', () => {
  it('uses a browser on the first run and no browser on the second', async () => {
    const e = engine(dir, server.url)

    const first = await e.executor.run(task)
    // A browser level, warm or cold — the point is that it needed one at all.
    expect(['warm-browser', 'browser']).toContain(first.meta.strategy)
    expect(first.fellBack).toBe(true)

    const second = await e.executor.run(task)
    expect(second.meta.browserLaunches).toBe(0)
    expect(second.recipeUsed).toBe(true)
    expect(second.items.length).toBeGreaterThan(0)
  }, 90_000)

  it('is faster on the second run', async () => {
    const e = engine(dir, server.url)
    const first = await e.executor.run(task)
    const second = await e.executor.run(task)
    expect(second.meta.latencyMs).toBeLessThan(first.meta.latencyMs)
  }, 90_000)

  it('relearns after the endpoint moves and avoids the browser again on the next run', async () => {
    const e = engine(dir, server.url)
    await e.executor.run(task)
    expect((await e.executor.run(task)).meta.strategy).toBe('http-json')

    server.setVersion('v2')
    const broken = await e.executor.run(task)
    expect(broken.fellBack).toBe(true)

    const relearned = await e.executor.run(task)
    expect(relearned.meta.strategy).toBe('http-json')
    expect((await e.registry.load('siteB', 'search'))!.request.path).toBe('/api/v2/search')
  }, 120_000)
})

describe('bench run --json', () => {
  it('records whether the site blocked the engine', async () => {
    // Its own cwd, because the command resolves recipes and goldens from there.
    const tasks = join(dir, 'tasks.json')
    await writeFile(tasks, JSON.stringify([
      { id: 'siteA-search-1', set: 'controlled', site: 'siteA', intent: 'search', input: { query: 'rust' } },
    ]))
    const out = join(dir, 'run.json')
    await run(join(ROOT, 'node_modules/.bin/tsx'),
      [join(ROOT, 'src/cli.ts'), 'bench', 'run', '--tasks', tasks, '--json', out], { cwd: dir })

    const rows = JSON.parse(await readFile(out, 'utf8')) as Array<{ engine: { blocked: unknown } }>
    expect(typeof rows[0]!.engine.blocked).toBe('boolean')
  }, 120_000)
})
