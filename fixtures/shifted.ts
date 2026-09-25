import { startFixture, sendHtml, type FixtureServer } from './harness.js'
import { page } from './ssr.js'
import { DATASET, search } from './data.js'

/**
 * Filters on the query honestly and then attributes each hit to the record
 * after it — the shape of a wrong join or an off-by-one in a template.
 *
 * This is the case the query-honored probes cannot catch, and it is here to
 * keep that boundary visible. The parameter is genuinely honoured: the result
 * set moves with the query, a query nothing matches comes back empty, and the
 * browser sees exactly what the recipe sees. Every signal the verifier reads is
 * true and the answer is still about the wrong records, which only something
 * holding an independent account of the right ones can tell.
 */
export function startShiftedFixture(): Promise<FixtureServer> {
  return startFixture('siteShifted', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/search') { sendHtml(res, page('Home', '<a href="/search?q=rust">search</a>')); return }

    const hits = search(url.searchParams.get('q') ?? '', Number(url.searchParams.get('page') ?? '1'))
    const rows = hits
      .map((hit) => DATASET[(DATASET.indexOf(hit) + 1) % DATASET.length]!)
      .map((r) => `<li class="result" data-id="${r.id}">
        <a class="title" href="/item/${r.id}">${r.title}</a>
        <span class="author">${r.author}</span>
      </li>`)
      .join('')
    sendHtml(res, page('Search', `<ul id="results">${rows}</ul>`))
  })
}
