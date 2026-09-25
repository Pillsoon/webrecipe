import { describe, it, expect } from 'vitest'
import { resolvePath } from '../../src/recipes/paths.js'

describe('resolvePath', () => {
  const doc = { crates: [{ id: 'serde', name: 'Serde' }], meta: { total: 1 } }

  it('returns the whole document for $', () => {
    expect(resolvePath(doc, '$')).toBe(doc)
  })

  it('walks a single key', () => {
    expect(resolvePath(doc, '$.crates')).toEqual(doc.crates)
  })

  it('walks nested keys', () => {
    expect(resolvePath(doc, '$.meta.total')).toBe(1)
  })

  it('returns undefined for a missing key rather than throwing', () => {
    expect(resolvePath(doc, '$.nope.deeper')).toBeUndefined()
  })

  it('reads a field off an item', () => {
    expect(resolvePath(doc.crates[0], '$.name')).toBe('Serde')
  })
})
