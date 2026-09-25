import { describe, it, expect } from 'vitest'
import { emptyMeta } from '../src/types.js'

describe('emptyMeta', () => {
  it('starts every counter at zero and records the strategy', () => {
    const meta = emptyMeta('http-json')
    expect(meta).toEqual({
      strategy: 'http-json',
      latencyMs: 0,
      browserLaunches: 0,
      pageNavigations: 0,
      networkRequests: 0,
      bytesDownloaded: 0,
      llmTokens: 0,
      politenessWaitMs: 0,
    })
  })
})
