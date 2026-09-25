import { createHash } from 'node:crypto'

const SEPARATOR = '::'

/**
 * Structural paths of a payload. Arrays collapse to `key[]` and every element
 * is merged, so a schema change is visible but a data change is not.
 */
export function collectPaths(value: unknown, prefix = ''): string[] {
  const out = new Set<string>()

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      if (path !== '') out.add(path)
      const arrayPath = `${path}[]`
      out.add(arrayPath)
      for (const element of node) walk(element, arrayPath)
      return
    }
    if (node !== null && typeof node === 'object') {
      if (path !== '') out.add(path)
      for (const [key, child] of Object.entries(node)) {
        walk(child, path === '' ? key : `${path}.${key}`)
      }
      return
    }
    if (path !== '') out.add(path)
  }

  walk(value, prefix)
  return [...out]
}

export function computeFingerprint(endpoint: string, sample: unknown): string {
  const paths = collectPaths(sample).sort()
  return createHash('sha256')
    .update(endpoint)
    .update(SEPARATOR)
    .update(paths.join('\n'))
    .digest('hex')
    .slice(0, 16)
}
