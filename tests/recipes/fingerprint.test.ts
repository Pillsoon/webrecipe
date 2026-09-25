import { describe, it, expect } from 'vitest'
import { collectPaths, computeFingerprint } from '../../src/recipes/fingerprint.js'
import { jsonSignature } from '../../src/executor/extract.js'

describe('collectPaths', () => {
  it('describes arrays with a [] segment, not an index', () => {
    expect(collectPaths({ results: [{ id: '1', title: 'a' }] }).sort())
      .toEqual(['results', 'results[]', 'results[].id', 'results[].title'])
  })

  it('does not let a longer first element hide fields of later ones', () => {
    expect(collectPaths({ r: [{ a: 1 }, { b: 2 }] }).sort())
      .toEqual(['r', 'r[]', 'r[].a', 'r[].b'])
  })
})

describe('computeFingerprint', () => {
  it('is stable across payloads of the same shape', () => {
    const a = computeFingerprint('/api/search', { results: [{ id: '1', title: 'x' }] })
    const b = computeFingerprint('/api/search', { results: [{ id: '2', title: 'y' }, { id: '3', title: 'z' }] })
    expect(a).toBe(b)
  })

  it('changes when a field is renamed', () => {
    const before = computeFingerprint('/api/query', { results: [{ id: '1', title: 'x' }] })
    const after = computeFingerprint('/api/query', { items: [{ id: '1', name: 'x' }] })
    expect(after).not.toBe(before)
  })

  it('changes when the endpoint moves', () => {
    const payload = { results: [{ id: '1' }] }
    expect(computeFingerprint('/api/v2/search', payload)).not.toBe(computeFingerprint('/api/search', payload))
  })
})

describe('jsonSignature', () => {
  const recipe = {
    output: { type: 'json' as const, items: { path: '$.hits', fields: { title: '$.title', url: '$.url' } } },
  }

  it('ignores payload fields the recipe does not read', () => {
    const a = jsonSignature(recipe, { hits: [{ title: 'T', url: '/u', _highlight: { title: {} } }] })
    const b = jsonSignature(recipe, { hits: [{ title: 'S', url: '/v', _highlight: { title: {}, text: {} } }] })
    expect(a).toEqual(b)
  })

  it('changes when the items path stops resolving', () => {
    const before = jsonSignature(recipe, { hits: [{ title: 'T', url: '/u' }] })
    const after = jsonSignature(recipe, { items: [{ title: 'T', url: '/u' }] })
    expect(after).not.toEqual(before)
  })

  it('changes when a declared field disappears', () => {
    const before = jsonSignature(recipe, { hits: [{ title: 'T', url: '/u' }] })
    const after = jsonSignature(recipe, { hits: [{ title: 'T' }] })
    expect(after).not.toEqual(before)
  })
})
