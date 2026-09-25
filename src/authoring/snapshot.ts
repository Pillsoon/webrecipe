import { SETTLE_MS } from '../browser/navigate.js'
import { openSession } from '../browser/session.js'

const NAVIGATION_TIMEOUT_MS = 30_000

export interface Snapshot {
  html: string
  capturedAt: string
}

/**
 * One rendered DOM, saved so that a hand-written label keeps its meaning. A
 * label attached to a live page rots when the site edits its markup, and two of
 * the sites worth labelling already refuse this machine.
 */
export async function captureDom(url: string): Promise<Snapshot> {
  const session = await openSession()
  try {
    await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
    await session.page
      .waitForLoadState('networkidle', { timeout: NAVIGATION_TIMEOUT_MS })
      .catch(() => undefined)
    await session.page.waitForTimeout(SETTLE_MS)
    return { html: await session.page.content(), capturedAt: new Date().toISOString() }
  } finally {
    await session.close()
  }
}
