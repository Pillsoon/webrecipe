import { atomicWrite, siteName, intentName } from '../local.js'
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { RecipeSchema, type Recipe } from './schema.js'
import type { Intent } from '../types.js'

export class RecipeRegistry {
  constructor(private readonly root: string) {}

  private dir(site: string): string { return join(this.root, siteName(site)) }
  private file(site: string, intent: Intent): string { return join(this.dir(site), `${intentName(intent)}.yaml`) }

  async load(site: string, intent: Intent): Promise<Recipe | null> {
    let raw: string
    try {
      raw = await readFile(this.file(site, intent), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    return RecipeSchema.parse(parse(raw))
  }

  /**
   * Saving over an existing recipe archives it as `<intent>.<timestamp>.yaml`,
   * unless the recipe is the one already stored.
   */
  async save(recipe: Recipe): Promise<string> {
    const parsed = RecipeSchema.parse(recipe)
    await mkdir(this.dir(parsed.site), { recursive: true })
    const target = this.file(parsed.site, parsed.intent)
    const body = stringify(parsed)

    try {
      const stored = await readFile(target, 'utf8')
      // An identical recipe is not a new version: archiving it buries the
      // versions that do differ under copies of the one still in use, which is
      // what a site serving the engine a different page produced every task.
      if (stored === body) return target
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await rename(target, join(this.dir(parsed.site), `${parsed.intent}.${stamp}.yaml`))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    await atomicWrite(target, body)
    return target
  }

  async remove(site: string, intent: Intent): Promise<void> {
    await rm(this.file(site, intent), { force: true })
  }

  private failureFile(site: string, intent: Intent): string { return join(this.dir(site), `${intentName(intent)}.failure.json`) }

  async learningFailure(site: string, intent: Intent): Promise<string | null> {
    try {
      const state = JSON.parse(await readFile(this.failureFile(site, intent), 'utf8'))
      return typeof state.reason === 'string' && state.until > Date.now() ? state.reason : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async setLearningFailure(site: string, intent: Intent, reason: string): Promise<void> {
    await atomicWrite(this.failureFile(site, intent), JSON.stringify({ reason, until: Date.now() + 24 * 60 * 60_000 }))
  }

  async clearLearningFailure(site: string, intent: Intent): Promise<void> {
    await rm(this.failureFile(site, intent), { force: true })
  }

  async versions(site: string, intent: Intent): Promise<string[]> {
    try {
      const entries = await readdir(this.dir(site))
      return entries.filter((f) => f.startsWith(`${intent}.`) && f.endsWith('.yaml') && f !== `${intentName(intent)}.yaml`).sort()
    } catch {
      return []
    }
  }
}
