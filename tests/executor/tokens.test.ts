import { describe, it, expect } from 'vitest'
import { countTokens } from '../../src/executor/tokens.js'

describe('countTokens', () => {
  it('counts nothing for an empty string', () => {
    expect(countTokens('')).toBe(0)
  })

  it('counts words the way cl100k_base does', () => {
    expect(countTokens('hello world')).toBe(2)
  })

  // A word no whitespace splitter can score as 3, so the test cannot pass
  // against a chars/4 or word-count stand-in for the real tokeniser.
  it('splits a single word into the pieces the vocabulary actually has', () => {
    expect(countTokens('indivisible')).toBe(3)
  })

  it('counts a long ASCII text at fewer tokens than characters', () => {
    const text = 'the quick brown fox jumps over the lazy dog '.repeat(100).slice(0, 4000)
    const tokens = countTokens(text)
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(text.length)
  })
})
