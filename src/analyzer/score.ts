import { classify } from './classify.js'
import type { RecordedRequest, Trace } from '../recorder/types.js'

export interface ScoredRequest {
  request: RecordedRequest
  score: number
  signals: string[]
}

const LARGE_PAYLOAD_BYTES = 1024

function isJson(req: RecordedRequest): boolean {
  return req.contentType !== null && /json/.test(req.contentType)
}

function containsInput(req: RecordedRequest, input: Record<string, string | number>): boolean {
  const values = Object.values(input).map((v) => String(v)).filter((v) => v.length >= 2)
  if (values.length === 0) return false
  const haystack = decodeURIComponent(req.url) + (req.postData ?? '')
  return values.some((v) => haystack.toLowerCase().includes(v.toLowerCase()))
}

/**
 * The scoring table is the whole model. It is deliberately small and legible so
 * that a wrong pick can be explained by reading the signals, not by guessing.
 */
export function scoreRequests(trace: Trace): ScoredRequest[] {
  const scored: ScoredRequest[] = []

  for (const request of trace.requests) {
    if (classify(request) !== 'data_candidate') continue
    if (request.status !== 200) continue

    const signals: string[] = []
    let score = 0

    if (isJson(request)) { score += 3; signals.push('json-response') }
    if (containsInput(request, trace.input)) { score += 3; signals.push('contains-input') }
    if (request.afterAction !== null) { score += 2; signals.push('after-action') }
    if (request.domChanged) { score += 2; signals.push('dom-changed') }
    if (request.bodySize > LARGE_PAYLOAD_BYTES) { score += 1; signals.push('large-payload') }

    scored.push({ request, score, signals })
  }

  return scored.sort((a, b) => b.score - a.score)
}

export function pickDataRequest(trace: Trace): ScoredRequest | null {
  return scoreRequests(trace)[0] ?? null
}
