import { asRecords, overlapShare, sameSet, type Baseline, type ProbeObservation, type Probes } from './probes.js'
import type { EvidenceEntry } from '../local.js'
import type { Item } from '../types.js'

/**
 * Whether changing the page input actually selects a different window, and
 * whether the recipe selects the same window the page itself does.
 *
 * Narrower than pagination being correct. Nothing here shows that every record
 * can be reached, that none is served twice, that ordering holds across the
 * boundary, or that the last page is where the site says it is. Those are
 * separate questions and would need separate evidence.
 *
 * Required exactly when the plan templates `page`, which is an authoring act
 * rather than a property of the site: templating it makes `run --page N` a
 * supported operation, and a task is asked to be right about what it supports.
 */

export const METHOD = 'active-probe/pagination-v1'

export interface Judgement {
  status: 'passed' | 'failed' | 'not_tested'
  signals: { stable?: boolean; moved?: boolean; agreed?: boolean }
  shares: { overlap?: number }
  reason: string
}

/**
 * A neighbour that probably exists, rather than the one after.
 *
 * Probing page + 1 from a task taught on the last page would come back empty
 * and give up on a site that paginates perfectly well. What has to be shown is
 * that changing the input selects a different window, and the page before does
 * that as well as the page after.
 */
export function alternatePage(taught: number): number {
  return taught <= 1 ? 2 : taught - 1
}

export interface PaginationSession {
  parameter: string
  taughtPage: number
  alternatePage: number
  observations: ProbeObservation[]
  browserTaught: Item[] | null
  browserAlternate: Item[] | null
}

export function judgePagination(session: PaginationSession): Judgement {
  const at = (role: ProbeObservation['role']): ProbeObservation | undefined =>
    session.observations.find((o) => o.role === role)

  const taught = at('taught')
  const repeat = at('repeat')
  const alternate = at('alternate')
  const signals: Judgement['signals'] = {}
  const shares: Judgement['shares'] = {}

  for (const [role, probe] of [['taught', taught], ['repeat', repeat]] as const) {
    if (!probe) return { status: 'not_tested', signals, shares, reason: `no ${role} probe was issued` }
    if (probe.items === null) return { status: 'not_tested', signals, shares, reason: `${role} probe unavailable: ${probe.unavailable ?? 'unknown'}` }
  }
  if (taught!.items!.length === 0) {
    return { status: 'not_tested', signals, shares, reason: 'the taught page returned nothing to compare against' }
  }

  // Volatility first: on a site whose answer changes between two identical
  // requests, comparing one page against another proves nothing either way.
  signals.stable = sameSet(taught!.items!, repeat!.items!)
  if (!signals.stable) {
    return { status: 'not_tested', signals, shares, reason: 'two identical requests returned different results; one page cannot be compared against another here' }
  }

  if (!alternate) return { status: 'not_tested', signals, shares, reason: 'no alternate page probe was issued' }
  if (alternate.items === null) {
    return { status: 'not_tested', signals, shares, reason: `alternate page probe unavailable: ${alternate.unavailable ?? 'unknown'}` }
  }

  // An empty neighbour is what a real last page looks like. Never a failure.
  if (alternate.items.length === 0) {
    return { status: 'not_tested', signals, shares, reason: `page ${session.alternatePage} came back empty, which a last page also does` }
  }

  shares.overlap = overlapShare(taught!.items!, alternate.items)
  signals.moved = !sameSet(taught!.items!, alternate.items)

  if (!signals.moved) {
    // The recipe returned the taught page again. That is a broken page control
    // only if the page itself moves; if the browser sees the same rows too,
    // this is a site that clamps or ignores the parameter for everyone, and
    // from outside that is indistinguishable from a site with one page.
    if (session.browserTaught === null || session.browserAlternate === null) {
      return { status: 'not_tested', signals, shares, reason: `page ${session.alternatePage} returned the taught page again, and no browser reference was available to say whether the page itself moves` }
    }
    if (sameSet(session.browserTaught, session.browserAlternate)) {
      return { status: 'not_tested', signals, shares, reason: `page ${session.alternatePage} returned the taught page again in the browser as well, so this site either clamps the page or has only one` }
    }
    return { status: 'failed', signals, shares, reason: `page ${session.alternatePage} returned the taught page again while the browser moved to a different one, so the recipe's page control does nothing` }
  }

  if (session.browserAlternate === null) {
    return { status: 'not_tested', signals, shares, reason: 'the browser reference observation could not be taken' }
  }
  signals.agreed = sameSet(alternate.items, session.browserAlternate)
  if (!signals.agreed) {
    return { status: 'not_tested', signals, shares, reason: `on page ${session.alternatePage}, an input never taught, the recipe and the browser saw different items` }
  }

  return { status: 'passed', signals, shares, reason: '' }
}

export async function runPaginationProbes(
  probes: Probes, baseline: Baseline, parameter = 'page',
): Promise<PaginationSession> {
  const taughtPage = Number(baseline.input[parameter] ?? 1)
  const other = alternatePage(taughtPage)
  const alternate = await probes.http('alternate', String(other), { ...baseline.input, [parameter]: other })

  // The baseline was labelled with whichever input the first check varied, so
  // relabel it here; evidence naming a query where it means a page is evidence
  // nobody can read.
  const atTaughtPage = (o: ProbeObservation): ProbeObservation => ({ ...o, value: String(taughtPage) })
  const observations = [atTaughtPage(baseline.taught), atTaughtPage(baseline.repeat), alternate]

  // Both branches of the verdict need it, and neither an empty neighbour nor a
  // declined probe does, so the launch waits until it can change the answer.
  const worthBrowsing = alternate.items !== null && alternate.items.length > 0
    && baseline.taught.items !== null && baseline.taught.items.length > 0
  const browserAlternate = worthBrowsing ? await probes.browser({ ...baseline.input, [parameter]: other }) : null

  return { parameter, taughtPage, alternatePage: other, observations, browserTaught: baseline.browserTaught, browserAlternate }
}

export function verifyPaginationHonored(session: PaginationSession): EvidenceEntry {
  const verdict = judgePagination(session)
  return {
    status: verdict.status,
    at: new Date().toISOString(),
    method: METHOD,
    parameter: session.parameter,
    probes: asRecords(session.observations),
    signals: verdict.signals,
    ...(verdict.shares.overlap === undefined ? {} : { shares: verdict.shares }),
    ...(verdict.reason === '' ? {} : { reason: verdict.reason }),
  }
}
