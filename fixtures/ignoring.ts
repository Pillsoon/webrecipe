import { startFixture, sendHtml, type FixtureServer } from './harness.js'
import { page } from './ssr.js'
import { DATASET, PAGE_SIZE } from './data.js'

/**
 * Accepts a search parameter and discards it, the way arbeitnow.com serves its
 * unfiltered front page for every query.
 *
 * Nothing about the response says so: the status is 200, the markup is the
 * markup the plan was taught, and every field the recipe extracts is populated.
 * Only asking it a second, different question reveals the answer never moved.
 */
export function startIgnoringFixture(): Promise<FixtureServer> {
  return startFixture('siteIgnoring', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/search') { sendHtml(res, page('Home', '<a href="/search?q=rust">search</a>')); return }

    const rows = DATASET.slice(0, PAGE_SIZE)
      .map((r) => `<li class="result" data-id="${r.id}">
        <a class="title" href="/item/${r.id}">${r.title}</a>
        <span class="author">${r.author}</span>
      </li>`)
      .join('')
    sendHtml(res, page('Search', `<ul id="results">${rows}</ul>`))
  })
}
