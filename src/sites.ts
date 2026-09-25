export interface SiteResolver {
  origin(site: string): string
}

export class StaticSiteResolver implements SiteResolver {
  constructor(private readonly map: Record<string, string>) {}

  origin(site: string): string {
    const origin = this.map[site]
    if (!origin) throw new Error(`no origin registered for site "${site}"`)
    return origin
  }
}

/** Origins for the wild benchmark set. Fixture origins are supplied per-run. */
export const WILD_ORIGINS: Record<string, string> = {
  'pkg.go.dev': 'https://pkg.go.dev',
  'crates.io': 'https://crates.io',
  'hn.algolia.com': 'https://hn.algolia.com',

  // Held-out set: chosen after the engine was written, and run without tuning.
  'hex.pm': 'https://hex.pm',
  'docs.rs': 'https://docs.rs',
  'flathub.org': 'https://flathub.org',
  'jsr.io': 'https://jsr.io',

  // Held-out 2: chosen for families the engine has never seen — a forum, two
  // job boards, a marketplace, and a shadow-DOM SPA.
  'tildes.net': 'https://tildes.net',
  'remoteok.com': 'https://remoteok.com',
  'itch.io': 'https://itch.io',
  'arbeitnow.com': 'https://www.arbeitnow.com',
  'archive.org': 'https://archive.org',

  // Held-out 3: drawn under a frozen pre-registration, four challenge slots and
  // one positive control. Every one of them disallows /search, so each task
  // addresses the site's own browse axis instead.
  'meta.discourse.org': 'https://meta.discourse.org',
  'loc.gov': 'https://www.loc.gov',
  'bandcamp.com': 'https://bandcamp.com',
  'lemmy.world': 'https://lemmy.world',
  'openlibrary.org': 'https://openlibrary.org',

  // Held-out 4: two fediverse apps of different software drawn for cursor
  // pagination, a metadata catalog, a client-heavy forum, and a control.
  'mastodon.social': 'https://mastodon.social',
  'pixelfed.social': 'https://pixelfed.social',
  'musicbrainz.org': 'https://musicbrainz.org',
  'dev.to': 'https://dev.to',
  'npmjs.com': 'https://www.npmjs.com',
}
