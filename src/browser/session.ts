import { costSink } from '../measurement.js'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

export interface PageCost {
  pageNavigations: number
  networkRequests: number
  bytesDownloaded: number
  unreadResponseBodies?: number
}

export interface BrowserSession {
  page: Page
  cost: PageCost
  close(): Promise<void>
}

export const BROWSER_USER_AGENT = 'webrecipe/0.1 (+https://github.com/Pillsoon/webrecipe)'

/**
 * A cold browser with instrumentation attached. Nothing is blocked or cached —
 * this is the baseline the whole project is measured against, so it has to pay
 * the real cost.
 */
export async function openSession(): Promise<BrowserSession> {
  const browser: Browser = await chromium.launch({ headless: true })
  costSink()({ browserLaunches: 1 })
  const context: BrowserContext = await browser.newContext({ userAgent: BROWSER_USER_AGENT })
  const page = await context.newPage()

  const { cost, drain } = observePage(page)
  return { page, cost, close: async () => { await browser.close(); await drain() } }
}

/** Count all content types; drain settled body reads after the page closes. */
export function observePage(page: Page): { cost: PageCost; drain(): Promise<void> } {
  const cost: PageCost = { pageNavigations: 0, networkRequests: 0, bytesDownloaded: 0, unreadResponseBodies: 0 }
  const charge = costSink()
  const pending = new Set<Promise<void>>()
  page.on('request', () => { cost.networkRequests += 1; charge({ networkRequests: 1 }) })
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) { cost.pageNavigations += 1; charge({ pageNavigations: 1 }) }
  })
  page.on('response', (response) => {
    // These responses have no HTTP body; Playwright may reject body() for them.
    if (response.request().method() === 'HEAD' || [204, 205, 304].includes(response.status())) return
    const read = response.body().then((buf) => {
      cost.bytesDownloaded += buf.byteLength
      charge({ bytesDownloaded: buf.byteLength })
    }).catch(() => {
      cost.unreadResponseBodies! += 1
      charge({ unreadResponseBodies: 1 })
    })
    pending.add(read)
    void read.finally(() => pending.delete(read))
  })
  return { cost, drain: async () => { await Promise.all(pending) } }
}
