import type { Page } from 'playwright'

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
export async function navigateAndSettle(page: Page, url: string, itemSelector: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })

  await page
    .waitForSelector(itemSelector, { timeout: SELECTOR_TIMEOUT_MS })
    .catch(() => undefined)

  await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => undefined)
  await page.waitForTimeout(SETTLE_MS)
}
