import { classify } from '../analyzer/classify.js'
import { scoreRequests } from '../analyzer/score.js'
import { extractHtmlItems, htmlSignature, parseHtmlFragment } from '../executor/extract.js'
import { NO_CANDIDATE, templatePath } from './heuristic.js'
import { browserItemsOf, verifyAgainstBrowser } from './verify.js'
import { computeFingerprint } from '../recipes/fingerprint.js'
import { RecipeSchema, type Recipe } from '../recipes/schema.js'
import type { BrowserPlan } from '../executor/strategies/browser.js'
import type { RecordedRequest, Trace } from '../recorder/types.js'
import { readBody } from '../recorder/body.js'
import { equivalenceRefusal, isRefused, type CompileResult, type Refused } from './types.js'

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

function isHtml(request: RecordedRequest): boolean {
  return request.contentType !== null && /text\/html/.test(request.contentType)
}

/**
 * Requests that could carry the items, best first.
 *
 * The navigation is only one candidate. A site may answer a search with an XHR
 * that returns HTML rather than JSON — remoteok.com replies to
 * `?action=get_jobs` with a bare run of table rows — and such a response is
 * reachable by neither compiler: the json one cannot parse it and this one used
 * to look at the navigation alone.
 */
function htmlCandidates(trace: Trace): RecordedRequest[] {
  const navigation = trace.requests.filter((r) => classify(r) === 'navigation' && r.status === 200)
  const xhr = scoreRequests(trace)
    .map((s) => s.request)
    .filter(isHtml)
  return [...navigation, ...xhr]
}

/**
 * Compiles a recipe that fetches HTML and reads the items out of it.
 *
 * Validity means the *raw* response already contains them. The rendered DOM is
 * not evidence: on a SPA it looks identical while the response is empty.
 */
export function compileHtmlRecipe(trace: Trace, plan: BrowserPlan): CompileResult {
  // Candidates are the navigation first, then scored XHR, so the first
  // nameable refusal is the one about the page the task actually asked for.
  let refused: string | null = null

  for (const candidate of htmlCandidates(trace)) {
    const outcome = compileFrom(trace, plan, candidate)
    if (outcome === null) continue
    if (isRefused(outcome)) {
      refused ??= outcome.refused
      continue
    }
    return outcome
  }
  return { refused: refused ?? NO_CANDIDATE }
}

/** null means this response is not an html candidate, which diagnoses nothing. */
function compileFrom(trace: Trace, plan: BrowserPlan, source: RecordedRequest): Recipe | Refused | null {
  const body = readBody(source)
  if (body === null) return null
  if (parseHtmlFragment(body)(plan.itemSelector).length === 0) {
    return { refused: "items are not in the raw html; only the rendered dom has them" }
  }

  // For a navigation, replay the URL the task asked for rather than the one the
  // server bounced it to: itch.io rewrites /games/tag-puzzle to
  // /games/genre-puzzle, and templating the target gives a recipe that is right
  // for the recorded term and a 404 for every tag that is not also a genre.
  // An XHR was issued by the page itself, so its own URL is the one to replay.
  const isNavigation = classify(source) === 'navigation'
  const requested = isNavigation
    ? trace.actions.find((a) => a.type === 'navigate')?.value ?? source.url
    : source.url

  const url = new URL(requested)
  const path = templatePath(url.pathname, trace.input)

  const query: Record<string, string> = {}
  for (const [key, value] of url.searchParams.entries()) {
    const match = Object.entries(trace.input).find(([, v]) => String(v) === value)
    query[key] = match ? `{{${match[0]}}}` : templatePath(value, trace.input)
  }

  // An empty spec means "this element's own text" and is a real field, not a hole.
  const fields = { ...plan.fields }

  const draft: Recipe = {
    site: trace.site,
    intent: trace.intent,
    inputs: Object.fromEntries(
      Object.entries(trace.input).map(([k, v]) => [k, { type: typeof v === 'number' ? 'number' : 'string' }]),
    ),
    strategy: { type: 'http-html' },
    request: {
      method: 'GET',
      ...(url.origin === trace.origin ? {} : { origin: url.origin }),
      path,
      query,
    },
    output: { type: 'html', items: { selector: plan.itemSelector, fields } },
    validation: { status: 200, required: Object.keys(fields).slice(0, 2), minItems: 1 },
    fingerprint: { endpoint: path, hash: '', responseFields: [] },
    fallback: { type: 'browser' },
  }

  // Same rule as the json compiler: an untemplated input makes this a snapshot.
  const templated = new Set<string>()
  for (const part of [path, ...Object.values(query)]) {
    for (const m of part.matchAll(PLACEHOLDER)) templated.add(m[1]!)
  }
  const required = Object.entries(trace.input).filter(([, v]) => String(v) !== '').map(([k]) => k)
  const untemplated = required.find((name) => !templated.has(name))
  if (untemplated !== undefined) return { refused: `required input "${untemplated}" not templated` }

  const items = extractHtmlItems(draft, body, source.url)
  if (!verifyAgainstBrowser(trace, plan, items).equivalent) {
    return { refused: equivalenceRefusal(items.length, browserItemsOf(trace, plan).length) }
  }

  // Fingerprint what the executor will actually see: which declared fields the
  // selectors resolve against this very response.
  const signature = htmlSignature(draft, items)
  draft.fingerprint = {
    endpoint: path,
    hash: computeFingerprint(path, signature),
    responseFields: signature.fields,
  }

  return RecipeSchema.parse(draft)
}
