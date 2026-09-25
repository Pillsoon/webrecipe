import { it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, rename, access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { startFixture } from '../fixtures/harness.js'
import { ssrHandler } from '../fixtures/ssr.js'
import { teach } from '../src/authoring/teach.js'
import { fetchTask } from '../src/tasks.js'
import { createMcpServer } from '../src/mcp.js'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))

it('refuses a fetch robots.txt disallows, before any page request, browser or relearn', async () => {
  const data = await mkdtemp('/tmp/webrecipe-robots-')
  let disallow = false
  const server = await startFixture('robots', (req, res, s) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(disallow ? 'User-agent: *\nDisallow: /search\n' : 'User-agent: *\nAllow: /\n')
      return
    }
    ssrHandler(req, res, s)
  })
  const mcp = createMcpServer(data)
  const client = new Client({ name: 'test', version: '0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(a), client.connect(b)])
  const pageRequests = () => server.requestLog.filter((path) => path !== '/robots.txt')
  try {
    await teach({
      site: 'test.local', intent: 'search', url: `${server.url}/search?q=rust`, input: { query: 'rust' },
      itemSelector: 'li.result', fields: { title: 'a.title' },
      planDir: join(data, 'plans'), recipeDir: join(data, 'recipes'), skipSemanticVerification: true, minIntervalMs: 0,
    })
    disallow = true
    const before = pageRequests().length

    // Shared path, with an HTTP recipe.
    await expect(fetchTask('test.local', 'search', { query: 'go' }, { dataDir: data }))
      .rejects.toMatchObject({ cause: { code: 'ROBOTS_DISALLOWED' }, meta: { networkRequests: 1, browserLaunches: 0 } })

    // CLI: the code reaches stdout as JSON.
    const cliRun = exec(process.execPath, ['--import', loader, cli, '--data-dir', data, '--no-log', 'fetch', 'test.local/search', '--query', 'go', '--json'], { timeout: 60_000 })
    await expect(cliRun).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"code":"ROBOTS_DISALLOWED"') })

    // MCP: the code reaches the tool error.
    const tool = await client.callTool({ name: 'fetch', arguments: { site: 'test.local', intent: 'search', query: 'go' } })
    expect(tool.isError).toBe(true)
    expect((tool.content as Array<{ text: string }>)[0]!.text).toMatch(/^ROBOTS_DISALLOWED:/)

    // No HTTP recipe: the browser path is refused the same way.
    await rm(join(data, 'recipes'), { recursive: true, force: true })
    await expect(fetchTask('test.local', 'search', { query: 'go' }, { dataDir: data }))
      .rejects.toMatchObject({ cause: { code: 'ROBOTS_DISALLOWED' }, meta: { networkRequests: 1, browserLaunches: 0 } })

    // Nothing but robots.txt was asked for: no body request, no browser load, no relearn.
    expect(pageRequests().length).toBe(before)
  } finally {
    await client.close(); await mcp.close(); await server.close(); await rm(data, { recursive: true, force: true })
  }
}, 120_000)

it('checks every redirect hop, on the HTTP recipe and in the browser, and still follows allowed ones', async () => {
  const data = await mkdtemp('/tmp/webrecipe-robots-redirect-')
  let redirectTo: string | null = null
  const server = await startFixture('robots-redirect', (req, res, s) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('User-agent: *\nDisallow: /private\n')
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/search' && redirectTo !== null) {
      res.writeHead(302, { location: `${redirectTo}${url.search}` }); res.end(); return
    }
    // /private and /moved serve what /search does, so a followed redirect would succeed.
    if (url.pathname === '/private' || url.pathname === '/moved') req.url = `/search${url.search}`
    ssrHandler(req, res, s)
  })
  const hits = (path: string) => server.requestLog.filter((p) => p.startsWith(path)).length
  const fetchGo = () => fetchTask('test.local', 'search', { query: 'go' }, { dataDir: data })
  try {
    await teach({
      site: 'test.local', intent: 'search', url: `${server.url}/search?q=rust`, input: { query: 'rust' },
      itemSelector: 'li.result', fields: { title: 'a.title' },
      planDir: join(data, 'plans'), recipeDir: join(data, 'recipes'), skipSemanticVerification: true, minIntervalMs: 0,
    })

    // Allowed redirect: both paths still follow it.
    redirectTo = '/moved'
    expect((await fetchGo()).outcome.meta.browserLaunches).toBe(0)
    const recipes = join(data, 'recipes'), parked = join(data, 'recipes-parked')
    await rename(recipes, parked)
    const viaBrowser = await fetchGo()
    expect(viaBrowser.outcome.items.length).toBeGreaterThan(0)
    expect(viaBrowser.outcome.fellBack).toBe(true)
    await rm(recipes, { recursive: true, force: true })
    await rename(parked, recipes)

    // Disallowed redirect, HTTP recipe: refused, no browser, no relearn.
    redirectTo = '/private'
    await expect(fetchGo()).rejects.toMatchObject({
      message: expect.stringContaining('/private'), cause: { code: 'ROBOTS_DISALLOWED' }, meta: { browserLaunches: 0 },
    })
    expect(hits('/private')).toBe(0)

    // Disallowed redirect, no HTTP recipe: the browser is refused the same way.
    await rm(recipes, { recursive: true, force: true })
    await expect(fetchGo()).rejects.toMatchObject({
      message: expect.stringContaining('/private'), cause: { code: 'ROBOTS_DISALLOWED' }, meta: { browserLaunches: 1 },
    })
    expect(hits('/private')).toBe(0)
  } finally {
    await server.close(); await rm(data, { recursive: true, force: true })
  }
}, 120_000)

