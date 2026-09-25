import { describe, it, expect } from 'vitest'
import { render, renderQuery } from '../../src/recipes/template.js'

describe('render', () => {
  it('substitutes a named input', () => {
    expect(render('/item/{{id}}', { id: '100' })).toBe('/item/100')
  })

  it('substitutes numbers', () => {
    expect(render('page={{page}}', { page: 2 })).toBe('page=2')
  })

  it('throws on an unknown placeholder instead of emitting a literal', () => {
    expect(() => render('{{missing}}', { id: '1' })).toThrow(/missing/)
  })

  it('leaves text without placeholders alone', () => {
    expect(render('/api/search', {})).toBe('/api/search')
  })
})

describe('renderQuery', () => {
  it('renders every value', () => {
    expect(renderQuery({ q: '{{query}}', page: '{{page}}' }, { query: 'serde', page: 2 }))
      .toEqual({ q: 'serde', page: '2' })
  })
})
