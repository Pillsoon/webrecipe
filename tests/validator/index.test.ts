import { describe, it, expect } from 'vitest'
import { validate } from '../../src/validator/index.js'
import { computeFingerprint } from '../../src/recipes/fingerprint.js'
import type { Recipe } from '../../src/recipes/schema.js'

const payload = { results: [{ id: '1', title: 'a' }, { id: '2', title: 'b' }] }

const recipe: Recipe = {
  site: 'siteB', intent: 'search',
  inputs: { query: { type: 'string' } },
  strategy: { type: 'http-json' },
  request: { method: 'GET', path: '/api/search', query: { q: '{{query}}' } },
  output: { type: 'json', items: { path: '$.results', fields: { id: '$.id', title: '$.title' } } },
  validation: { status: 200, required: ['id', 'title'], minItems: 2 },
  fingerprint: {
    endpoint: '/api/search',
    hash: computeFingerprint('/api/search', payload),
    responseFields: ['results', 'results[]', 'results[].id', 'results[].title'],
  },
  fallback: { type: 'browser' },
}

const goodItems = [{ id: '1', title: 'a' }, { id: '2', title: 'b' }]

describe('validate', () => {
  it('passes a healthy response', () => {
    expect(validate(recipe, { status: 200, payload, items: goodItems }))
      .toEqual({ valid: true, reasons: [] })
  })

  it('fails on the wrong status', () => {
    const out = validate(recipe, { status: 500, payload, items: goodItems })
    expect(out.valid).toBe(false)
    expect(out.reasons.join()).toMatch(/status/)
  })

  it('fails when there are fewer items than minItems', () => {
    const out = validate(recipe, { status: 200, payload, items: [goodItems[0]!] })
    expect(out.reasons.join()).toMatch(/minItems|item count/i)
  })

  it('fails when a required field is null throughout', () => {
    const out = validate(recipe, { status: 200, payload, items: [{ id: '1', title: null }, { id: '2', title: null }] })
    expect(out.reasons.join()).toMatch(/title/)
  })

  it('fails when a required field is an empty string throughout', () => {
    const out = validate(recipe, { status: 200, payload, items: [{ id: '1', title: '' }, { id: '2', title: '' }] })
    expect(out.reasons.join()).toMatch(/title/)
  })

  it('fails when the response schema has drifted, even though everything else looks fine', () => {
    const drifted = { items: [{ id: '1', name: 'a' }, { id: '2', name: 'b' }] }
    const out = validate(recipe, { status: 200, payload: drifted, items: goodItems })
    expect(out.valid).toBe(false)
    expect(out.reasons.join()).toMatch(/fingerprint/i)
  })

  it('collects every failure rather than stopping at the first', () => {
    const out = validate(recipe, { status: 404, payload: {}, items: [] })
    expect(out.reasons.length).toBeGreaterThanOrEqual(3)
  })
})

describe('required fields tolerate a stray row but not a dead selector', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: String(i), title: `t${i}` }))
  const manyRecipe: Recipe = { ...recipe, validation: { ...recipe.validation, minItems: 1 } }

  it('passes when one row of fifty lacks the field, as a promo row does', () => {
    const withPromo = [...many.slice(0, 49), { id: null, title: 'sponsored' }]
    expect(validate(manyRecipe, { status: 200, payload, items: withPromo }).reasons.join())
      .not.toMatch(/required field "id"/)
  })

  it('fails when the field is empty in most rows, meaning the selector broke', () => {
    const mostlyEmpty = many.map((m, i) => (i < 40 ? { ...m, id: null } : m))
    expect(validate(manyRecipe, { status: 200, payload, items: mostlyEmpty }).reasons.join())
      .toMatch(/required field "id"/)
  })

  it('fails when the field is empty everywhere', () => {
    const allEmpty = many.map((m) => ({ ...m, id: null }))
    expect(validate(manyRecipe, { status: 200, payload, items: allEmpty }).reasons.join())
      .toMatch(/required field "id"/)
  })

  it('still fails a single-item result whose only row lacks the field', () => {
    expect(validate(manyRecipe, { status: 200, payload, items: [{ id: null, title: 'a' }] }).reasons.join())
      .toMatch(/required field "id"/)
  })
})
