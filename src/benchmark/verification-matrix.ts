import type { CheckName } from '../local.js'
import type { Item } from '../types.js'

/**
 * What the production verifier said, beside what an independent oracle says the
 * answer actually was.
 *
 * The two judgements are produced from different inputs on purpose. The
 * verifier reads probes it issued; the oracle reads the returned items against
 * a rule written by hand from what the fixture's data contains. Nothing here
 * may pass the verifier's evidence, contract or status into the oracle: a
 * system that grades itself cannot report a false success, because the wrong
 * answer and the grade agreeing is precisely what a false success is.
 */

export type VerifierVerdict = 'passed' | 'failed' | 'not_tested'

export interface CaseOutcome {
  id: string
  /** What each semantic check concluded, so a layer can be scored on its own. */
  checks: Partial<Record<CheckName, VerifierVerdict>>
  /** Whether the answer was right. Null when the oracle could not judge. */
  oracleMatch: boolean | null
  /**
   * Whether non_empty and required_fields alone would have called this a
   * success — the bar before any semantic check existed.
   */
  structuralSuccess: boolean
  /** Why each check stopped short, when it did. */
  reasons?: Partial<Record<CheckName, string>>
  /** Why the oracle called the answer wrong, when it did. */
  oracleReason?: string
}

/**
 * What a contract requiring exactly these checks would conclude.
 *
 * Scoring a layer means asking this with a shorter list, which is how adding a
 * check can be read as a change rather than as a new number with no ancestor.
 */
export function verdictFrom(outcome: CaseOutcome, required: CheckName[]): VerifierVerdict {
  const verdicts = required.map((check) => outcome.checks[check] ?? 'not_tested')
  if (verdicts.includes('failed')) return 'failed'
  return verdicts.every((v) => v === 'passed') ? 'passed' : 'not_tested'
}

export interface Matrix {
  cases: number
  judged: number
  passed: number
  failed: number
  notTested: number
  oracleCorrect: number
  oracleWrong: number
  oracleUnjudged: number
  /** verifier passed, oracle correct. */
  verifiedCorrect: number
  /** verifier passed, oracle wrong. The one this whole model exists to count. */
  falseSuccess: number
  /** verifier withheld, oracle correct: coverage given up to stay safe. */
  abstainedCorrect: number
  /** verifier withheld, oracle wrong: a wrong answer that was not blessed. */
  rejectedWrong: number
  structuralSuccess: number
  structuralFalseSuccess: number
}

export function tabulate(outcomes: CaseOutcome[], required: CheckName[]): Matrix {
  const verdict = (o: CaseOutcome): VerifierVerdict => verdictFrom(o, required)
  const judged = outcomes.filter((o) => o.oracleMatch !== null)
  const passed = outcomes.filter((o) => verdict(o) === 'passed')
  const withheld = judged.filter((o) => verdict(o) !== 'passed')

  return {
    cases: outcomes.length,
    judged: judged.length,
    passed: passed.length,
    failed: outcomes.filter((o) => verdict(o) === 'failed').length,
    notTested: outcomes.filter((o) => verdict(o) === 'not_tested').length,
    oracleCorrect: judged.filter((o) => o.oracleMatch === true).length,
    oracleWrong: judged.filter((o) => o.oracleMatch === false).length,
    oracleUnjudged: outcomes.length - judged.length,
    verifiedCorrect: passed.filter((o) => o.oracleMatch === true).length,
    falseSuccess: passed.filter((o) => o.oracleMatch === false).length,
    abstainedCorrect: withheld.filter((o) => o.oracleMatch === true).length,
    rejectedWrong: withheld.filter((o) => o.oracleMatch === false).length,
    structuralSuccess: outcomes.filter((o) => o.structuralSuccess).length,
    structuralFalseSuccess: judged.filter((o) => o.structuralSuccess && o.oracleMatch === false).length,
  }
}

/** Null rather than 0 when the denominator is empty: no cases is not a score of zero. */
export function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

const pct = (value: number | null): string => value === null ? 'n/a (no cases)' : `${(value * 100).toFixed(1)}%`

/** Every rate prints its own denominator, so no name has to be guessed at. */
export function formatMatrix(m: Matrix, label: string): string {
  return [
    `${label}:`,
    `  passed:           ${m.passed}/${m.cases}`,
    `  failed:           ${m.failed}/${m.cases}`,
    `  not_tested:       ${m.notTested}/${m.cases}`,
    `  false success:    ${m.falseSuccess}/${m.judged} oracle-judged cases  (${pct(ratio(m.falseSuccess, m.judged))})`,
    `  precision:        ${m.verifiedCorrect}/${m.passed} passed cases were correct  (${pct(ratio(m.verifiedCorrect, m.passed))})`,
    `  correct coverage: ${m.verifiedCorrect}/${m.oracleCorrect} correct answers were verified  (${pct(ratio(m.verifiedCorrect, m.oracleCorrect))})`,
  ].join('\n')
}

export interface Layer {
  label: string
  required: CheckName[]
}

/**
 * One layer per check the contract has gained, so adding a check reads as a
 * change to two numbers that move in opposite directions: how many wrong
 * answers stopped being blessed, and how many right ones stopped being
 * verified.
 */
export function formatLayers(outcomes: CaseOutcome[], layers: Layer[]): string {
  const structural = tabulate(outcomes, [])
  const lines: string[] = []
  lines.push(`cases: ${structural.cases}${structural.oracleUnjudged > 0 ? ` (${structural.oracleUnjudged} the oracle could not judge)` : ''}`)
  lines.push('')
  lines.push('structural-only (non_empty + required_fields):')
  lines.push(`  called success:   ${structural.structuralSuccess}/${structural.cases}`)
  lines.push(`  false success:    ${structural.structuralFalseSuccess}/${structural.judged} oracle-judged cases  (${pct(ratio(structural.structuralFalseSuccess, structural.judged))})`)

  for (const layer of layers) {
    lines.push('')
    lines.push(formatMatrix(tabulate(outcomes, layer.required), layer.label))
  }

  const last = tabulate(outcomes, layers[layers.length - 1]?.required ?? [])
  lines.push('')
  lines.push(`quadrants at "${layers[layers.length - 1]?.label ?? 'structural'}" (oracle-judged cases only):`)
  lines.push(`  verified_correct:   ${last.verifiedCorrect}`)
  lines.push(`  false_success:      ${last.falseSuccess}`)
  lines.push(`  abstained_correct:  ${last.abstainedCorrect}`)
  lines.push(`  rejected_wrong:     ${last.rejectedWrong}`)
  lines.push('')
  lines.push('per case:')
  const width = Math.max(...outcomes.map((o) => o.id.length))
  for (const o of outcomes) {
    const oracle = o.oracleMatch === null ? 'unjudged' : o.oracleMatch ? 'correct' : 'wrong'
    const verdicts = layers.map((l) => `${l.label}=${verdictFrom(o, l.required)}`).join('  ')
    const flag = verdictFrom(o, layers[layers.length - 1]?.required ?? []) === 'passed' && o.oracleMatch === false
      ? '  <- FALSE SUCCESS' : ''
    lines.push(`  ${o.id.padEnd(width)}  oracle=${oracle.padEnd(8)} ${verdicts}${flag}`)
  }
  return lines.join('\n')
}

/** The structural bar, kept here so the baseline cannot drift from what it claims to be. */
export function structurallySuccessful(items: Item[], fields: string[]): boolean {
  if (items.length === 0) return false
  return !fields.some((field) => items.some((item) => {
    const value = item[field]
    return value === null || value === undefined || value === ''
  }))
}
