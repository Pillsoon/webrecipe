import type { PageCost } from '../browser/session.js'
import type { Intent } from '../types.js'

export interface RecordedAction {
  index: number
  type: 'navigate' | 'fill' | 'click'
  selector?: string
  value?: string
  at: number
}

export interface RecordedRequest {
  method: string
  url: string
  resourceType: string
  status: number | null
  contentType: string | null
  /** Response body, inline when small enough; otherwise see bodyPath. */
  body: string | null
  /** File holding the body when it was too large to inline. */
  bodyPath: string | null
  /** True byte length of the response body, whether inlined, spilled or dropped. */
  bodySize: number
  /** Set only when the body exceeded the safety cap and was not kept at all. */
  truncated: boolean
  /** Request body, for POSTs that carry their parameters there rather than in the URL. */
  postData: string | null
  /** Request headers, so a replay can reproduce content type and auth. */
  requestHeaders: Record<string, string>
  at: number
  /** Index into `Trace.actions` of the last action before this request. */
  afterAction: number | null
  /** Whether the DOM mutated within DOM_SETTLE_MS of this response arriving. */
  domChanged: boolean
}

export interface Trace {
  site: string
  intent: Intent
  input: Record<string, string | number>
  origin: string
  actions: RecordedAction[]
  requests: RecordedRequest[]
  finalHtml: string
  /** The size the page was rendered at. A DOM observation is only comparable
   *  against another taken at the same one, so it is read rather than assumed. */
  viewport?: { width: number; height: number }
  /** All browser resources, independently of which bodies the compiler retains. */
  cost?: PageCost
  /** Releases any files large bodies were spilled into. */
  dispose?: () => Promise<void>
}
