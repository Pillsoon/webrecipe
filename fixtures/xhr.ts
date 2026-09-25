import { startFixture, sendHtml, sendJson, sendJs, type FixtureServer } from './harness.js'
import { search, byId, DATASET } from './data.js'

/**
 * The browser is made to issue these in order on a search:
 *   /analytics/collect, /api/feature-flags, /api/autocomplete,
 *   /api/search  <- the only one that matters,
 *   /api/recommendations, /tracking/event
 */
const BOOT_SCRIPT = `
const params = new URLSearchParams(location.search)
const q = params.get('q') || ''
const page = params.get('page') || '1'
const dataPath = window.__DATA_PATH__
async function boot() {
  await fetch('/analytics/collect')
  await fetch('/api/feature-flags')
  await fetch('/api/autocomplete?prefix=' + encodeURIComponent(q.slice(0, 2)))
  const res = await fetch(dataPath + '?q=' + encodeURIComponent(q) + '&page=' + encodeURIComponent(page))
  const data = await res.json()
  const ul = document.createElement('ul')
  ul.id = 'results'
  for (const r of data.results) {
    const li = document.createElement('li')
    li.className = 'result'
    li.dataset.id = r.id
    // The title is the link, as in any real listing: the href is composed
    // client-side from the id, so the API never carries it.
    const a = document.createElement('a')
    a.className = 'permalink'
    a.href = '/item/' + r.id
    a.textContent = r.title
    li.appendChild(a)
    ul.appendChild(li)
  }
  document.getElementById('app').appendChild(ul)
  await fetch('/api/recommendations', { method: 'POST', body: '{}' })
  await fetch('/tracking/event', { method: 'POST', body: '{}' })
}
boot()
`

const DETAIL_SCRIPT = `
const id = location.pathname.slice('/item/'.length)
fetch('/api/item?id=' + encodeURIComponent(id))
  .then((r) => r.json())
  .then((data) => {
    if (!data.result) return
    const el = document.createElement('article')
    el.id = 'detail'
    el.dataset.id = data.result.id
    el.innerHTML = '<h1 class="title"></h1><span class="author"></span>'
    el.querySelector('.title').textContent = data.result.title
    el.querySelector('.author').textContent = data.result.author
    document.getElementById('app').appendChild(el)
  })
`

export function startXhrFixture(): Promise<FixtureServer> {
  return startFixture('siteB-xhr', (req, res, server) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const v2 = server.version === 'v2'
    const dataPath = v2 ? '/api/v2/search' : '/api/search'

    switch (true) {
      case url.pathname === '/search':
        sendHtml(res, `<!doctype html><html><head><title>Search</title>
          <script>window.__DATA_PATH__=${JSON.stringify(dataPath)}</script>
          <script src="/app.js" defer></script></head>
          <body><header>Site B</header><div id="app"></div></body></html>`)
        return

      case url.pathname === '/app.js':
        sendJs(res, BOOT_SCRIPT)
        return

      case url.pathname === '/detail.js':
        sendJs(res, DETAIL_SCRIPT)
        return

      // Detail is a shell too: an XHR site renders it from /api/item, not from HTML.
      case url.pathname.startsWith('/item/'):
        sendHtml(res, `<!doctype html><html><head><title>Item</title>
          <script src="/detail.js" defer></script></head>
          <body><header>Site B</header><div id="app"></div></body></html>`)
        return

      case url.pathname === dataPath: {
        const q = url.searchParams.get('q') ?? ''
        const page = Number(url.searchParams.get('page') ?? '1')
        sendJson(res, {
          query: q,
          page,
          total: DATASET.length,
          // No url: a real API often returns the id and lets the page build the link.
          results: search(q, page).map((r) => ({ id: r.id, title: r.title, author: r.author })),
        })
        return
      }

      case url.pathname === '/api/item': {
        const record = byId(url.searchParams.get('id') ?? '')
        if (!record) { sendJson(res, { error: 'not found' }, 404); return }
        sendJson(res, { result: record })
        return
      }

      case url.pathname === '/api/feature-flags':
        sendJson(res, { flags: { newSearch: true, darkMode: false } })
        return

      case url.pathname === '/api/autocomplete': {
        const prefix = (url.searchParams.get('prefix') ?? '').toLowerCase()
        sendJson(res, { suggestions: ['rust', 'ruby', 'react'].filter((s) => s.startsWith(prefix)).slice(0, 3) })
        return
      }

      case url.pathname === '/api/recommendations':
        sendJson(res, { recommendations: DATASET.slice(0, 3).map((r) => r.id) })
        return

      case url.pathname === '/analytics/collect':
      case url.pathname === '/tracking/event':
        res.writeHead(204).end()
        return

      default:
        sendJson(res, { error: 'not found' }, 404)
    }
  })
}
