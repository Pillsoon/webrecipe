import { startFixture, sendHtml, type FixtureServer } from './harness.js'
import { page } from './ssr.js'
import { search } from './data.js'

/**
 * Filters honestly and alternates one row between consecutive calls for the
 * same query, the way a listing that mixes in a fresh or sponsored item does.
 *
 * The alternation is counted per query, so asking twice for the same thing
 * always disagrees no matter what else has been asked, in what order, or how
 * many times. A fixture that instead counted requests would be describing the
 * caller's probe order rather than the site's behaviour, and would start
 * failing the moment that order changed.
 *
 * A site like this cannot be judged by comparing result sets: two identical
 * requests already disagree, so a difference between two different queries
 * proves nothing either.
 */
export function startVolatileFixture(): Promise<FixtureServer> {
  const turn = new Map<string, number>()
  return startFixture('siteVolatile', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/search') { sendHtml(res, page('Home', '<a href="/search?q=rust">search</a>')); return }

    const q = url.searchParams.get('q') ?? ''
    const nth = (turn.get(q) ?? 0) + 1
    turn.set(q, nth)

    const rows = search(q, Number(url.searchParams.get('page') ?? '1'))
      .map((r, i) => i === 0
        ? `<li class="result" data-id="live-${nth}">
        <a class="title" href="/item/live-${nth}">Just posted ${nth}</a>
      </li>`
        : `<li class="result" data-id="${r.id}">
        <a class="title" href="/item/${r.id}">${r.title}</a>
      </li>`)
      .join('')
    sendHtml(res, page('Search', `<ul id="results">${rows}</ul>`))
  })
}
