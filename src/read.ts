import { load } from 'cheerio'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { UserError, atomicWrite } from './local.js'

export type ReadMethod = 'http' | 'browser'

export interface ReadResult {
  url: string
  method: ReadMethod
  /** Why this method answered; HTTP text is the server's HTML, not the rendered page. */
  reason: string
  title: string
  text: string
}

export interface ReadDeps {
  isAllowed(url: string): Promise<boolean>
  fetch(url: string): Promise<{ status: number; headers: Record<string, string>; body: string }>
  render(url: string): Promise<string>
  methods: { get(shape: string): Promise<ReadMethod | undefined>; set(shape: string, method: ReadMethod): Promise<void> }
}

// Below this much visible text the server HTML is treated as a shell for a script to fill.
const MIN_TEXT = 200
const BLOCK_STATUSES = new Set([401, 403, 429, 503])

/** Host plus path, with id- and slug-like segments collapsed, so pages of one structure share a key. */
export function urlShape(url: string): string {
  const u = new URL(url)
  const segments = u.pathname.split('/').filter(Boolean)
    .map(s => /\d/.test(s) || s.split('-').length >= 3 || s.length >= 16 ? '*' : s)
  return `${u.host}/${segments.join('/')}`
}

const HIDDEN = 'script, style, noscript, template, svg, iframe'
// Site chrome repeats on every page and can outweigh the content many times over.
const CHROME = 'nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo]'
const BLOCKS = 'p, div, li, dt, dd, h1, h2, h3, h4, h5, h6, br, tr, section, article, main, ul, ol, table, pre, blockquote, figcaption'

export function visibleText(html: string): { title: string; text: string } {
  const $ = load(html)
  const title = $('title').first().text().trim()
  $(HIDDEN).remove()
  $(CHROME).remove()
  $(BLOCKS).after('\n')
  const main = $('main, [role=main], article').first()
  const root = main.length && main.text().trim() ? main : $('body')
  const text = root.text().replace(/[ \t\f\v\r]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
  return { title, text }
}

export async function readUrl(url: string, deps: ReadDeps): Promise<ReadResult> {
  if (!(await deps.isAllowed(url))) throw new UserError('ROBOTS_DISALLOWED', `robots.txt disallows ${url}`)
  const shape = urlShape(url)

  let reason = 'remembered: this URL shape needed a browser before'
  if ((await deps.methods.get(shape)) !== 'browser') {
    const res = await deps.fetch(url)
    const type = res.headers['content-type'] ?? ''
    if (res.status >= 200 && res.status < 300 && !/html/i.test(type)) {
      await deps.methods.set(shape, 'http')
      return { url, method: 'http', reason: `server returned ${type || 'a non-HTML body'}`, title: '', text: res.body }
    }
    if (res.status >= 200 && res.status < 300) {
      const page = visibleText(res.body)
      if (page.text.length >= MIN_TEXT) {
        await deps.methods.set(shape, 'http')
        return { url, method: 'http', reason: 'server HTML carries the text; not the rendered page', ...page }
      }
      reason = `server HTML is a shell (${page.text.length} chars of text)`
    } else if (BLOCK_STATUSES.has(res.status)) {
      reason = `HTTP ${res.status}`
    } else {
      throw new UserError('EXECUTION_FAILED', `HTTP ${res.status} for ${url}`)
    }
  }

  const page = visibleText(await deps.render(url))
  if (page.text.length === 0) throw new UserError('UNVERIFIED_RESULT', `the rendered page has no text: an empty page, an access block, or content that needs interaction (${reason})`)
  await deps.methods.set(shape, 'browser')
  return { url, method: 'browser', reason, ...page }
}

/** Remembered methods per URL shape, one small JSON file. */
export function methodStore(root: string): ReadDeps['methods'] {
  const path = join(root, 'read-methods.json')
  const load = async (): Promise<Record<string, ReadMethod>> => {
    try { return JSON.parse(await readFile(path, 'utf8')) } catch { return {} }
  }
  return {
    get: async (shape) => (await load())[shape],
    set: async (shape, method) => {
      const all = await load()
      if (all[shape] === method) return
      await atomicWrite(path, JSON.stringify({ ...all, [shape]: method }, null, 1))
    },
  }
}
