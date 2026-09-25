import { describe, it, expect } from 'vitest'
import { synthesizeTemplate, synthesizeAcrossRows, reconcileField, renderRowTemplate } from '../../src/compiler/derive.js'
import { templatePath } from '../../src/compiler/heuristic.js'

describe('synthesizeTemplate', () => {
  it('rebuilds a path the page assembles from an id', () => {
    expect(synthesizeTemplate('/crates/serde', { id: 'serde', name: 'serde' }))
      .toContain('{{')
  })

  it('rebuilds a composed title', () => {
    const out = synthesizeTemplate('serde v1.0.229', { name: 'serde', default_version: '1.0.229' })
    expect(out).toBe('{{name}} v{{default_version}}')
  })

  it('rebuilds a url from a numeric id', () => {
    const out = synthesizeTemplate('https://news.ycombinator.com/item?id=22238335', { objectID: '22238335' })
    expect(out).toBe('https://news.ycombinator.com/item?id={{objectID}}')
  })

  it('prefers the longer value when one contains another', () => {
    // '1' also appears in '1.0.229'; taking it first would strand the rest.
    expect(synthesizeTemplate('v1.0.229', { major: '1', version: '1.0.229' }))
      .toBe('v{{version}}')
  })

  it('coerces numbers, which json payloads use for ids', () => {
    expect(synthesizeTemplate('/item/22238335', { story_id: 22238335 }))
      .toBe('/item/{{story_id}}')
  })

  it('returns null when nothing in the row appears in the target', () => {
    expect(synthesizeTemplate('/crates/serde', { downloads: 1399807570 })).toBeNull()
  })

  it('returns null for a target that is only literal text', () => {
    expect(synthesizeTemplate('Results', { name: 'serde' })).toBeNull()
  })

  it('ignores very short values, which match by coincidence', () => {
    expect(synthesizeTemplate('/crates/serde', { yanked: 'e', ok: 'a' })).toBeNull()
  })
})

describe('synthesizeAcrossRows', () => {
  const rows = [
    { id: 'serde', name: 'serde' },
    { id: 'tokio-util', name: 'tokio_util' },
  ]
  const targets = ['/crates/serde', '/crates/tokio-util']

  it('picks the field that holds for every row, not just the first', () => {
    // Row 0 cannot tell id from name; row 1 can.
    expect(synthesizeAcrossRows(targets, rows)).toBe('/crates/{{id}}')
  })

  it('returns null when no single template reproduces every row', () => {
    expect(synthesizeAcrossRows(['/crates/serde', '/elsewhere/tokio-util'], rows)).toBeNull()
  })

  it('returns null when the row and target counts disagree', () => {
    expect(synthesizeAcrossRows(['/crates/serde'], rows)).toBeNull()
  })

  it('returns null when there are no rows', () => {
    expect(synthesizeAcrossRows([], [])).toBeNull()
  })

  it('is deterministic when several templates survive every row', () => {
    // objectID and story_id are always equal on this site.
    const ambiguous = [
      { objectID: '22238335', story_id: '22238335' },
      { objectID: '40172033', story_id: '40172033' },
    ]
    const targets = ['/item/22238335', '/item/40172033']
    const first = synthesizeAcrossRows(targets, ambiguous)
    const second = synthesizeAcrossRows(targets, ambiguous)
    expect(first).toBe(second)
    expect(first).toBe('/item/{{objectID}}')
  })

  it('skips a target the browser did not produce', () => {
    expect(synthesizeAcrossRows(['/crates/serde', null], rows)).toBeNull()
  })
})

describe('reconcileField', () => {
  const rows = [
    { objectID: '22238335', url: 'https://blog.example/a' },
    { objectID: '40172033', url: 'https://blog.example/b' },
  ]
  const browserUrls = [
    'https://news.ycombinator.com/item?id=22238335',
    'https://news.ycombinator.com/item?id=40172033',
  ]

  it('keeps a spec that already reproduces the browser', () => {
    expect(reconcileField('$.url', rows.map((r) => r.url), rows)).toBe('$.url')
  })

  it('replaces a spec that maps to the wrong thing by the same name', () => {
    expect(reconcileField('$.url', browserUrls, rows))
      .toBe('https://news.ycombinator.com/item?id={{objectID}}')
  })

  it('returns null when neither the spec nor any synthesis matches', () => {
    expect(reconcileField('$.url', ['nothing', 'related'], rows)).toBeNull()
  })

  it('synthesises when there is no spec at all', () => {
    expect(reconcileField(undefined, browserUrls, rows))
      .toBe('https://news.ycombinator.com/item?id={{objectID}}')
  })
})

describe('tie-breaking prefers parameterisation over baked-in literals', () => {
  it('templates the version rather than hardcoding it, even from a single row', () => {
    // A detail page shows one record, so no other row can disambiguate. Keeping
    // the literal would return "tokio v1.0.229" for every crate.
    const out = synthesizeAcrossRows(
      ['serde v1.0.229'],
      [{ id: 'serde', name: 'serde', default_version: '1.0.229', max_version: '1.0.229' }],
    )
    expect(out).not.toContain('1.0.229')
    expect(out).toMatch(/^\{\{\w+\}\} v\{\{\w+\}\}$/)
  })

  it('is still deterministic among equally parameterised templates', () => {
    const rows = [{ a: 'serde', b: 'serde' }]
    expect(synthesizeAcrossRows(['serde'], rows)).toBe(synthesizeAcrossRows(['serde'], rows))
  })
})

