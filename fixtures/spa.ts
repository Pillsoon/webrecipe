import { startFixture, sendHtml, sendJson, sendJs, type FixtureServer } from './harness.js'
import { search, byId } from './data.js'

const SHELL = `<!doctype html><html><head><title>Site C</title>
<script src="/bundle.js" defer></script></head><body><div id="root"></div></body></html>`

const BUNDLE = `
async function render() {
  const root = document.getElementById('root')
  root.innerHTML = ''
  const path = location.pathname
  if (path.startsWith('/item/')) {
    const res = await fetch('/api/detail?id=' + path.slice(6))
    const data = await res.json()
    const el = document.createElement('article')
    el.id = 'detail'
    el.dataset.id = data.result.id
    el.textContent = data.result.title
    root.appendChild(el)
    return
  }
  const params = new URLSearchParams(location.search)
  const q = params.get('q') || ''
  const page = params.get('page') || '1'
  const res = await fetch('/api/query?q=' + encodeURIComponent(q) + '&page=' + encodeURIComponent(page))
  const data = await res.json()
  const rows = data.results || data.items || []
  const ul = document.createElement('ul')
  ul.id = 'results'
  for (const r of rows) {
    const li = document.createElement('li')
    li.className = 'result'
    li.dataset.id = r.id
    li.textContent = r.title || r.name
    ul.appendChild(li)
  }
  root.appendChild(ul)
}
window.addEventListener('popstate', render)
render()
`

export function startSpaFixture(): Promise<FixtureServer> {
  return startFixture('siteC-spa', (req, res, server) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname === '/bundle.js') { sendJs(res, BUNDLE); return }

    if (url.pathname === '/api/query') {
      const q = url.searchParams.get('q') ?? ''
      const page = Number(url.searchParams.get('page') ?? '1')
      const rows = search(q, page)
      if (server.version === 'v2') {
        sendJson(res, { items: rows.map((r) => ({ id: r.id, name: r.title, by: r.author })) })
      } else {
        sendJson(res, { results: rows.map((r) => ({ id: r.id, title: r.title, author: r.author })) })
      }
      return
    }

    if (url.pathname === '/api/detail') {
      const record = byId(url.searchParams.get('id') ?? '')
      if (!record) { sendJson(res, { error: 'not found' }, 404); return }
      sendJson(res, { result: record })
      return
    }

    // Client-side routing: every other route gets the same shell.
    sendHtml(res, SHELL)
  })
}
