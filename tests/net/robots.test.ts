import { describe, it, expect } from 'vitest'
import { parseRobots, isPathAllowed } from '../../src/net/robots.js'

describe('parseRobots', () => {
  it('reads only the User-agent: * group', () => {
    const rules = parseRobots(`
User-agent: Googlebot
Disallow: /secret

User-agent: *
Disallow: /search
Allow: /search/help
Crawl-delay: 15
`)
    expect(rules.disallow).toEqual(['/search'])
    expect(rules.allow).toEqual(['/search/help'])
    expect(rules.crawlDelaySec).toBe(15)
  })

  it('treats an empty Disallow as full permission', () => {
    const rules = parseRobots('User-agent: *\nDisallow:')
    expect(rules.disallow).toEqual([])
  })

  it('returns no rules when robots.txt is absent or unparseable', () => {
    expect(parseRobots('')).toEqual({ allow: [], disallow: [], crawlDelaySec: null })
  })
})

describe('isPathAllowed', () => {
  const rules = { allow: ['/search/help'], disallow: ['/search'], crawlDelaySec: null }

  it('blocks a disallowed prefix', () => {
    expect(isPathAllowed(rules, '/search?q=serde')).toBe(false)
  })

  it('lets the longer Allow rule win over a shorter Disallow', () => {
    expect(isPathAllowed(rules, '/search/help')).toBe(true)
  })

  it('allows anything not mentioned', () => {
    expect(isPathAllowed(rules, '/crates/serde')).toBe(true)
  })

  it('honours a wildcard in a rule', () => {
    expect(isPathAllowed({ allow: [], disallow: ['/e/*/raw'], crawlDelaySec: null }, '/e/123/raw')).toBe(false)
  })
})
