import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecipeRegistry } from '../../src/recipes/registry.js'
import type { Recipe } from '../../src/recipes/schema.js'

const recipe: Recipe = {
  site: 'siteB', intent: 'search',
  inputs: { query: { type: 'string' } },
  strategy: { type: 'http-json' },
  request: { method: 'GET', path: '/api/search', query: { q: '{{query}}' } },
  output: { type: 'json', items: { path: '$.results', fields: { id: '$.id', title: '$.title' } } },
  validation: { status: 200, required: ['id', 'title'], minItems: 1 },
  fingerprint: { endpoint: '/api/search', hash: 'h1', responseFields: ['results', 'results[].id'] },
  fallback: { type: 'browser' },
}

let dir: string
let registry: RecipeRegistry

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fwa-'))
  registry = new RecipeRegistry(dir)
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('RecipeRegistry', () => {
  it('returns null when nothing is stored', async () => {
    expect(await registry.load('siteB', 'search')).toBeNull()
  })

  it('round-trips a recipe through YAML', async () => {
    await registry.save(recipe)
    expect(await registry.load('siteB', 'search')).toEqual(recipe)
  })

  it('keeps the superseded recipe as a version when saving over one', async () => {
    await registry.save(recipe)
    await registry.save({ ...recipe, request: { ...recipe.request, path: '/api/v2/search' } })
    expect((await registry.load('siteB', 'search'))!.request.path).toBe('/api/v2/search')
    expect(await registry.versions('siteB', 'search')).toHaveLength(1)
  })

  it('archives nothing when the recipe saved is the one already stored', async () => {
    await registry.save(recipe)
    await registry.save(recipe)
    expect(await registry.versions('siteB', 'search')).toHaveLength(0)
    expect(await readdir(join(dir, 'siteB'))).toEqual(['search.yaml'])
  })

  it('rejects a stored file that no longer matches the schema', async () => {
    await mkdir(join(dir, 'siteB'), { recursive: true })
    await writeFile(join(dir, 'siteB', 'search.yaml'), 'site: siteB\nintent: nonsense\n')
    await expect(registry.load('siteB', 'search')).rejects.toThrow()
  })
})
