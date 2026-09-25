import { openSession } from '../browser/session.js'
import type { BrowserPlan } from '../executor/strategies/browser.js'
import type { SiteResolver } from '../sites.js'
import type { Task } from '../types.js'
import type { RecordedAction, RecordedRequest, Trace } from './types.js'
import { BodyStore } from './body.js'
import { navigateAndSettle, guardPage, type NavigationGuard } from '../browser/navigate.js'

/** A DOM mutation this soon after a response is treated as caused by it. */
const DOM_SETTLE_MS = 800

/**
 * Records DOM mutations and request completions on the *page's* clock.
 *
 * Both must come from inside the page. A response event observed in Node and a
 * mutation observed in the page are recorded at different stages of the
 * pipeline, so under load their order can invert and a later request steals
 * credit for an earlier response's DOM change. Inside the page the ordering is
 * guaranteed by the event loop: the mutation callback is a microtask that runs
 * before any subsequent `await fetch(...)` resolves.
 *
 * Observes `document`, not `document.documentElement`: init scripts run at
 * document-start, where documentElement is still null and observing it throws.
 */
const PAGE_PROBE = `
window.__fwaMutations = []
new MutationObserver(() => { window.__fwaMutations.push(Date.now()) })
  .observe(document, { childList: true, subtree: true, characterData: true })

window.__fwaCompletions = []
const __fwaRecord = (raw) => {
  try {
    window.__fwaCompletions.push({ url: new URL(raw, location.href).href, at: Date.now() })
  } catch {}
}

const __fwaFetch = window.fetch
window.fetch = async function (...args) {
  const response = await __fwaFetch.apply(this, args)
  const first = args[0]
  __fwaRecord(typeof first === 'string' ? first : (first && first.url) || String(first))
  return response
}

const __fwaOpen = XMLHttpRequest.prototype.open
const __fwaSend = XMLHttpRequest.prototype.send
XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  this.__fwaUrl = url
  return __fwaOpen.call(this, method, url, ...rest)
}
XMLHttpRequest.prototype.send = function (...args) {
  this.addEventListener('loadend', () => { __fwaRecord(this.__fwaUrl) })
  return __fwaSend.apply(this, args)
}
`

interface PageCompletion {
  url: string
  at: number
}

/**
 * Replaces each request's Node-observed timestamp with the page-observed one
 * where the page saw it, so that mutations and completions share a clock.
 */
export function alignToPageClock(requests: RecordedRequest[], completions: PageCompletion[]): void {
  const unused = [...completions]

  for (const request of requests) {
    const idx = unused.findIndex((c) => c.url === request.url)
    if (idx === -1) continue
    request.at = unused[idx]!.at
    unused.splice(idx, 1)
  }
}

/**
 * Credits each DOM mutation to the single most recent response that preceded
 * it. Marking every response inside a time window instead would be useless on
 * a fast site, where a decoy landing 1ms before the real response would be
 * credited with the same mutation.
 *
 * `requests` must be in arrival order, which is how the response handler builds it.
 */
export function attributeMutations(requests: RecordedRequest[], mutations: number[]): void {
  for (const at of mutations) {
    let cause: RecordedRequest | null = null
    for (const request of requests) {
      if (request.at <= at && at - request.at <= DOM_SETTLE_MS) cause = request
    }
    if (cause) cause.domChanged = true
  }
}

/**
 * A trace owns the files its large bodies were spilled into, so a caller that
 * keeps the trace past the call must dispose of it.
 */
export async function record(plan: BrowserPlan, task: Task, sites: SiteResolver, allowed?: NavigationGuard): Promise<Trace> {
  const origin = sites.origin(task.site)
  const session = await openSession()
  const actions: RecordedAction[] = []
  const pending: RecordedRequest[] = []
  const bodyReads: Promise<unknown>[] = []
  const bodies = await BodyStore.create()

  try {
    await session.page.addInitScript(PAGE_PROBE)

    session.page.on('response', (response) => {
      const request = response.request()
      const contentType = response.headers()['content-type'] ?? null
      const entry: RecordedRequest = {
        method: request.method(),
        url: response.url(),
        resourceType: request.resourceType(),
        status: response.status(),
        contentType,
        body: null,
        bodyPath: null,
        bodySize: 0,
        truncated: false,
        postData: request.postData(),
        requestHeaders: request.headers(),
        at: Date.now(),
        afterAction: actions.length === 0 ? null : actions.length - 1,
        domChanged: false,
      }
      pending.push(entry)

      if (contentType && /json|text\/plain|text\/html/.test(contentType)) {
        bodyReads.push(
          response
            .body()
            .then(async (buf) => {
              Object.assign(entry, await bodies.put(`${entry.method} ${entry.url} ${entry.at}`, buf))
            })
            .catch(() => undefined),
        )
      }
    })

    const target = plan.url(origin, task)
    actions.push({ index: 0, type: 'navigate', value: target, at: Date.now() })
    const guard = allowed ? await guardPage(session.page, allowed) : undefined
    await navigateAndSettle(session.page, target, plan.itemSelector, guard)

    const mutations = (await session.page.evaluate('window.__fwaMutations || []')) as number[]
    const completions = (await session.page.evaluate('window.__fwaCompletions || []')) as PageCompletion[]

    // Align first: attribution compares these timestamps against each other.
    alignToPageClock(pending, completions)
    attributeMutations(pending, mutations)

    const finalHtml = await session.page.content()
    await Promise.all(bodyReads)
    guard?.check()

    return {
      site: task.site,
      intent: task.intent,
      input: task.input,
      origin,
      actions,
      requests: pending,
      finalHtml,
      ...(session.page.viewportSize() === null ? {} : { viewport: session.page.viewportSize()! }),
      cost: session.cost,
      dispose: () => bodies.dispose(),
    }
  } finally {
    await session.close()
  }
}
