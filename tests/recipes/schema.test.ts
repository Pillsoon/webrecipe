import { describe, it, expect } from 'vitest'
import { RecipeSchema } from '../../src/recipes/schema.js'

const valid = {
  site: 'crates.io',
  intent: 'search',
  inputs: { query: { type: 'string' } },
  strategy: { type: 'http-json' },
  request: { method: 'GET', path: '/api/v1/crates', query: { q: '{{query}}' } },
  output: { type: 'json', items: { path: '$.crates', fields: { id: '$.id', title: '$.name' } } },
  validation: { status: 200, required: ['id', 'title'], minItems: 1 },
  fingerprint: { endpoint: '/api/v1/crates', hash: 'abc123', responseFields: ['crates', 'crates[].id'] },
  fallback: { type: 'browser' },
}

describe('RecipeSchema', () => {
  it('accepts a complete json recipe', () => {
    expect(RecipeSchema.parse(valid).site).toBe('crates.io')
  })

  it('accepts an html recipe using selectors', () => {
    const html = {
      ...valid,
      strategy: { type: 'http-html' },
      output: { type: 'html', items: { selector: 'li.result', fields: { id: '@data-id', title: 'a.title' } } },
    }
    expect(RecipeSchema.parse(html).output.type).toBe('html')
  })

  it('rejects an unknown intent', () => {
    expect(() => RecipeSchema.parse({ ...valid, intent: 'checkout' })).toThrow()
  })

  it('rejects a json output that carries a selector instead of a path', () => {
    const bad = { ...valid, output: { type: 'json', items: { selector: 'li', fields: {} } } }
    expect(() => RecipeSchema.parse(bad)).toThrow()
  })

  it('defaults minItems to 1', () => {
    const noMin = { ...valid, validation: { status: 200, required: ['id'] } }
    expect(RecipeSchema.parse(noMin).validation.minItems).toBe(1)
  })
})
