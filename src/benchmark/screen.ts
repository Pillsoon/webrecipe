import { SETTLE_MS } from '../browser/navigate.js'
import { openSession } from '../browser/session.js'
import { DEFAULT_USER_AGENT, PolitenessLayer } from '../net/politeness.js'

/**
 * Held-out 4's accessibility screen was robots.txt plus one GET, and it passed
 * three sites that turned out to be boundaries: a virtualised timeline the plan
 * sees one row of, a page that does not render in time, and a site that hands
 * the engine a 200 challenge. Each of those is visible before a plan exists,
 * but only by putting the engine's client and a real browser side by side.
 *
 * This measures; it does not judge. Even the line about the two pages differing
 * names the evidence rather than returning a verdict: mastodon.social reads as
 * a title mismatch because its SPA shell is titled differently, which is true
 * and is not musicbrainz's kind of discrimination. The human decides which it is.
 */

const NAVIGATION_TIMEOUT_MS = 30_000
/** A body this much smaller than the browser's is not the same page. */
const SIZE_RATIO = 0.1

export interface SideReport {
  status: number
  bytes: number
  title: string | null
}

export interface ScreenReport {
  url: string
  engine: SideReport
  browser: SideReport
  /** The engine's body carries the text of the title the browser rendered. */
  carriesBrowserTitle: boolean
  /** What differs between the two pages, empty when nothing does. */
  differences: string[]
  renderMs: number
  networkIdle: boolean
  largestListing: { count: number; signature: string } | null
  largestJsonArray: number
}

function titleOf(html: string): string | null {
  return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null
}

/** The longest array anywhere in a payload, which is what a listing arrives as. */
export function largestArray(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((best, v) => Math.max(best, largestArray(v)), value.length)
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).reduce<number>((best, v) => Math.max(best, largestArray(v)), 0)
  }
  return 0
}

/**
 * The largest run of sibling elements sharing a tag+class signature, which is
 * the same heuristic the authoring scratch scripts used to find a listing
 * before anyone had written a selector for it.
 */
const LARGEST_SIBLING_RUN = `(() => {
  let best = { count: 0, signature: '' }
  const walk = (parent) => {
    const counts = new Map()
    for (const child of parent.children) {
      const cls = (child.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).join('.')
      const signature = child.tagName.toLowerCase() + (cls ? '.' + cls : '')
      counts.set(signature, (counts.get(signature) || 0) + 1)
    }
    for (const [signature, count] of counts) {
      if (count > best.count) best = { count, signature }
    }
    for (const child of parent.children) walk(child)
  }
  if (document.body) walk(document.body)
  return best.count > 0 ? best : null
})()`

export async function screen(url: string, net?: PolitenessLayer): Promise<ScreenReport> {
  const client = net ?? new PolitenessLayer({ userAgent: DEFAULT_USER_AGENT })
  const fetched = await client.fetch(url)

  const session = await openSession()
  let largestJsonArray = 0
  const bodies: Promise<unknown>[] = []

  session.page.on('response', (response) => {
    if (!/json/i.test(response.headers()['content-type'] ?? '')) return
    bodies.push(
      response
        .text()
        .then((text) => { largestJsonArray = Math.max(largestJsonArray, largestArray(JSON.parse(text))) })
        .catch(() => undefined),
    )
  })

  try {
    const started = Date.now()
    const response = await session.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    })

    // Idle is the condition a slow page fails, so it gets the full navigation
    // budget rather than navigate.ts's short best-effort wait. A run that ends
    // at the timeout is the measurement, which is why whether it arrived is
    // reported beside the number.
    const networkIdle = await session.page
      .waitForLoadState('networkidle', { timeout: NAVIGATION_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false)
    await session.page.waitForTimeout(SETTLE_MS)
    const renderMs = Date.now() - started

    // A body still parsing is part of the measurement. Left to race the report,
    // it is silently missed, and a missed array is what a virtualised list
    // looks like.
    await Promise.all(bodies)

    const html = await session.page.content()
    const browser: SideReport = {
      status: response?.status() ?? 0,
      bytes: Buffer.byteLength(html, 'utf8'),
      title: titleOf(html),
    }
    const engine: SideReport = {
      status: fetched.status,
      bytes: fetched.bytesDownloaded,
      title: titleOf(fetched.body),
    }

    const carriesBrowserTitle =
      browser.title !== null && browser.title !== '' && fetched.body.includes(browser.title)

    return {
      url,
      engine,
      browser,
      carriesBrowserTitle,
      differences: differencesBetween(engine, browser),
      renderMs,
      networkIdle,
      largestListing: (await session.page.evaluate(LARGEST_SIBLING_RUN)) as ScreenReport['largestListing'],
      largestJsonArray,
    }
  } finally {
    await session.close()
  }
}

function differencesBetween(engine: SideReport, browser: SideReport): string[] {
  const differences: string[] = []
  if (engine.title !== browser.title) differences.push('title mismatch')
  if (browser.bytes > 0 && engine.bytes < browser.bytes * SIZE_RATIO) {
    differences.push(`engine body is ${Math.round((engine.bytes / browser.bytes) * 100)}% of browser`)
  }
  return differences
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`
}

function side(name: string, s: SideReport): string {
  return `  ${name.padEnd(8)} ${String(s.status).padEnd(4)} ${kb(s.bytes).padStart(8)}  ${JSON.stringify(s.title)}`
}

export function formatScreen(r: ScreenReport): string {
  const listing = r.largestListing === null
    ? 'largest listing: none'
    : `largest listing: ${r.largestListing.count} × ${r.largestListing.signature}`

  return [
    r.url,
    side('engine', r.engine),
    side('browser', r.browser),
    `  engine body carries the browser title: ${r.carriesBrowserTitle ? 'yes' : 'no'}`,
    `  engine page differs from browser page: ${r.differences.join(', ') || 'no'}`,
    `  render: ${r.renderMs}ms${r.networkIdle ? '' : ' (networkidle not reached)'}`,
    `  ${listing}   largest json array: ${r.largestJsonArray}`,
  ].join('\n')
}