describe('renderRowTemplate with a coalesce', () => {
  it('renders the first key that has a value', () => {
    expect(renderRowTemplate('{{a ?? b}}', { a: null, b: 'x' })).toBe('x')
    expect(renderRowTemplate('{{a ?? b}}', { a: 'y', b: 'x' })).toBe('y')
    expect(renderRowTemplate('{{a ?? b}}', { a: '', b: 'x' })).toBe('x')
    expect(renderRowTemplate('{{a ?? b}}', { a: null, b: null })).toBe('')
  })

  it('accepts whitespace around the operator and more than two keys', () => {
    expect(renderRowTemplate('{{a??b}}', { a: null, b: 'x' })).toBe('x')
    expect(renderRowTemplate('{{ a ?? b ?? c }}', { a: null, b: null, c: 'z' })).toBe('z')
  })

  it('leaves a plain placeholder exactly as it was', () => {
    expect(renderRowTemplate('{{a}}', { a: 'y' })).toBe('y')
    expect(renderRowTemplate('{{a}}', { a: null })).toBe('')
    expect(renderRowTemplate('/item/{{id}}', { id: 22238335 })).toBe('/item/22238335')
  })
})

describe('synthesizeAcrossRows with a coalesce', () => {
  // bandcamp's shape: the page renders `title by (album_artist ?? band_name)`.
  const favourable = [
    { title: 'Weightless', album_artist: 'Marconi Union', band_name: 'Marconi Union Official' },
    { title: 'Bloom', album_artist: null, band_name: 'Chihei Hatakeyama' },
    { title: 'Nocturne', album_artist: 'Grouper', band_name: 'Grouper Official' },
  ]
  // The same rows as the site could equally have returned them. 43 of bandcamp's
  // 60 rows have album_artist null, so this order is the likelier one.
  const unfavourable = [favourable[1]!, favourable[0]!, favourable[2]!]
  const targetsFor = (rows: typeof favourable) =>
    rows.map((r) => `${r.title} by ${r.album_artist ?? r.band_name}`)

  it.each([['album_artist set on row 0', favourable], ['album_artist null on row 0', unfavourable]])(
    'learns the same coalesce with %s', (_name, rows) => {
      expect(synthesizeAcrossRows(targetsFor(rows), rows))
        .toBe('{{title}} by {{album_artist ?? band_name}}')
    },
  )

  it('rejects the order that fails a row, where that order would otherwise win', () => {
    // The rule is `band_name ?? album_artist`, and row 0 rendered album_artist,
    // so the reverse candidate is genuinely formed. It also sorts first — the
    // survivors are ranked lexically and `album_artist` precedes `band_name` —
    // so only the all-rows filter can keep it out. Row 1 and row 2 have both
    // fields set and different, which is what makes it fail.
    const rows = [
      { title: 'Bloom', band_name: null, album_artist: 'Kranky Records' },
      { title: 'Weightless', band_name: 'Marconi Union', album_artist: 'Just Music' },
      { title: 'Nocturne', band_name: 'Grouper', album_artist: 'Yellowelectric' },
    ]
    const targets = rows.map((r) => `${r.title} by ${r.band_name ?? r.album_artist}`)
    expect(synthesizeAcrossRows(targets, rows)).toBe('{{title}} by {{band_name ?? album_artist}}')
  })

  it('introduces no coalesce when a plain template already explains every row', () => {
    const plain = [{ id: 'serde', name: 'serde' }, { id: 'tokio-util', name: 'tokio_util' }]
    const out = synthesizeAcrossRows(['/crates/serde', '/crates/tokio-util'], plain)
    expect(out).toBe('/crates/{{id}}')
    expect(out).not.toContain('??')
  })

  it('returns null when no single coalesce explains every row', () => {
    // Three fallbacks deep, and synthesis produces at most one `??`.
    const deep = [
      { title: 'Weightless', album_artist: 'Marconi Union', band_name: 'MU Official', label: 'Just Music' },
      { title: 'Bloom', album_artist: null, band_name: 'Chihei Hatakeyama', label: 'Kranky Records' },
      { title: 'Nocturne', album_artist: null, band_name: null, label: 'Yellowelectric' },
    ]
    const deepTargets = deep.map((r) => `${r.title} by ${r.album_artist ?? r.band_name ?? r.label}`)
    expect(synthesizeAcrossRows(deepTargets, deep)).toBeNull()
  })
})

describe('templatePath inside a segment', () => {
  it('templates a value embedded in a segment', () => {
    expect(templatePath('/games/genre-puzzle', { query: 'puzzle' })).toBe('/games/genre-{{query}}')
  })

  it('templates a value surrounded by literal text', () => {
    expect(templatePath('/remote-python-jobs', { query: 'python' })).toBe('/remote-{{query}}-jobs')
  })

  it('still templates a whole segment', () => {
    expect(templatePath('/item/100', { id: '100' })).toBe('/item/{{id}}')
  })

  it('still spans several segments when the value does', () => {
    expect(templatePath('/github.com/gorilla/mux', { id: 'github.com/gorilla/mux' })).toBe('/{{id}}')
  })

  it('prefers the longer value when one contains another', () => {
    expect(templatePath('/tag-puzzler', { long: 'puzzler', short: 'puzzle' })).toBe('/tag-{{long}}')
  })

  it('templates a one-character value only where it fills a whole segment', () => {
    expect(templatePath('/a/b/c', { x: 'b' })).toBe('/a/{{x}}/c')
    expect(templatePath('/ab/c', { x: 'b' })).toBe('/ab/c')
  })

  it('templates every occurrence of the value', () => {
    expect(templatePath('/python/jobs/python', { query: 'python' })).toBe('/{{query}}/jobs/{{query}}')
  })

  it('leaves a path with no input value untouched', () => {
    expect(templatePath('/api/v1/crates', { query: 'serde' })).toBe('/api/v1/crates')
  })
})
