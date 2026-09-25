import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startCoalesceFixture } from '../../fixtures/coalesce.js'
import { openSession } from '../../src/browser/session.js'
import { navigateAndSettle } from '../../src/browser/navigate.js'
import { extractBySelector } from '../../src/executor/extract.js'
import type { FixtureServer } from '../../fixtures/harness.js'

let server: FixtureServer
beforeAll(async () => { server = await startCoalesceFixture() })
afterAll(async () => { await server.close() })

describe('coalesce fixture', () => {
  it('serves a shell with no results in it', async () => {
    const html = await (await fetch(`${server.url}/search?q=rust`)).text()
    expect(html).toContain('id="app"')
    expect(html).not.toContain('Senior rust')
  })

  it('returns rows whose editor is set on some and null on others', async () => {
    const body = await (await fetch(`${server.url}/api/search?q=rust`)).json()
    const editors = body.results.map((r: { editor: string | null }) => r.editor)
    expect(editors.filter((e: string | null) => e !== null).length).toBeGreaterThan(0)
    expect(editors.filter((e: string | null) => e === null).length).toBeGreaterThan(0)
    // Row 0 is the unfavourable one, as it is on most of bandcamp's pages:
    // synthesis must reach `editor` from a later row or the recipe never compiles.
    expect(body.results[0].editor).toBeNull()
  })

  it('renders title by editor where editor is set and title by author where it is null', async () => {
    const rows: Array<{ id: string; title: string; author: string; editor: string | null }> =
      (await (await fetch(`${server.url}/api/search?q=rust`)).json()).results

    const session = await openSession()
    try {
      await navigateAndSettle(session.page, `${server.url}/search?q=rust`, 'li.result')
      const items = extractBySelector(await session.page.content(), 'li.result', {
        id: '@data-id', title: 'a', url: 'a@href',
      })

      expect(items).toHaveLength(rows.length)
      for (const [i, row] of rows.entries()) {
        expect(items[i]!.id).toBe(row.id)
        expect(items[i]!.url).toBe(`/item/${row.id}`)
        expect(items[i]!.title).toBe(`${row.title} by ${row.editor ?? row.author}`)
      }
      expect(items.some((_, i) => rows[i]!.editor === null)).toBe(true)
    } finally {
      await session.close()
    }
  })
})
