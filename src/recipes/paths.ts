/** Minimal JSONPath subset: `$`, `$.key`, `$.a.b`. Enough for recipe output specs. */
export function resolvePath(root: unknown, path: string): unknown {
  if (path === '$') return root
  if (!path.startsWith('$.')) throw new Error(`unsupported path: ${path}`)

  let current: unknown = root
  for (const key of path.slice(2).split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
