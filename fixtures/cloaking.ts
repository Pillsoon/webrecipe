import { startFixture, sendHtml, type FixtureServer } from './harness.js'
import { isBrowser } from './refusing.js'
import { page } from './ssr.js'
import { DATASET, search } from './data.js'

/**
 * Filters honestly for everyone and answers the engine's own client with a
 * neighbouring record, the way a site that serves non-browser clients a
 * different rendering does.
 *
 * Split on client hints, which a browser sends and `fetch` does not — the same
 * discriminator `refusing.ts` already uses, and a real difference between the
 * two transports rather than a count of how many requests have arrived.
 *
 * Everything the probes can see from HTTP alone holds: the answer moves with
 * the query, it is the same twice running, and a query nothing matches comes
 * back empty. Only asking the browser the same untaught question shows the two
 * paths do not agree, which is the one signal this fixture exists to fail.
 */
export function startCloakingFixture(): Promise<FixtureServer> {
  return startFixture('siteCloaking', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/search') { sendHtml(res, page('Home', '<a href="/search?q=rust">search</a>')); return }

    const hits = search(url.searchParams.get('q') ?? '', Number(url.searchParams.get('page') ?? '1'))
    const shown = isBrowser(req)
      ? hits
      : hits.map((hit) => DATASET[(DATASET.indexOf(hit) + 1) % DATASET.length]!)

    const rows = shown
      .map((r) => `<li class="result" data-id="${r.id}">
        <a class="title" href="/item/${r.id}">${r.title}</a>
      </li>`)
      .join('')
    sendHtml(res, page('Search', `<ul id="results">${rows}</ul>`))
  })
}