it('keeps the guard through settle and extraction, and hands it to the relearning browser', async () => {
  const data = await mkdtemp('/tmp/webrecipe-robots-late-')
  let mode: 'plain' | 'script' | 'relearn' = 'plain'
  let searches = 0
  const server = await startFixture('robots-late', (req, res, s) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('User-agent: *\nDisallow: /private\n')
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/search') {
      searches++
      // The second visit is the relearning one: only it is redirected.
      if (mode === 'relearn' && searches > 1) { res.writeHead(302, { location: `/private${url.search}` }); res.end(); return }
      if (mode === 'script') {
        // Allowed page that moves to a disallowed one after it has loaded.
        const original = res.end.bind(res)
        res.end = ((chunk: unknown) => original(String(chunk ?? '').replace('</body>',
          `<script>setTimeout(() => { location.href = '/private' + location.search }, 200)</script></body>`))) as typeof res.end
      }
    }
    if (url.pathname === '/private') req.url = `/search${url.search}`
    ssrHandler(req, res, s)
  })
  const recipes = join(data, 'recipes')
  const hits = (path: string) => server.requestLog.filter((p) => p.startsWith(path)).length
  const fetchGo = () => fetchTask('test.local', 'search', { query: 'go' }, { dataDir: data })
  try {
    await teach({
      site: 'test.local', intent: 'search', url: `${server.url}/search?q=rust`, input: { query: 'rust' },
      itemSelector: 'li.result', fields: { title: 'a.title' },
      planDir: join(data, 'plans'), recipeDir: recipes, skipSemanticVerification: true, minIntervalMs: 0,
    })

    // Control: with no recipe, the guarded browser answers and the guarded recorder compiles a new recipe.
    await rm(recipes, { recursive: true, force: true })
    expect((await fetchGo()).outcome.items.length).toBeGreaterThan(0)
    await access(join(recipes, 'test.local', 'search.yaml'))

    // A navigation after DOMContentLoaded, while the items are being waited for.
    await rm(recipes, { recursive: true, force: true })
    mode = 'script'
    // Relearning off, so the refusal has to come from the fetch's own browser, not the recorder after it.
    await expect(fetchTask('test.local', 'search', { query: 'go' }, { dataDir: data, heal: false }))
      .rejects.toMatchObject({ message: expect.stringContaining('/private'), cause: { code: 'ROBOTS_DISALLOWED' } })
    await expect(fetchGo()).rejects.toMatchObject({ message: expect.stringContaining('/private'), cause: { code: 'ROBOTS_DISALLOWED' } })
    expect(hits('/private')).toBe(0)

    // The relearning visit is redirected; the fallback visit before it was not.
    mode = 'relearn'
    searches = 0
    await expect(fetchGo()).rejects.toMatchObject({ message: expect.stringContaining('/private'), cause: { code: 'ROBOTS_DISALLOWED' } })
    expect(searches).toBe(2)
    expect(hits('/private')).toBe(0)
  } finally {
    await server.close(); await rm(data, { recursive: true, force: true })
  }
}, 120_000)

it('follows a redirect the page runs into after loading, and reads the page it ends on', async () => {
  const data = await mkdtemp('/tmp/webrecipe-robots-hop-')
  let hopTo: string | null = null
  const server = await startFixture('robots-hop', (req, res, s) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('User-agent: *\nDisallow: /private\n')
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/hop') { res.writeHead(302, { location: hopTo! }); res.end(); return }
    if (url.pathname === '/search' && hopTo !== null && url.searchParams.get('q') === 'go') {
      // The page loads, then moves itself to /hop, which redirects.
      const original = res.end.bind(res)
      res.end = ((chunk: unknown) => original(String(chunk ?? '').replace('</body>',
        `<script>setTimeout(() => { location.href = '/hop' }, 200)</script></body>`))) as typeof res.end
    }
    // /moved and /private both serve a different search, so which page was read is visible in the items.
    if (url.pathname === '/moved' || url.pathname === '/private') req.url = '/search?q=rust'
    ssrHandler(req, res, s)
  })
  const hits = (path: string) => server.requestLog.filter((p) => p.startsWith(path)).length
  const fetchQuery = (query: string) => fetchTask('test.local', 'search', { query }, { dataDir: data, heal: false })
  try {
    await teach({
      site: 'test.local', intent: 'search', url: `${server.url}/search?q=rust`, input: { query: 'rust' },
      itemSelector: 'li.result', fields: { title: 'a.title' },
      planDir: join(data, 'plans'), recipeDir: join(data, 'recipes'), skipSemanticVerification: true, minIntervalMs: 0,
    })
    const rust = (await fetchQuery('rust')).outcome.items
    const go = (await fetchQuery('go')).outcome.items
    expect(go).not.toEqual(rust)
    await rm(join(data, 'recipes'), { recursive: true, force: true })

    // Allowed destination: the items are the final page's, not the page it left.
    hopTo = '/moved'
    expect((await fetchQuery('go')).outcome.items).toEqual(rust)
    expect(hits('/moved')).toBe(1)

    // Disallowed destination: refused, and never requested.
    hopTo = '/private'
    await expect(fetchQuery('go')).rejects.toMatchObject({ message: expect.stringContaining('/private'), cause: { code: 'ROBOTS_DISALLOWED' } })
    expect(hits('/private')).toBe(0)
  } finally {
    await server.close(); await rm(data, { recursive: true, force: true })
  }
}, 120_000)
