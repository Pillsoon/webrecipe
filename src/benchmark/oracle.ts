import { z } from 'zod'

/**
 * `property-based` is reserved in the spec but deliberately unimplemented, so
 * it is absent here: a task naming it fails at load rather than being quietly
 * graded as something else.
 */
export const OracleModeSchema = z.enum(['golden', 'paired-live'])
export type OracleMode = z.infer<typeof OracleModeSchema>

export const VolatilitySchema = z.enum(['low', 'medium', 'high'])
export type Volatility = z.infer<typeof VolatilitySchema>

// .strict() throughout: a misspelled key (e.g. `field` for `fields`) must fail
// at load, the same reasoning that kept `property-based` out of the mode enum
// rather than letting it fall through to a default silently.
export const OracleSpecSchema = z.object({
  mode: OracleModeSchema.optional(),
  volatility: VolatilitySchema.optional(),
  compare: z.object({
    entities: z.literal('set').optional(),
    ordering: z.enum(['ignore', 'strict']).optional(),
    /** Restricts comparison to the fields that carry meaning. */
    fields: z.array(z.string()).optional(),
  }).strict().optional(),
  /**
   * Opt-in. Declared only where a site is known to be able to ignore its own
   * search input, as arbeitnow.com does. Absent, query semantics is reported
   * as unjudged rather than as a pass.
   */
  semantics: z.object({
    input: z.string(),
    fields: z.array(z.string()),
    match: z.literal('contains-token'),
    minShare: z.number().min(0).max(1),
  }).strict().optional(),
}).strict()

export interface SemanticsRule {
  input: string
  fields: string[]
  match: 'contains-token'
  minShare: number
}

export interface OracleSpec {
  mode: OracleMode
  volatility: Volatility
  compare: {
    entities: 'set'
    ordering: 'ignore' | 'strict'
    fields?: string[]
  }
  semantics?: SemanticsRule
}

/** What every run before this contract effectively used. */
export const DEFAULT_ORACLE: OracleSpec = {
  mode: 'golden',
  volatility: 'low',
  compare: { entities: 'set', ordering: 'strict' },
}

/**
 * Merges field by field, so an override may name only `mode` and inherit the
 * rest. Volatility is not uniformly a property of a site: the same host serves
 * a search that rotates in minutes and a detail page that does not.
 */
export function resolveOracle(
  site: z.infer<typeof OracleSpecSchema> | undefined,
  task: z.infer<typeof OracleSpecSchema> | undefined,
): OracleSpec {
  return {
    mode: task?.mode ?? site?.mode ?? DEFAULT_ORACLE.mode,
    volatility: task?.volatility ?? site?.volatility ?? DEFAULT_ORACLE.volatility,
    compare: {
      entities: 'set',
      ordering: task?.compare?.ordering ?? site?.compare?.ordering ?? DEFAULT_ORACLE.compare.ordering,
      fields: task?.compare?.fields ?? site?.compare?.fields,
    },
    semantics: task?.semantics ?? site?.semantics,
  }
}
