import type { Item } from '../types.js'

export type OutputFormat = 'json' | 'tsv'

const ORIGIN = /^https?:\/\/[^/]+/

/** The `https?://host` every item's url starts with, or undefined if they do not share one. */
function sharedOrigin(items: Item[]): string | undefined {
  if (items.length === 0) return undefined
  let origin: string | undefined

  for (const item of items) {
    const url = item.url
    if (typeof url !== 'string') return undefined
    const match = ORIGIN.exec(url)
    if (match === null) return undefined
    if (origin === undefined) origin = match[0]
    else if (origin !== match[0]) return undefined
  }
  return origin
}

// A tab, newline or carriage return inside a value becomes a space, so a title
// cannot break the table. That is the whole escaping story: no quoting.
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[\t\n\r]/g, ' ')
}

/**
 * Serialises items for an agent to read. `tsv` is a header line plus one line
 * per item, preceded by a `base` line carrying the origin every url shares.
 */
export function formatItems(items: Item[], format: OutputFormat): string {
  if (format === 'json') return JSON.stringify(items)

  const columns: string[] = []
  for (const item of items) {
    for (const key of Object.keys(item)) if (!columns.includes(key)) columns.push(key)
  }

  const origin = sharedOrigin(items)
  const lines = origin === undefined ? [] : [`base\t${origin}`]
  lines.push(columns.join('\t'))

  for (const item of items) {
    lines.push(columns
      .map((key) => {
        const value = item[key]
        return key === 'url' && origin !== undefined && typeof value === 'string'
          ? cell(value.slice(origin.length))
          : cell(value)
      })
      .join('\t'))
  }
  return lines.join('\n')
}
