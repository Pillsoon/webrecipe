import type { Page, Route } from 'playwright'
import { UserError } from '../local.js'

const NAVIGATION_TIMEOUT_MS = 30_000
const SELECTOR_TIMEOUT_MS = 10_000
/** After the items appear, give late XHR a moment to land before reading. */
export const SETTLE_MS = 800

/**
 * Loads a page and waits for its items, without requiring the network to fall
 * silent.
 *
 * `networkidle` never arrives on a site that polls or streams analytics —
 * arbeitnow.com simply timed out — and waiting for silence is the wrong
 * condition anyway. What matters is that the items are present. The wait is for
 * the selector, with a short settle for anything still in flight, and a
 * network-idle attempt only as a best effort that is allowed to fail.
 */
export async function navigateAndSettle(page: Page, url: string, itemSelector: string, guard?: PageGuard): Promise<void> {
  if (guard) await guard.goto(url)
  else await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })

  // Waited for again while the page is still moving: the items worth reading
  // are the ones on the page it ends on, not the one it left.
  for (let moves = 0; ; moves++) {
    await page
      .waitForSelector(itemSelector, { timeout: SELECTOR_TIMEOUT_MS })
      .catch(() => undefined)

    await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => undefined)
    await page.waitForTimeout(SETTLE_MS)
    if (!guard || moves >= MAX_REDIRECTS || !(await guard.arrived())) break
  }
  guard?.check()
}

/** Whether robots.txt allows a URL. */
export type NavigationGuard = (url: string) => Promise<boolean>

export interface PageGuard {
  /** Loads a URL and every redirect after it, each hop checked. */
  goto(url: string): Promise<void>
  /**
   * Waits for any redirect being followed to load, then reports whether a
   * redirect was followed since the last call, so the items are waited for
   * again. A page moving itself without a redirect is not counted: that is the
   * browser's own navigation, waited for as it was without a guard.
   * Throws on a refusal.
   */
  arrived(): Promise<boolean>
  /** Throws if the page tried to go anywhere disallowed since the guard was set. */
  check(): void
}

const MAX_REDIRECTS = 20

/**
 * Checks every main-frame navigation of a page, for as long as the page lives.
 *
 * A route handler alone cannot check redirects: Chromium follows a redirect
 * without routing the next hop, so the disallowed page would be requested
 * before any handler saw it. Instead the handler fetches each main-frame
 * document without following redirects, stops the navigation at a redirect,
 * and starts a fresh one to the target, which passes through the check again.
 *
 * This happens for the page's whole life, not only inside `goto`: a page can
 * move itself after loading, and a redirect then has to be followed, or
 * refused, rather than dropped with the old page left to be read.
 */
export async function guardPage(page: Page, allowed: NavigationGuard): Promise<PageGuard> {
  let refused: string | null = null
  let failure: Error | null = null
  let hops = 0
  const following = new Set<Promise<void>>()
  const refusal = () => new UserError('ROBOTS_DISALLOWED', `robots.txt disallows ${refused}`)
  const check = () => {
    if (refused !== null) throw refusal()
    if (failure !== null) throw failure
  }

  const follow = (target: string) => {
    if (++hops > MAX_REDIRECTS) { failure ??= new Error('too many redirects'); return }
    const moving: Promise<void> = page.goto(target, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
      .then(() => undefined, () => undefined)
      .finally(() => { following.delete(moving) })
    following.add(moving)
  }

  await page.route('**/*', async (route: Route) => {
    try {
      const request = route.request()
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return await route.continue()
      if (!(await allowed(request.url()))) { refused ??= request.url(); return await route.abort('blockedbyclient') }
      const response = await route.fetch({ maxRedirects: 0 })
      const location = response.headers()['location']
      if (response.status() >= 300 && response.status() < 400 && location) {
        await route.abort('aborted')
        follow(new URL(location, request.url()).toString())
        return
      }
      await route.fulfill({ response })
    } catch {
      // The page closed under a pending request; there is no one left to answer.
    }
  })

  let seen = 0
  const arrived = async () => {
    while (following.size > 0) await Promise.all(following)
    check()
    const moved = hops !== seen
    seen = hops
    return moved
  }

  return {
    async goto(url) {
      // A navigation stopped at a redirect rejects; what happens next is `follow`'s, and `arrived` waits for it.
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }) }
      catch (error) { if (refused === null && hops === 0) throw error }
      await arrived()
    },
    arrived,
    check,
  }
}
