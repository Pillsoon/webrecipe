import { startFixture, sendHtml, type FixtureServer } from './harness.js'
import { page } from './ssr.js'
import { search } from './data.js'

/**
 * Answers one query and turns away every other, the way a site that serves a
 * warmed query and rate-limits the rest does.
 *
 * Keyed on the query value rather than on how many requests have arrived: the
 * probes must be turned away because of what they ask, not because of when
 * they ask it. Nothing here depends on the caller's probe order, retries or
 * concurrency.
 *
 * A site saying "not so fast" is not a site saying the query means nothing, and
 * the verdict has to keep them apart.
 */
export function startLimitingFixture(status: 429 | 503 = 429, answers = 'rust'): Promise<FixtureServer> {
  return startFixture('siteLimiting', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/search') { sendHtml(res, page('Home', '<a href="/search?q=rust">search</a>')); return }

    if ((url.searchParams.get('q') ?? '') !== answers) {
      // Retry-After only on the rate limit, which is where a site states one.
      res.writeHead(status, status === 429
        ? { 'content-type': 'text/plain', 'retry-after': '3600' }
        : { 'content-type': 'text/plain' })
      res.end(status === 429 ? 'slow down' : 'temporarily unavailable')
      return
    }

    const rows = search(answers, 1)
      .map((r) => `<li class="result" data-id="${r.id}">
        <a class="title" href="/item/${r.id}">${r.title}</a>
      </li>`)
      .join('')
    sendHtml(res, page('Search', `<ul id="results">${rows}</ul>`))
  })
}
