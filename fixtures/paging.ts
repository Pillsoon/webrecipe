import { startFixture, sendHtml, type FixtureServer } from './harness.js'
import { isBrowser } from './refusing.js'
import { page as html } from './ssr.js'
import { search, type FixtureRecord } from './data.js'

const rows = (records: FixtureRecord[]): string =>
  records.map((r) => `<li class="result" data-id="${r.id}">
        <a class="title" href="/item/${r.id}">${r.title}</a>
      </li>`).join('')

const pageOf = (url: URL): number => Number(url.searchParams.get('page') ?? '1')
const queryOf = (url: URL): string => url.searchParams.get('q') ?? ''

/**
 * Serves page one whatever page is asked for.
 *
 * With `browserPaginates`, only the engine's HTTP client is pinned and a
 * browser still moves between pages — a recipe whose page control was never
 * wired up, which is the one thing a verifier can prove from outside. Without
 * it, nobody moves, and from outside that is indistinguishable from a site with
 * a single page: the verdict there has to be that we do not know.
 */
export function startPageIgnoringFixture(opts: { browserPaginates: boolean }): Promise<FixtureServer> {
  return startFixture('sitePageIgnoring', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/search') { sendHtml(res, html('Home', '<a href="/search?q=rust">search</a>')); return }
    const asked = opts.browserPaginates && isBrowser(req) ? pageOf(url) : 1
    sendHtml(res, html('Search', `<ul id="results">${rows(search(queryOf(url), asked))}</ul>`))
  })
}

/**
 * Paginates correctly and repeats one pinned row on every page.
 *
 * Overlap between pages is ordinary — a sponsored insert, a live posting, a
 * ranking that shifted — so a verifier that required the pages to be disjoint
 * would call this broken. It is here to keep that rule out.
 */
export function startPinnedFixture(): Promise<FixtureServer> {
  return startFixture('sitePinned', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/search') { sendHtml(res, html('Home', '<a href="/search?q=rust">search</a>')); return }
    const query = queryOf(url)
    const pinned = search(query, 1)[0]
    const here = search(query, pageOf(url))
    const shown = pinned === undefined || here.some((r) => r.id === pinned.id) ? here : [pinned, ...here]
    sendHtml(res, html('Search', `<ul id="results">${rows(shown)}</ul>`))
  })
}

/**
 * Answers one page and turns away the rest.
 *
 * Keyed on the page asked for, not on how many requests have arrived, so the
 * recording gets its page and the probe for any other is declined however the
 * probes are ordered.
 */
export function startPageLimitedFixture(status: 429 | 503 = 503, answers = 1): Promise<FixtureServer> {
  return startFixture('sitePageLimited', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/search') { sendHtml(res, html('Home', '<a href="/search?q=rust">search</a>')); return }
    if (pageOf(url) !== answers) {
      res.writeHead(status, { 'content-type': 'text/plain' })
      res.end('not now')
      return
    }
    sendHtml(res, html('Search', `<ul id="results">${rows(search(queryOf(url), answers))}</ul>`))
  })
}
