import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/mcp.js'
import { startSsrFixture } from '../fixtures/ssr.js'

const textOf = (result: { content: unknown[] }): string => (result.content[0] as { text: string }).text

it('exposes inspect, save, fetch and list, and fails as a tool error with the CLI code', async () => {
  const data = await mkdtemp('/tmp/webrecipe-mcp-')
  const server = await startSsrFixture()
  const mcp = createMcpServer(data)
  const client = new Client({ name: 'test', version: '0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(a), client.connect(b)])
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(tools).toEqual(['fetch', 'inspect', 'list', 'save'])

    const missing = await client.callTool({ name: 'fetch', arguments: { site: 'test.local', intent: 'search', query: 'rust' } })
    expect(missing.isError).toBe(true)
    expect(textOf(missing as { content: unknown[] })).toMatch(/^NOT_TAUGHT:/)

    const inspected = JSON.parse(textOf(await client.callTool({ name: 'inspect', arguments: { url: `${server.url}/search?q=rust` } }) as { content: unknown[] }))
    expect(inspected.ok).toBe(true)
    expect(inspected.candidates.some((c: { candidate: { selector: string } }) => c.candidate.selector.includes('li.result'))).toBe(true)

    const saved = JSON.parse(textOf(await client.callTool({ name: 'save', arguments: {
      site: 'test.local', intent: 'search', url: `${server.url}/search?q=rust`, query: 'rust',
      items: 'li.result', fields: { title: 'a.title', url: 'a.title@href' },
    } }) as { content: unknown[] }))
    expect(saved.ok).toBe(true)
    expect(saved.sample.length).toBeGreaterThan(0)

    const fetched = JSON.parse(textOf(await client.callTool({ name: 'fetch', arguments: { site: 'test.local', intent: 'search', query: 'go' } }) as { content: unknown[] }))
    expect(fetched.ok).toBe(true)
    expect(fetched.items.length).toBeGreaterThan(0)
    expect(fetched.meta.browserLaunches).toBe(0)

    const listed = JSON.parse(textOf(await client.callTool({ name: 'list', arguments: {} }) as { content: unknown[] }))
    expect(listed.tasks).toEqual(['test.local/search'])

    const bad = await client.callTool({ name: 'fetch', arguments: { site: 'test.local', intent: 'search', query: 'rust', page: 2 } })
    expect(bad.isError).toBe(true)
    expect(textOf(bad as { content: unknown[] })).toMatch(/^INVALID_INPUT:/)
  } finally {
    await client.close(); await mcp.close(); await server.close(); await rm(data, { recursive: true, force: true })
  }
}, 90_000)
