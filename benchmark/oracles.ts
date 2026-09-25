import type { z } from 'zod'
import type { OracleSpecSchema } from '../src/benchmark/oracle.js'

type Spec = z.infer<typeof OracleSpecSchema>

/**
 * Per-site oracle defaults. A site absent here is graded `golden`, which is
 * what every run before this contract used.
 *
 * `volatility` is documentation: it records why a mode was chosen, so a later
 * reader can tell a considered choice from a convenient one.
 */
export const ORACLES: Record<string, Spec> = {
  // Job boards: the whole listing turns over within minutes, so a stored
  // capture measures its own age rather than the engine.
  'remoteok.com': {
    mode: 'paired-live',
    volatility: 'high',
    compare: { ordering: 'ignore', fields: ['id', 'url'] },
  },
  'arbeitnow.com': {
    mode: 'paired-live',
    volatility: 'high',
    compare: { ordering: 'ignore', fields: ['title', 'url'] },
    // The one site measured so far that can silently ignore its own search
    // input: the parameter is discarded on redirect and every query returns the
    // same unfiltered front page. Declared here and nowhere else, because a
    // rule that fires on sites it was not designed for is an oracle bug.
    semantics: { input: 'query', fields: ['title'], match: 'contains-token', minShare: 0.5 },
  },

  // A marketplace browse page and a small forum: the set moves over days, and
  // both reorder equally-ranked items between requests.
  'itch.io': {
    mode: 'paired-live',
    volatility: 'medium',
    compare: { ordering: 'ignore', fields: ['id', 'title', 'url'] },
  },
  'tildes.net': {
    mode: 'paired-live',
    volatility: 'medium',
    compare: { ordering: 'ignore', fields: ['title', 'url'] },
  },

  // Registries and documentation: a version bump is the only churn, and result
  // ranking is stable enough to hold to.
  'docs.rs': { mode: 'golden', volatility: 'low' },
  'crates.io': { mode: 'golden', volatility: 'low' },
  'hex.pm': { mode: 'golden', volatility: 'low' },
  'jsr.io': { mode: 'golden', volatility: 'low' },
  'pkg.go.dev': {
    mode: 'golden',
    volatility: 'low',
    // Ranks ties differently between requests; the set is stable, the order is not.
    compare: { ordering: 'ignore' },
  },
  'hn.algolia.com': { mode: 'golden', volatility: 'low' },
  'flathub.org': {
    mode: 'golden',
    volatility: 'medium',
    compare: { ordering: 'ignore' },
  },

  // Held-out 3. Four of the five browse axes turn over on their own schedule —
  // a forum's tag feed, a federated community, a music catalog's discover
  // listing, and a trending chart are all volatile by construction — so they
  // are graded against the adjacent browser run rather than a stored capture.
  'meta.discourse.org': {
    mode: 'paired-live', volatility: 'high',
    compare: { ordering: 'ignore', fields: ['title', 'url'] },
  },
  'lemmy.world': {
    mode: 'paired-live', volatility: 'high',
    compare: { ordering: 'ignore', fields: ['title', 'url'] },
  },
  'bandcamp.com': {
    mode: 'paired-live', volatility: 'high',
    compare: { ordering: 'ignore', fields: ['title', 'url'] },
  },
  'openlibrary.org': {
    mode: 'paired-live', volatility: 'high',
    compare: { ordering: 'ignore', fields: ['title', 'url'] },
  },
  // The one held-out 3 axis that does not move: a format listing is a catalog,
  // not a feed.
  'loc.gov': {
    mode: 'golden', volatility: 'low',
    compare: { ordering: 'ignore', fields: ['title', 'url'] },
  },

  // Held-out 4. The three feeds turn over continuously — two fediverse tag
  // timelines and a forum's tag feed — so they are graded against the adjacent
  // browser run. pixelfed's grid carries no text of any kind, so `url` is the
  // only field there is to compare.
  'mastodon.social': {
    mode: 'paired-live', volatility: 'high',
    compare: { ordering: 'ignore', fields: ['title', 'url'] },
  },
  'pixelfed.social': {
    mode: 'paired-live', volatility: 'high',
    compare: { ordering: 'ignore', fields: ['url'] },
  },
  'dev.to': {
    mode: 'paired-live', volatility: 'high',
    compare: { ordering: 'ignore', fields: ['title', 'url'] },
  },
  // A catalog and a registry: a discography and a search ranking both hold
  // still long enough for a stored capture to be the scorer. `artist` is graded
  // on musicbrainz because the composed credit column is what slot C measures.
  'musicbrainz.org': {
    mode: 'golden', volatility: 'low',
    compare: { ordering: 'ignore', fields: ['title', 'url', 'artist'] },
  },
  'npmjs.com': {
    mode: 'golden', volatility: 'low',
    compare: { ordering: 'ignore', fields: ['title', 'url'] },
  },

  // Fixtures serve a fixed dataset in a fixed order, which makes them the only
  // sites where ordering is answerable at all — every wild site measured so far
  // reorders equally-ranked results between requests.
  siteA: { mode: 'golden', volatility: 'low', compare: { ordering: 'strict' } },
  siteB: { mode: 'golden', volatility: 'low', compare: { ordering: 'strict' } },
  siteC: { mode: 'golden', volatility: 'low', compare: { ordering: 'strict' } },
  siteCoalesce: { mode: 'golden', volatility: 'low', compare: { ordering: 'strict' } },

  // Paired-live so that an unusable baseline reaches baselineValidity; under
  // golden the stored capture is the scorer and never consults the browser.
  siteBroken: { mode: 'paired-live', volatility: 'low', compare: { ordering: 'ignore' } },

  // The one place orderingAgreement is reachable: paired-live plus a stable order.
  siteOrdered: { mode: 'paired-live', volatility: 'low', compare: { ordering: 'strict' } },

  // Paired-live because the whole point is that the browser side stays healthy
  // while the engine's client is refused; a stored golden never consults the
  // browser, so it could not show the difference.
  siteRefusing: { mode: 'paired-live', volatility: 'low', compare: { ordering: 'ignore' } },

  // Paired-live for siteRefusing's reason, and because the browser side is the
  // half that stays healthy here: it is the engine's client alone that is sent
  // a different page.
  siteStub: { mode: 'paired-live', volatility: 'low', compare: { ordering: 'ignore' } },
}
