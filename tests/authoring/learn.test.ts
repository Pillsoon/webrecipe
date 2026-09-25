import { describe, it, expect } from 'vitest'
import { learnFromHtml, formatLearn, shell } from '../../src/authoring/learn.js'

const PAGE = `<!doctype html><html><body>
  <nav><a class="nav" href="/a">Home</a><a class="nav" href="/b">Help</a></nav>
  <ul id="results">
    <li class="result"><a class="title" href="/item/1">The Hobbit, and its long title</a></li>
    <li class="result"><a class="title" href="/item/2">Dune, and its several sequels</a></li>
  </ul>
</body></html>`

describe('learnFromHtml', () => {
  it('offers field candidates for each item candidate it reports', () => {
    const report = learnFromHtml('https://example.com/s?q=x', PAGE, 2)
    expect(report.items.length).toBe(2)
    for (const entry of report.items) expect(entry.fields.length).toBeGreaterThan(0)
  })

  it('finds the listing and a title spec whose samples are the titles', () => {
    const report = learnFromHtml('https://example.com/s?q=x', PAGE, 5)
    const listing = report.items.find((e) => e.candidate.selector === 'li.result')
    expect(listing).toBeDefined()
    const title = listing!.fields.find((f) => f.spec === 'a.title')
    expect(title!.samples).toEqual(['The Hobbit, and its long title', 'Dune, and its several sequels'])
  })

  it('stores nothing and reports the url it was given', () => {
    expect(learnFromHtml('https://example.com/s?q=x', PAGE, 1).url).toBe('https://example.com/s?q=x')
  })
})

describe('formatLearn', () => {
  it('prints every item candidate with its specs and a sample', () => {
    const text = formatLearn(learnFromHtml('https://example.com/s?q=x', PAGE, 2))
    expect(text).toContain('li.result')
    expect(text).toContain('a.title')
    expect(text).toContain('The Hobbit')
  })

  it('shell-quotes selectors so they survive being pasted into a command', () => {
    const text = formatLearn(learnFromHtml('https://example.com/s?q=x', PAGE, 2))
    const lines = text.split('\n')
    const itemsLines = lines.filter((l) => l.includes('--items'))
    expect(itemsLines.length).toBeGreaterThan(0)
    for (const line of itemsLines) {
      expect(line).toMatch(/--items\s+'[^']+'\s+/)
    }
    expect(text).toContain("'li.result'")
  })

  it('marks truncated field samples with ellipsis so differences are visible', () => {
    const PAGE_WITH_LONG_SAMPLES = `<!doctype html><html><body>
      <ul id="results">
        <li class="result"><a class="title">This is a very long string that definitely exceeds sixty characters and should be truncated</a></li>
        <li class="result"><a class="title">This is a very long string that definitely exceeds sixty characters but ends differently here</a></li>
      </ul>
    </body></html>`
    const text = formatLearn(learnFromHtml('https://example.com/s?q=x', PAGE_WITH_LONG_SAMPLES, 5))
    const lines = text.split('\n')
    const fieldLines = lines.filter((l) => l.includes('--field'))
    expect(fieldLines.length).toBeGreaterThan(0)
    const withEllipsis = fieldLines.filter((l) => l.includes('…'))
    expect(withEllipsis.length).toBeGreaterThan(0)
    const distinctLines = new Set(fieldLines).size
    expect(distinctLines).toBe(fieldLines.length)
  })

  it('preserves selectors containing dollar signs in the printed command', () => {
    const PAGE_WITH_DOLLAR = `<!doctype html><html><body>
      <nav><a class="nav" href="/a">Home</a><a class="nav" href="/b">Help</a></nav>
      <ul id="results">
        <li class="result w-1$2"><a class="title" href="/item/1">The Hobbit, and its long title</a></li>
        <li class="result w-1$2"><a class="title" href="/item/2">Dune, and its several sequels</a></li>
      </ul>
    </body></html>`
    const text = formatLearn(learnFromHtml('https://example.com/s?q=x', PAGE_WITH_DOLLAR, 5))
    const lines = text.split('\n')
    const itemsLines = lines.filter((l) => l.includes('--items'))
    const withDollar = itemsLines.filter((l) => l.includes('w-1\\$2') || l.includes('w-1$2'))
    expect(withDollar.length).toBeGreaterThan(0)
  })
})

describe('shell', () => {
  it('produces a word a shell reconstructs as the original', () => {
    expect(shell("a'b")).toBe(String.raw`'a'\''b'`)
  })

  it('leaves a selector with a dollar sign intact inside one quoted word', () => {
    expect(shell(String.raw`div.w-1\$2 > a`)).toBe(String.raw`'div.w-1\$2 > a'`)
  })
})
