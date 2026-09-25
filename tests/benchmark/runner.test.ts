import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTasks } from '../../src/benchmark/runner.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fwa-b-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('loadTasks', () => {
  it('loads tasks and keeps their set', async () => {
    const path = join(dir, 'tasks.json')
    await writeFile(path, JSON.stringify([
      { id: 'a', set: 'controlled', site: 'siteA', intent: 'search', input: { query: 'x' } },
      { id: 'b', set: 'wild', site: 'crates.io', intent: 'search', input: { query: 'serde' }, volatile: ['downloads'] },
    ]))
    const tasks = await loadTasks(path)
    expect(tasks).toHaveLength(2)
    expect(tasks[1]!.set).toBe('wild')
    expect(tasks[1]!.volatile).toEqual(['downloads'])
  })

  it('rejects a task with an unknown set', async () => {
    const path = join(dir, 'bad.json')
    await writeFile(path, JSON.stringify([{ id: 'a', set: 'imaginary', site: 's', intent: 'search', input: {} }]))
    await expect(loadTasks(path)).rejects.toThrow()
  })

  it('rejects a task with an unknown intent', async () => {
    const path = join(dir, 'bad2.json')
    await writeFile(path, JSON.stringify([{ id: 'a', set: 'wild', site: 's', intent: 'checkout', input: {} }]))
    await expect(loadTasks(path)).rejects.toThrow()
  })
})
