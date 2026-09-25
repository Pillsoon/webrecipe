import { startFixture, sendHtml, type FixtureHandler, type FixtureServer } from './harness.js'
import { search, byId, type FixtureRecord } from './data.js'

export function page(title: string, inner: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${inner}</body></html>`
}

function renderResults(records: FixtureRecord[], version: 'v1' | 'v2'): string {
  const cls = version === 'v1' ? 'result' : 'hit'
  const titleCls = version === 'v1' ? 'title' : 'name'
  const rows = records
    .map((r) => `<li class="${cls}" data-id="${r.id}">
        <a class="${titleCls}" href="/item/${r.id}">${r.title}</a>
        <span class="author">${r.author}</span>
      </li>`)
    .join('')
  return `<ul id="results">${rows}</ul>`
}

/**
 * Exported so a fixture that only changes who gets served — `refusing.ts` —
 * wraps this page rather than growing a second copy of it that can drift.
 */
export const ssrHandler: FixtureHandler = (req, res, server) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname === '/search') {
    const q = url.searchParams.get('q') ?? ''
    const p = Number(url.searchParams.get('page') ?? '1')
    sendHtml(res, page('Search', renderResults(search(q, p), server.version)))
    return
  }

  if (url.pathname.startsWith('/item/')) {
    const record = byId(url.pathname.slice('/item/'.length))
    if (!record) { sendHtml(res, page('Not found', '<p>not found</p>'), 404); return }
    sendHtml(res, page(record.title, `<article id="detail" data-id="${record.id}">
      <h1 class="title">${record.title}</h1>
      <span class="author">${record.author}</span>
      <p class="body">${record.body}</p>
    </article>`))
    return
  }

  sendHtml(res, page('Home', '<a href="/search?q=rust">search</a>'))
}

export function startSsrFixture(): Promise<FixtureServer> {
  return startFixture('siteA-ssr', ssrHandler)
}
