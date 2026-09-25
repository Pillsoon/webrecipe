import { costSink } from '../measurement.js'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { BROWSER_USER_AGENT, observePage, type PageCost } from './session.js'

export interface WarmPage {
  page: Page
  cost: PageCost
  /** True when this call had to start the browser, which is a cost like any other. */
  launched: boolean
  release(): Promise<void>
}

/**
 * One browser process reused across tasks.
 *
 * A cold launch costs about 800ms, which on a light page is most of what a
 * browser run costs at all. Keeping the process alive separates "this task
 * needed a browser" from "this task paid to start one", which is the
 * difference between avoiding a full browser and being browser-free.
 *
 * Each task still gets a fresh context, so cookies and storage cannot leak
 * from one task into the next and make a recipe look better than it is.
 */
export class BrowserPool {
  private browser: Browser | null = null

  async acquire(): Promise<WarmPage> {
    const launched = this.browser === null
    this.browser ??= await chromium.launch({ headless: true })
    if (launched) costSink()({ browserLaunches: 1 })

    const context: BrowserContext = await this.browser.newContext({ userAgent: BROWSER_USER_AGENT })
    const page = await context.newPage()
    const { cost, drain } = observePage(page)
    return { page, cost, launched, release: async () => { await context.close(); await drain() } }
  }

  async close(): Promise<void> {
    await this.browser?.close()
    this.browser = null
  }
}
