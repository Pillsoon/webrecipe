import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BodyStore, readBody } from '../../src/recorder/body.js'
import type { RecordedRequest } from '../../src/recorder/types.js'

const stores: BodyStore[] = []
afterEach(async () => { await Promise.all(stores.splice(0).map((s) => s.dispose())) })

async function store(): Promise<BodyStore> {
  const s = await BodyStore.create()
  stores.push(s)
  return s
}

function req(over: Partial<RecordedRequest> = {}): RecordedRequest {
  return {
    method: 'GET', url: 'https://x.test/a', resourceType: 'xhr', status: 200,
    contentType: 'application/json', body: null, bodyPath: null, bodySize: 0,
    truncated: false, postData: null, requestHeaders: {},
    at: 0, afterAction: 0, domChanged: false, ...over,
  }
}

describe('BodyStore', () => {
  it('keeps a small body inline', async () => {
    const s = await store()
    const entry = await s.put('req1', Buffer.from('hello'))
    expect(entry.body).toBe('hello')
    expect(entry.bodyPath).toBeNull()
    expect(entry.bodySize).toBe(5)
  })

  it('spills a large body to a file instead of dropping it', async () => {
    const s = await store()
    const big = Buffer.from('x'.repeat(700 * 1024))
    const entry = await s.put('req2', big)

    expect(entry.body).toBeNull()
    expect(entry.bodyPath).not.toBeNull()
    expect(entry.bodySize).toBe(big.byteLength)
    expect(entry.truncated).toBe(false)
    expect((await readFile(entry.bodyPath!, 'utf8')).length).toBe(big.byteLength)
  })

  it('reads a spilled body back through readBody', async () => {
    const s = await store()
    const text = 'y'.repeat(700 * 1024)
    const entry = await s.put('req3', Buffer.from(text))
    expect(readBody(req(entry))).toBe(text)
  })

  it('reads an inline body back through readBody', async () => {
    const s = await store()
    const entry = await s.put('req4', Buffer.from('small'))
    expect(readBody(req(entry))).toBe('small')
  })

  it('returns null from readBody when nothing was captured', () => {
    expect(readBody(req())).toBeNull()
  })

  it('records the true size even when a body exceeds the safety cap', async () => {
    const s = await store()
    const entry = await s.put('req5', Buffer.alloc(40), 16)
    expect(entry.truncated).toBe(true)
    expect(entry.bodySize).toBe(40)
    expect(entry.body).toBeNull()
    expect(entry.bodyPath).toBeNull()
  })

  it('removes its files on dispose', async () => {
    const s = await BodyStore.create()
    const entry = await s.put('req6', Buffer.from('z'.repeat(700 * 1024)))
    await s.dispose()
    await expect(readFile(entry.bodyPath!, 'utf8')).rejects.toThrow()
  })
})

describe('readBody on a trace loaded from disk', () => {
  it('still resolves a spilled body after the trace round-trips through JSON', async () => {
    const s = await store()
    const text = 'w'.repeat(700 * 1024)
    const entry = await s.put('req7', Buffer.from(text))

    const dir = await mkdtemp(join(tmpdir(), 'fwa-trace-'))
    try {
      const revived = JSON.parse(JSON.stringify(req(entry))) as RecordedRequest
      expect(readBody(revived)).toBe(text)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
