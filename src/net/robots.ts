export interface RobotsRules {
  allow: string[]
  disallow: string[]
  crawlDelaySec: number | null
}

export function parseRobots(text: string): RobotsRules {
  const rules: RobotsRules = { allow: [], disallow: [], crawlDelaySec: null }
  let inStarGroup = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? ''
    if (line === '') continue

    const idx = line.indexOf(':')
    if (idx === -1) continue
    const field = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()

    if (field === 'user-agent') {
      inStarGroup = value === '*'
      continue
    }
    if (!inStarGroup) continue

    if (field === 'disallow' && value !== '') rules.disallow.push(value)
    else if (field === 'allow' && value !== '') rules.allow.push(value)
    else if (field === 'crawl-delay') {
      const n = Number(value)
      if (Number.isFinite(n)) rules.crawlDelaySec = n
    }
  }
  return rules
}

function ruleMatches(rule: string, path: string): boolean {
  if (!rule.includes('*')) return path.startsWith(rule)
  const pattern = rule
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp('^' + pattern).test(path)
}

/** Longest matching rule wins; Allow beats Disallow at equal length (RFC 9309). */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  let best: { len: number; allowed: boolean } | null = null

  for (const [list, allowed] of [
    [rules.allow, true],
    [rules.disallow, false],
  ] as const) {
    for (const rule of list) {
      if (!ruleMatches(rule, path)) continue
      if (best === null || rule.length > best.len || (rule.length === best.len && allowed)) {
        best = { len: rule.length, allowed }
      }
    }
  }
  return best === null ? true : best.allowed
}
