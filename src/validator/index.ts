import { computeFingerprint } from '../recipes/fingerprint.js'
import type { Recipe } from '../recipes/schema.js'
import type { Item } from '../types.js'

export interface ValidationInput {
  status: number
  payload: unknown
  items: Item[]
}

export interface ValidationOutcome {
  valid: boolean
  reasons: string[]
}

export function validate(recipe: Recipe, input: ValidationInput): ValidationOutcome {
  const reasons: string[] = []

  if (input.status !== recipe.validation.status) {
    reasons.push(`status ${input.status} !== expected ${recipe.validation.status}`)
  }

  if (input.items.length < recipe.validation.minItems) {
    reasons.push(`item count ${input.items.length} < minItems ${recipe.validation.minItems}`)
  }

  // A real listing mixes in rows the selector was never meant to describe — a
  // sponsored insert among fifty jobs. Failing on any empty value made one such
  // row invalidate the whole recipe. What this check is for is a dead selector,
  // so it fires when the field is missing from most of the result.
  for (const field of recipe.validation.required) {
    const missing = input.items.filter((item) => {
      const value = item[field]
      return value === null || value === undefined || value === ''
    })
    if (missing.length > input.items.length / 2) {
      reasons.push(`required field "${field}" empty in ${missing.length}/${input.items.length} items`)
    }
  }

  const actual = computeFingerprint(recipe.fingerprint.endpoint, input.payload)
  if (actual !== recipe.fingerprint.hash) {
    reasons.push(`fingerprint drift: expected ${recipe.fingerprint.hash}, got ${actual}`)
  }

  return { valid: reasons.length === 0, reasons }
}
