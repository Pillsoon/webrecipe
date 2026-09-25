import { it, expect } from 'vitest'
import { localPaths, siteName, requireReadable } from '../src/local.js'
import { renderUrlTemplate } from '../src/recipes/template.js'

it('uses one persistent home independently of working directory', () => {
  const first = localPaths()
  expect(first.root).toBe(localPaths().root)
  expect(localPaths('/tmp/custom-webrecipe').plans).toBe('/tmp/custom-webrecipe/plans')
})
it('does not let site keys escape the storage directory', () => {
  for (const value of ['..', '../outside', '/tmp/escape', 'a/b', 'a\\b']) expect(() => siteName(value)).toThrow()
})
it('never labels unknown empty or partial extraction as a successful result', () => {
  expect(() => requireReadable([], ['title'])).toThrow(/empty result/)
  expect(() => requireReadable([{ title: null }], ['title'])).toThrow(/missing/)
  expect(() => requireReadable([{ title: 'Real title' }], ['title'])).not.toThrow()
})
it('encodes reserved query and path input characters without changing query semantics', () => {
  for (const value of ['C++', 'R&D', 'C#', 'quotes " and 한글']) {
    const url = new URL(renderUrlTemplate('https://example.test', '/search?q={{query}}&sort=recent', { query: value }))
    expect(url.searchParams.get('q')).toBe(value)
    expect([...url.searchParams.keys()]).toEqual(['q','sort'])
  }
  expect(new URL(renderUrlTemplate('https://example.test', '/tag/{{query}}', { query: 'C#' })).pathname).toBe('/tag/C%23')
})

it('rejects new filters the saved URL cannot apply instead of returning the original listing', () => {
  expect(() => renderUrlTemplate('https://example.test', '/search?q={{query}}', {query:'rust',page:2})).toThrow('does not use input "page"')
  expect(() => renderUrlTemplate('https://example.test', '/list', {query:'rust'})).toThrow('does not use input "query"')
})
