import { randomUUID } from 'node:crypto'
import { asRecords, sameSet, type Baseline, type ProbeObservation, type ProbeRole, type Probes } from './probes.js'
import type { EvidenceEntry } from '../local.js'
import type { Item } from '../types.js'

export type { ProbeObservation } from './probes.js'
export { HTTP_PROBE_BUDGET } from './probes.js'

/**
 * Whether the learned request actually honours the input we called its query.
 *
 * Deliberately narrower than "the results mean what the query asked for". What
 * these probes can establish is that changing the input changes the answer, that
 * an input nothing could match is turned away, and that a value never taught
 * produces the same answer down the HTTP path as down the browser path. A site
 * that honours its query but answers with the wrong records passes all of that,
 * so the check is named for what it proves.
 *
 * The browser side is a reference observation, not ground truth: it is a second
 * extraction of the same page and can be wrong in its own way. It is what makes
 * the benchmark's oracle, which judges this system from outside, a separate
 * thing that must stay separate.
 */

export const METHOD = 'active-probe/v1'

/** A nonce result this much smaller than the taught one counts as turned away. */
const REJECTION_RATIO = 0.5

export interface Judgement {
  status: 'passed' | 'failed' | 'not_tested'
  signals: { stable?: boolean; responsive?: boolean; nonce_rejected?: boolean; agreed?: boolean }
  reason: string
}

const WORD = /^[a-z][a-z-]{2,}$/

export function tokensOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9-]+/i).filter((t) => WORD.test(t))
}

/** Every value a plan extracts, which is all the text a check may reason about. */
export const visibleText = (item: Item): string => Object.values(item).map((v) => String(v ?? '')).join(' ').toLowerCase()

/**
 * A token the taught result carries in only a couple of its rows.
 *
 * Drawn from the site's own answer rather than a word list: a fixed vocabulary
 * fails honest sites it happens not to match and passes dishonest ones it
 * happens to match everywhere. Rare on purpose — a token in most rows would
 * come back with the same set the taught query did, and a working site would be
 * read as one that ignores its input.
 */
export function chooseContrastToken(items: Item[], taught: string): string | null {
  const excluded = new Set(tokensOf(taught))
  const rows = new Map<string, number>()
  for (const item of items) {
    const seen = new Set<string>()
    for (const value of Object.values(item)) for (const token of tokensOf(String(value ?? ''))) seen.add(token)
    for (const token of seen) rows.set(token, (rows.get(token) ?? 0) + 1)
  }

  const rare = [...rows]
    .filter(([token, count]) => count <= 2 && count < items.length && !excluded.has(token))
    // Sorted, so re-running a stored verification picks the same probe again.
    .sort(([tokenA, countA], [tokenB, countB]) => countA - countB || tokenA.localeCompare(tokenB))

  return rare[0]?.[0] ?? null
}

/**
 * Passing needs every signal; failing needs positive evidence that the input is
 * discarded. Everything ambiguous is untested, because a wrong `failed` marks a
 * working integration unverified and a wrong `passed` is the false success this
 * whole model exists to prevent.
 */
export function judge(
  observations: ProbeObservation[],
  browserContrast: Item[] | null,
): Judgement {
  const at = (role: ProbeRole): ProbeObservation | undefined => observations.find((o) => o.role === role)
  const signals: Judgement['signals'] = {}

  const taught = at('taught')
  const repeat = at('repeat')
  const contrast = at('contrast')
  const nonce = at('nonce')

  for (const [role, probe] of [['taught', taught], ['repeat', repeat], ['nonce', nonce]] as const) {
    if (!probe) return { status: 'not_tested', signals, reason: `no ${role} probe was issued` }
    if (probe.items === null) return { status: 'not_tested', signals, reason: `${role} probe unavailable: ${probe.unavailable ?? 'unknown'}` }
  }
  if (taught!.items!.length === 0) {
    return { status: 'not_tested', signals, reason: 'the taught query returned nothing to compare against' }
  }

  // Volatility first. On a site whose answer changes between two identical
  // requests, every set comparison below is meaningless in both directions.
  signals.stable = sameSet(taught!.items!, repeat!.items!)
  if (!signals.stable) {
    return { status: 'not_tested', signals, reason: 'two identical requests returned different results; set comparison cannot judge this site' }
  }

  if (sameSet(nonce!.items!, taught!.items!)) {
    signals.nonce_rejected = false
    return { status: 'failed', signals, reason: `a query nothing could match ("${nonce!.value}") returned the taught result unchanged, so the input is discarded` }
  }
  signals.nonce_rejected = nonce!.items!.length < taught!.items!.length * REJECTION_RATIO
  if (!signals.nonce_rejected) {
    return { status: 'not_tested', signals, reason: `a query nothing could match returned ${nonce!.items!.length} of ${taught!.items!.length} items, which neither honours nor discards the input` }
  }

  if (!contrast) return { status: 'not_tested', signals, reason: 'no contrast probe could be built from the taught result' }
  if (contrast.items === null) return { status: 'not_tested', signals, reason: `contrast probe unavailable: ${contrast.unavailable ?? 'unknown'}` }

  signals.responsive = !sameSet(taught!.items!, contrast.items)
  if (!signals.responsive) {
    return { status: 'not_tested', signals, reason: `a different query ("${contrast.value}") returned the same items; the contrast token may be too common to separate them` }
  }

  if (browserContrast === null) {
    return { status: 'not_tested', signals, reason: 'the browser reference observation could not be taken' }
  }
  signals.agreed = sameSet(contrast.items, browserContrast)
  if (!signals.agreed) {
    return { status: 'not_tested', signals, reason: `on an input never taught ("${contrast.value}") the recipe and the browser saw different items` }
  }

  return { status: 'passed', signals, reason: '' }
}

/** The baseline, plus the two probes only this check needs. */
export interface ProbeSession {
  parameter: string
  taughtValue: string
  observations: ProbeObservation[]
  browserContrast: Item[] | null
}

export async function runQueryProbes(
  probes: Probes, baseline: Baseline, parameter: string, nonce?: () => string,
): Promise<ProbeSession> {
  const taughtValue = String(baseline.input[parameter] ?? '')
  const at = (value: string) => ({ ...baseline.input, [parameter]: value })

  const nonceValue = (nonce ?? (() => randomUUID().replace(/-/g, '').slice(0, 12)))()
  const nonceProbe = await probes.http('nonce', nonceValue, at(nonceValue))

  const token = baseline.taught.items === null ? null : chooseContrastToken(baseline.taught.items, taughtValue)
  const contrast = token === null ? undefined : await probes.http('contrast', token, at(token))

  const observations = [baseline.taught, baseline.repeat, nonceProbe, ...(contrast ? [contrast] : [])]

  // Taken only when the cheap probes have already agreed, so a site that fails
  // on HTTP alone never costs a browser launch. Judging with no browser
  // observation yet cannot reach `passed`, which is the point: it is asked only
  // whether the probes got far enough to make the launch worth it.
  const worthBrowsing = contrast !== undefined && judge(observations, null).signals.responsive === true
  const browserContrast = worthBrowsing ? await probes.browser(at(contrast!.value)) : null

  return { parameter, taughtValue, observations, browserContrast }
}

export function verifyQueryHonored(session: ProbeSession): EvidenceEntry {
  const verdict = judge(session.observations, session.browserContrast)
  return {
    status: verdict.status,
    at: new Date().toISOString(),
    method: METHOD,
    parameter: session.parameter,
    probes: asRecords(session.observations),
    signals: verdict.signals,
    ...(verdict.reason === '' ? {} : { reason: verdict.reason }),
  }
}
