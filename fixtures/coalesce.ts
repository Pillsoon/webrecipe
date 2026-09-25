import { startFixture, sendHtml, sendJson, sendJs, type FixtureServer } from './harness.js'
import { search, DATASET, type FixtureRecord } from './data.js'

const EDITORS = new Map(
  DATASET.map((r, i) => [r.id, i % 3 === 1 ? `editor-${i % 5}` : null] as const),
)

function withEditor(r: FixtureRecord): FixtureRecord & { editor: string | null } {
  return { ...r, editor: EDITORS.get(r.id) ?? null }
}

const BOOT_SCRIPT = `
const params = new URLSearchParams(location.search)
const q = params.get('q') || ''
const page = params.get('page') || '1'
async function boot() {
  const res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&page=' + encodeURIComponent(page))
  const data = await res.json()
  const ul = document.createElement('ul')
  ul.id = 'results'
  for (const r of data.results) {
    const li = document.createElement('li')
    li.className = 'result'
    li.dataset.id = r.id
    const a = document.createElement('a')
    a.href = '/item/' + r.id
    a.textContent = r.title + ' by ' + (r.editor ?? r.author)
    li.appendChild(a)
    ul.appendChild(li)
  }
  document.getElementById('app').appendChild(ul)
}
boot()
`

export function startCoalesceFixture(): Promise<FixtureServer> {
  return startFixture('siteCoalesce', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    switch (true) {
      case url.pathname === '/search':
        sendHtml(res, `<!doctype html><html><head><title>Search</title>
          <script src="/app.js" defer></script></head>
          <body><header>Site Coalesce</header><div id="app"></div></body></html>`)
        return

      case url.pathname === '/app.js':
        sendJs(res, BOOT_SCRIPT)
        return

      case url.pathname === '/api/search': {
        const q = url.searchParams.get('q') ?? ''
        const page = Number(url.searchParams.get('page') ?? '1')
        sendJson(res, { query: q, page, total: DATASET.length, results: search(q, page).map(withEditor) })
        return
      }

      default:
        sendJson(res, { error: 'not found' }, 404)
    }
  })
}
