import { describe, it, expect } from 'vitest'
import { formatItems } from '../../src/executor/format.js'
import { countTokens } from '../../src/executor/tokens.js'
import type { Item } from '../../src/types.js'

describe('formatItems', () => {
  it('hoists the origin every url shares onto a base line', () => {
    const items: Item[] = [
      { title: 'One', url: 'https://example.com/a' },
      { title: 'Two', url: 'https://example.com/b' },
    ]
    expect(formatItems(items, 'tsv')).toBe(
      'base\thttps://example.com\ntitle\turl\nOne\t/a\nTwo\t/b',
    )
  })

  it('leaves urls whole when their origins differ', () => {
    const items: Item[] = [
      { url: 'https://one.example.com/a' },
      { url: 'https://two.example.com/b' },
    ]
    expect(formatItems(items, 'tsv')).toBe(
      'url\nhttps://one.example.com/a\nhttps://two.example.com/b',
    )
  })

  it('emits no base line when an item has no url', () => {
    const items: Item[] = [{ url: 'https://example.com/a' }, { title: 'no url here' }]
    expect(formatItems(items, 'tsv')).toBe('url\ttitle\nhttps://example.com/a\t\n\tno url here')
  })

  it('takes the columns as the union of keys, in order of first appearance', () => {
    expect(formatItems([{ a: 1 }, { b: 2 }], 'tsv')).toBe('a\tb\n1\t\n\t2')
  })

  it('empties a null cell and flattens tabs and newlines to single spaces', () => {
    const items: Item[] = [{ title: 'a\tb\nc', price: null }]
    expect(formatItems(items, 'tsv')).toBe('title\tprice\na b c\t')
  })

  it('returns exactly JSON.stringify for json', () => {
    const items: Item[] = [{ title: 'One', url: 'https://example.com/a' }, { price: 3 }]
    expect(formatItems(items, 'json')).toBe(JSON.stringify(items))
  })

  it('costs an agent fewer tokens than json on items sharing an origin', () => {
    const items: Item[] = Array.from({ length: 20 }, (_, i) => ({
      title: `The Collected Works, Volume ${i}`,
      url: `https://openlibrary.org/works/OL${i}W/collected`,
      year: 1900 + i,
    }))
    expect(countTokens(formatItems(items, 'tsv'))).toBeLessThan(countTokens(formatItems(items, 'json')))
  })
})
