import { describe, it, expect } from 'vitest'
import { attributeMutations, alignToPageClock } from '../../src/recorder/index.js'
import type { RecordedRequest } from '../../src/recorder/types.js'

function req(url: string, at: number): RecordedRequest {
  return {
    method: 'GET', url, resourceType: 'xhr', status: 200, contentType: 'application/json',
    body: null, bodyPath: null, bodySize: 0, truncated: false, postData: null, requestHeaders: {}, at, afterAction: 0, domChanged: false,
  }
}

describe('attributeMutations', () => {
  it('credits a mutation to the response immediately before it, not to every nearby one', () => {
    const decoy = req('https://x.test/flags', 100)
    const real = req('https://x.test/search', 101)
    attributeMutations([decoy, real], [140])
    expect(real.domChanged).toBe(true)
    expect(decoy.domChanged).toBe(false)
  })

  it('ignores a mutation that arrived before any response', () => {
    const r = req('https://x.test/a', 500)
    attributeMutations([r], [100])
    expect(r.domChanged).toBe(false)
  })

  it('ignores a mutation that arrives long after the response settled', () => {
    const r = req('https://x.test/a', 100)
    attributeMutations([r], [100 + 5000])
    expect(r.domChanged).toBe(false)
  })

  it('lets separate mutations credit separate responses', () => {
    const first = req('https://x.test/one', 100)
    const second = req('https://x.test/two', 300)
    attributeMutations([first, second], [150, 350])
    expect(first.domChanged).toBe(true)
    expect(second.domChanged).toBe(true)
  })

  it('credits a response that fires in the same millisecond as the mutation', () => {
    const r = req('https://x.test/a', 100)
    attributeMutations([r], [100])
    expect(r.domChanged).toBe(true)
  })
})

describe('alignToPageClock', () => {
  it('replaces the node timestamp with the page one for requests the page saw', () => {
    const r = req('https://x.test/a', 999)
    alignToPageClock([r], [{ url: 'https://x.test/a', at: 42 }])
    expect(r.at).toBe(42)
  })

  it('leaves a request the page never saw on its node timestamp', () => {
    const doc = req('https://x.test/page', 999)
    alignToPageClock([doc], [{ url: 'https://x.test/other', at: 42 }])
    expect(doc.at).toBe(999)
  })

  it('pairs repeated calls to the same url in order rather than reusing one', () => {
    const first = req('https://x.test/a', 900)
    const second = req('https://x.test/a', 901)
    alignToPageClock([first, second], [
      { url: 'https://x.test/a', at: 10 },
      { url: 'https://x.test/a', at: 20 },
    ])
    expect([first.at, second.at]).toEqual([10, 20])
  })

  it('makes a decoy that node saw late lose credit to the real response', () => {
    const real = req('https://x.test/search', 500)
    const decoy = req('https://x.test/recommend', 501)
    // Node saw recommend at 501, but the page saw it at 60 — after the mutation at 50.
    alignToPageClock([real, decoy], [
      { url: 'https://x.test/search', at: 47 },
      { url: 'https://x.test/recommend', at: 60 },
    ])
    attributeMutations([real, decoy], [50])
    expect(real.domChanged).toBe(true)
    expect(decoy.domChanged).toBe(false)
  })
})
