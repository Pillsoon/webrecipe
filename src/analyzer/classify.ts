import type { RecordedRequest } from '../recorder/types.js'

export type RequestClass =
  | 'asset' | 'analytics' | 'tracking' | 'data_candidate' | 'navigation' | 'unknown'

const ASSET_TYPES = new Set(['image', 'font', 'stylesheet', 'script', 'media', 'texttrack', 'manifest'])
const ANALYTICS = /analytics|googletagmanager|google-analytics|doubleclick|segment\.io|mixpanel|amplitude|hotjar|adservice|\/ads?\//i
const TRACKING = /tracking|telemetry|beacon|\/collect\b|pixel|\/event\b/i

export function classify(req: RecordedRequest): RequestClass {
  if (ANALYTICS.test(req.url)) return 'analytics'
  if (TRACKING.test(req.url)) return 'tracking'
  if (ASSET_TYPES.has(req.resourceType)) return 'asset'
  if (req.resourceType === 'document') return 'navigation'
  if (req.resourceType === 'xhr' || req.resourceType === 'fetch') return 'data_candidate'
  return 'unknown'
}
