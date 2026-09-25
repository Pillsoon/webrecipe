import { it, expect } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { teach } from '../src/authoring/teach.js'
import { RecipeRegistry } from '../src/recipes/registry.js'
import { SelfHealer } from '../src/healing/index.js'
import { StaticSiteResolver } from '../src/sites.js'
import { startFixture, sendHtml } from '../fixtures/harness.js'

it('preserves a good task on invalid teaching, removes stale recipes on browser-only reteaching, and persists compile refusal', async () => {
  const root = await mkdtemp('/tmp/fwa-durable-')
  const server = await startFixture('dynamic', (_req, res, state) => {
    const row = '<li class="result"><a>Correct title</a></li>'
    sendHtml(res, state.version === 'v1' ? `<ul>${row}</ul>` : `<ul id="items"></ul><script>document.querySelector('#items').innerHTML=${JSON.stringify(row)}</script>`)
  })
  const opts = { site: 'newsite', intent: 'list' as const, url: `${server.url}/list`, input: {}, itemSelector: 'li.result', fields: { title: 'a' }, planDir: join(root,'plans'), recipeDir: join(root,'recipes') }
  try {
    const first = await teach(opts)
    expect(first.recipe?.strategy.type).toBe('http-html')
    await expect(teach({ ...opts, itemSelector: '.nonexistent' })).rejects.toThrow('No readable items')
    const registry = new RecipeRegistry(opts.recipeDir)
    expect(await registry.load(opts.site,opts.intent)).toEqual(first.recipe)
    expect(JSON.parse(await readFile(first.planPath,'utf8')).itemSelector).toBe('li.result')
    server.setVersion('v2')
    const second = await teach(opts)
    expect(second.recipe).toBeNull()
    expect(await registry.load(opts.site,opts.intent)).toBeNull()
    const restored = new RecipeRegistry(opts.recipeDir)
    expect(await restored.learningFailure(opts.site,opts.intent)).toBe(second.refused)
    // A fresh healer must skip the expensive second visit, even without in-memory state.
    const healer = new SelfHealer({ registry: restored, sites: new StaticSiteResolver({newsite: server.url}), plans: {newsite: {list: {url: () => {throw new Error('must not record')},itemSelector:'li.result',fields:opts.fields}}} })
    expect((await healer.heal({ task:{id:'later',site:opts.site,intent:opts.intent,input:{}},recipe:null,reasons:[] })).meta).toBeNull()
    const marker = join(opts.recipeDir,opts.site,'list.failure.json')
    await writeFile(marker,JSON.stringify({reason:'old refusal',until:Date.now()-1}))
    expect(await restored.learningFailure(opts.site,opts.intent)).toBeNull()
  } finally { await server.close(); await rm(root,{recursive:true,force:true}) }
}, 30_000)
