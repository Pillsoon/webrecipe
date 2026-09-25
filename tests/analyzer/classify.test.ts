import { describe, it, expect } from 'vitest'
import { classify } from '../../src/analyzer/classify.js'
import type { RecordedRequest } from '../../src/recorder/types.js'

function req(over: Partial<RecordedRequest>): RecordedRequest {
  return {
    method: 'GET', url: 'https://x.test/a', resourceType: 'xhr', status: 200,
    contentType: 'application/json', body: null, bodyPath: null, bodySize: 0, truncated: false, postData: null, requestHeaders: {}, at: 0, afterAction: 0, domChanged: false, ...over,
  }
}

describe('classify', () => {
  it('calls images, fonts, stylesheets and scripts assets', () => {
    for (const resourceType of ['image', 'font', 'stylesheet', 'script', 'media']) {
      expect(classify(req({ resourceType }))).toBe('asset')
    }
  })

  it('recognises analytics and ad hosts by url', () => {
    expect(classify(req({ url: 'https://x.test/analytics/collect' }))).toBe('analytics')
    expect(classify(req({ url: 'https://www.google-analytics.com/g/collect' }))).toBe('analytics')
    expect(classify(req({ url: 'https://doubleclick.net/ad' }))).toBe('analytics')
  })

  it('recognises tracking beacons', () => {
    expect(classify(req({ url: 'https://x.test/tracking/event', method: 'POST' }))).toBe('tracking')
    expect(classify(req({ url: 'https://x.test/beacon' }))).toBe('tracking')
  })

  it('calls the top-level document a navigation', () => {
    expect(classify(req({ resourceType: 'document' }))).toBe('navigation')
  })

  it('calls any other xhr or fetch a data candidate', () => {
    expect(classify(req({ resourceType: 'xhr', url: 'https://x.test/api/search' }))).toBe('data_candidate')
    expect(classify(req({ resourceType: 'fetch', url: 'https://x.test/api/query' }))).toBe('data_candidate')
  })

  it('classifies an analytics xhr as analytics, not as a data candidate', () => {
    expect(classify(req({ resourceType: 'xhr', url: 'https://x.test/analytics/collect' }))).toBe('analytics')
  })
})
