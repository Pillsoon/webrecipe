import { tokensOf, visibleText, type ProbeSession, type ProbeObservation } from './query-honored.js'
import type { EvidenceEntry } from '../local.js'
import type { Item } from '../types.js'

/**
 * Whether the rows a search returns visibly carry the words that were searched
 * for, on the taught input and on one that was never taught.
 *
 * This exists because `query_honored` passes a site that filters on the query
 * and then attributes each hit to the wrong record: the input genuinely moves
 * the answer, which is all those probes can see. What such a site cannot do is
 * show the query's own words in what it returns.
 *
 * Named for the evidence and no wider. Passing says the extracted fields match
 * the query lexically and kept doing so for a value never taught. It does not
 * say the results are relevant, that the entities are the right ones, or that a
 * site matching on synonyms, stems or fields we cannot see is wrong — those
 * come back untested, because there is nothing here that could tell them from a
 * site that is broken.
 */

export const METHOD = 'active-probe/lexical-consistency-v1'

/**
 * Provisional. Chosen before any evidence and deliberately not fitted: tuning
 * it against six fixtures would produce a number that describes the fixtures.
 * It moves only on held-out or real-site evidence.
 */
export const LEXICAL_MATCH_THRESHOLD = 0.8

export interface Judgement {
  /** No `failed`: nothing observable here distinguishes a wrong site from an
   *  unreadable one, and guessing between them is how a working integration
   *  gets marked broken. */
  status: 'passed' | 'not_tested'
  signals: { applicable?: boolean; consistent?: boolean }
  shares: { taught?: number; contrast?: number }
  reason: string
}

/** Share of rows carrying any token of `query` in a field the plan extracts. */
export function lexicalShare(items: Item[], query: string): number | null {
  const tokens = tokensOf(query)
  if (tokens.length === 0 || items.length === 0) return null
  const hits = items.filter((item) => {
    const text = visibleText(item)
    return tokens.some((token) => text.includes(token))
  }).length
  return hits / items.length
}

export function judgeLexicalConsistency(session: ProbeSession): Judgement {
  const at = (role: ProbeObservation['role']): ProbeObservation | undefined =>
    session.observations.find((o) => o.role === role)

  const taught = at('taught')
  if (!taught || taught.items === null) {
    return { status: 'not_tested', signals: {}, shares: {}, reason: `taught probe unavailable: ${taught?.unavailable ?? 'not issued'}` }
  }

  // Stage one asks whether this check applies at all. A site that matches on a
  // description, a tag or a synonym is answering correctly and would look
  // identical to one that answers with the wrong records, so the honest report
  // is that we cannot read it.
  const taughtShare = lexicalShare(taught.items, session.taughtValue)
  if (taughtShare === null) {
    return { status: 'not_tested', signals: {}, shares: {}, reason: 'the taught query has no usable token, or returned nothing' }
  }
  const signals: Judgement['signals'] = { applicable: taughtShare >= LEXICAL_MATCH_THRESHOLD }
  const shares: Judgement['shares'] = { taught: taughtShare }
  if (!signals.applicable) {
    return {
      status: 'not_tested', signals, shares,
      reason: `only ${(taughtShare * 100).toFixed(0)}% of the taught result carries the query in a field this plan extracts, so this site does not match on text we can read`,
    }
  }

  const contrast = at('contrast')
  if (!contrast || contrast.items === null) {
    return { status: 'not_tested', signals, shares, reason: `contrast probe unavailable: ${contrast?.unavailable ?? 'no contrast token could be built'}` }
  }

  const contrastShare = lexicalShare(contrast.items, contrast.value)
  if (contrastShare === null) {
    return { status: 'not_tested', signals, shares, reason: `the contrast query "${contrast.value}" returned nothing to read` }
  }
  shares.contrast = contrastShare
  signals.consistent = contrastShare >= LEXICAL_MATCH_THRESHOLD
  if (!signals.consistent) {
    return {
      status: 'not_tested', signals, shares,
      reason: `the taught query is visible in its result but "${contrast.value}" is in only ${(contrastShare * 100).toFixed(0)}% of its own, which one site matching on two different fields would also look like`,
    }
  }

  return { status: 'passed', signals, shares, reason: '' }
}

/** Reads the same probes `query_honored` already issued; costs no new request. */
export function verifyLexicalConsistency(session: ProbeSession): EvidenceEntry {
  const verdict = judgeLexicalConsistency(session)
  return {
    status: verdict.status,
    at: new Date().toISOString(),
    method: METHOD,
    parameter: session.parameter,
    shares: verdict.shares,
    signals: verdict.signals,
    ...(verdict.reason === '' ? {} : { reason: verdict.reason }),
  }
}
