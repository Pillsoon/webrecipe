import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Intent, Item } from './types.js'

export const CheckNameSchema = z.enum(['non_empty', 'required_fields', 'query_honored', 'lexical_query_consistency', 'pagination_honored', 'entity_equivalence', 'ordering'])
export const CheckStatusSchema = z.enum(['passed', 'failed', 'not_tested', 'not_configured', 'not_applicable'])
export type CheckName = z.infer<typeof CheckNameSchema>
export type VerificationCheckStatus = z.infer<typeof CheckStatusSchema>
export type VerificationStatus = 'unverified' | 'structural' | 'partially_verified' | 'verified'
export type VerificationChecks = Record<CheckName, VerificationCheckStatus>

/** Proven by reading the result itself, on every run, without probing the site. */
const STRUCTURAL: CheckName[] = ['non_empty', 'required_fields']

/**
 * What a task must prove to be called verified, and what it has proven so far.
 *
 * The two are kept apart deliberately. A contract read off passing evidence
 * would be a test whose passing grade was written after the test, so authoring
 * declares the contract and only a verifier may write evidence.
 */
export const VerificationContractSchema = z.object({
  required: z.array(CheckNameSchema).min(1),
}).strict()
export type VerificationContract = z.infer<typeof VerificationContractSchema>

/**
 * One probe a verifier issued, kept so the run can be repeated exactly. A
 * regression that cannot reproduce its own inputs is an assertion, not a test,
 * which is why the generated nonce is stored rather than regenerated.
 */
export const ProbeRecordSchema = z.object({
  role: z.enum(['taught', 'repeat', 'contrast', 'nonce', 'alternate']),
  value: z.string(),
  /** How many items came back, or null when the probe never completed. */
  items: z.number().int().min(0).nullable(),
  unavailable: z.string().optional(),
}).strict()
export type ProbeRecord = z.infer<typeof ProbeRecordSchema>

export const EvidenceEntrySchema = z.object({
  status: CheckStatusSchema,
  /** Absent on a check nothing has run. */
  at: z.string().optional(),
  /** Which verifier produced this, so a rule change can retire old evidence. */
  method: z.string().optional(),
  parameter: z.string().optional(),
  probes: z.array(ProbeRecordSchema).optional(),
  signals: z.object({
    stable: z.boolean(),
    responsive: z.boolean(),
    nonce_rejected: z.boolean(),
    agreed: z.boolean(),
    applicable: z.boolean(),
    consistent: z.boolean(),
    moved: z.boolean(),
  }).partial().strict().optional(),
  /** Measured proportions behind a signal, kept so a threshold change can be re-judged. */
  shares: z.object({
    taught: z.number().min(0).max(1),
    contrast: z.number().min(0).max(1),
    /** Rows an alternate page repeats from the taught one. Recorded, never gated:
     *  a pinned row, a live insert and a ranking change all produce overlap. */
    overlap: z.number().min(0).max(1),
  }).partial().strict().optional(),
  /** Why the verifier stopped short of passed. */
  reason: z.string().optional(),
}).strict()
export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>

export type VerificationEvidence = Partial<Record<CheckName, EvidenceEntry>>
export const VerificationEvidenceSchema: z.ZodType<VerificationEvidence> = z.record(
  CheckNameSchema, EvidenceEntrySchema,
)

export const PlanVerificationSchema = z.object({
  contract: VerificationContractSchema,
  evidence: VerificationEvidenceSchema,
}).strict()
export type PlanVerification = z.infer<typeof PlanVerificationSchema>

export interface ReadabilityVerification {
  status: VerificationStatus
  /** Null when the task has none: what it would take to verify this is undefined. */
  contract: VerificationContract | null
  checks: VerificationChecks
}

/**
 * A summary of `checks`, which stay the source of truth.
 *
 * Without a contract there is no definition of "enough", so a semantic check
 * that happens to pass cannot lift a result above structural. A check that ran
 * and failed drops the whole result to unverified: asserting verification while
 * holding contrary evidence is the false confidence this model exists to stop.
 */
export function verificationStatus(checks: VerificationChecks, contract?: VerificationContract | null): VerificationStatus {
  if (STRUCTURAL.some(check => checks[check] !== 'passed')) return 'unverified'
  if (Object.values(checks).some(status => status === 'failed')) return 'unverified'
  if (!contract) return 'structural'
  return contract.required.every(check => checks[check] === 'passed') ? 'verified' : 'partially_verified'
}

/** Stored evidence, then what this run observed for itself. */
function resolveChecks(verification: PlanVerification | undefined, observed: Partial<VerificationChecks>): VerificationChecks {
  const checks = Object.fromEntries(CheckNameSchema.options.map(name => [name, 'not_configured'])) as VerificationChecks
  for (const name of CheckNameSchema.options) {
    const stored = verification?.evidence[name]
    if (stored) checks[name] = stored.status
  }
  // Required with nothing recorded means nobody has run it, which is not the
  // same as nobody having asked for it.
  for (const name of verification?.contract.required ?? []) {
    if (checks[name] === 'not_configured') checks[name] = 'not_tested'
  }
  return { ...checks, ...observed }
}

/** What the result still cannot claim, in the words a caller should repeat. */
export function verificationWarnings(verification: ReadabilityVerification): string[] {
  if (!verification.contract) return ['no verification contract is stored for this task; only structural validity was checked']
  const unproven = verification.contract.required.filter(check => verification.checks[check] !== 'passed')
  return unproven.length === 0 ? [] : [`required by this task's verification contract but not proven: ${unproven.join(', ')}`]
}

export class UserError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export function siteName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new UserError('INVALID_INPUT', 'site must be a name such as news.ycombinator.com, not a URL or path')
  return value
}
export function intentName(value: string): Intent {
  if (!['search', 'list', 'detail'].includes(value)) throw new UserError('INVALID_INPUT', 'intent must be search, list or detail')
  return value as Intent
}
export function publicUrl(value: string): URL {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new UserError('INVALID_INPUT', 'use an http(s) URL without embedded credentials')
  return url
}
export function localPaths(dir?: string) {
  const root = resolve(dir ?? process.env.WEBRECIPE_DATA_DIR ?? join(homedir(), '.webrecipe'))
  return { root, plans: join(root, 'plans'), recipes: join(root, 'recipes') }
}

/** A missing listing is ambiguous: never report it as a verified empty search. */
/** Readability is evidence of extraction, not proof of query semantics. */
export function verifyReadable(items: Item[], fields: string[], verification?: PlanVerification): ReadabilityVerification {
  if (items.length === 0) throw new UserError('UNVERIFIED_RESULT', 'No readable items. This may be an empty result, changed page, or access block. Inspect the page and save again; do not treat this as a confirmed empty result.')
  const missing = fields.filter(field => items.some(item => item[field] === null || item[field] === undefined || item[field] === ''))
  if (missing.length) throw new UserError('UNVERIFIED_RESULT', `Selected fields are missing: ${missing.join(', ')}. Inspect the page and save again.`)
  const checks = resolveChecks(verification, { non_empty: 'passed', required_fields: 'passed' })
  return { status: verificationStatus(checks, verification?.contract), contract: verification?.contract ?? null, checks }
}

export function requireReadable(items: Item[], fields: string[]): void {
  verifyReadable(items, fields)
}

export async function atomicWrite(path: string, body: string): Promise<void> {
  const { dirname } = await import('node:path')
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try { await writeFile(temp, body, { mode: 0o600 }); await rename(temp, path) }
  finally { await rm(temp, { force: true }) }
}
