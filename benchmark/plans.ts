import type { BrowserPlan } from '../src/executor/strategies/browser.js'
import type { Intent } from '../src/types.js'

const enc = (v: unknown): string => encodeURIComponent(String(v))

/** Hoisted because siteRefusing serves this exact page; the two must not drift. */
const SITE_A_PLANS: Partial<Record<Intent, BrowserPlan>> = {
  search: {
    url: (o, t) => `${o}/search?q=${enc(t.input.query)}`,
    itemSelector: 'li.result',
    fields: { id: '@data-id', title: 'a.title', url: 'a.title@href' },
  },
  list: {
    url: (o, t) => `${o}/search?q=&page=${enc(t.input.page)}`,
    itemSelector: 'li.result',
    fields: { id: '@data-id', title: 'a.title', url: 'a.title@href' },
  },
  detail: {
    url: (o, t) => `${o}/item/${enc(t.input.id)}`,
    itemSelector: 'article#detail',
    fields: { id: '@data-id', title: 'h1.title', author: 'span.author' },
  },
}

/**
 * Per-site knowledge of where to go and what to read — exactly what a learned
 * recipe replaces. Fixture plans are exact; wild plans are verified against the
 * live pages before any benchmark number is trusted.
 */
export const PLANS: Record<string, Partial<Record<Intent, BrowserPlan>>> = {
  siteA: SITE_A_PLANS,

  // siteB's API returns no url; the page composes it from the id, so a recipe
  // can only match the browser by learning that derivation.
  siteB: {
    search: {
      url: (o, t) => `${o}/search?q=${enc(t.input.query)}`,
      itemSelector: 'li.result',
      fields: { id: '@data-id', title: '', url: 'a.permalink@href' },
    },
    list: {
      url: (o, t) => `${o}/search?q=&page=${enc(t.input.page)}`,
      itemSelector: 'li.result',
      fields: { id: '@data-id', title: '', url: 'a.permalink@href' },
    },
    detail: {
      url: (o, t) => `${o}/item/${enc(t.input.id)}`,
      itemSelector: 'article#detail',
      fields: { id: '@data-id', title: 'h1.title', author: 'span.author' },
    },
  },

  siteC: {
    search: {
      url: (o, t) => `${o}/search?q=${enc(t.input.query)}`,
      itemSelector: 'li.result',
      fields: { id: '@data-id', title: '' },
    },
    list: {
      url: (o, t) => `${o}/search?q=&page=${enc(t.input.page)}`,
      itemSelector: 'li.result',
      fields: { id: '@data-id', title: '' },
    },
    detail: {
      url: (o, t) => `${o}/item/${enc(t.input.id)}`,
      itemSelector: 'article#detail',
      fields: { id: '@data-id', title: '' },
    },
  },

  // crates.io is a Svelte app; its generated class names (svelte-10p0ryf) change
  // on every build, so only the semantic ones are usable as selectors.
  'crates.io': {
    search: {
      url: (o, t) => `${o}/search?q=${enc(t.input.query)}`,
      itemSelector: '.crate-row',
      fields: { title: 'a.name', url: 'a.name@href' },
    },
    detail: {
      url: (o, t) => `${o}/crates/${enc(t.input.id)}`,
      itemSelector: 'h1.heading',
      fields: { title: '' },
    },
  },

  'pkg.go.dev': {
    search: {
      url: (o, t) => `${o}/search?q=${enc(t.input.query)}`,
      itemSelector: '.SearchSnippet',
      fields: { title: 'h2 a', url: 'h2 a@href' },
    },
    detail: {
      url: (o, t) => `${o}/${String(t.input.id)}`,
      itemSelector: '.UnitHeader-titleHeading',
      fields: { title: '' },
    },
  },

  'hn.algolia.com': {
    search: {
      url: (o, t) => `${o}/?query=${enc(t.input.query)}`,
      itemSelector: '.Story',
      fields: { title: '.Story_title a', url: '.Story_title a@href' },
    },
  },

  // ---------------------------------------------------------------------------
  // Held-out sites. Selectors were authored from the rendered DOM, as any user
  // of this tool would; their API payloads were deliberately not inspected.
  // ---------------------------------------------------------------------------

  'hex.pm': {
    search: {
      url: (o, t) => `${o}/packages?search=${enc(t.input.query)}`,
      itemSelector: 'li:has(a[href^="/packages/"])',
      fields: { title: 'a[href^="/packages/"]', url: 'a[href^="/packages/"]@href' },
    },
    detail: {
      url: (o, t) => `${o}/packages/${enc(t.input.id)}`,
      itemSelector: 'h1',
      fields: { title: '' },
    },
  },

  'docs.rs': {
    search: {
      url: (o, t) => `${o}/releases/search?query=${enc(t.input.query)}`,
      itemSelector: 'a.release',
      fields: { title: '.name', description: '.description', url: '@href' },
    },
  },

  'flathub.org': {
    search: {
      url: (o, t) => `${o}/apps/search?q=${enc(t.input.query)}`,
      // Scoped to main: the same anchor shape appears in the nav and the
      // recommendation strip, which would pad the result set with five rows
      // the search API never returned.
      itemSelector: 'main a[href^="/en/apps/"]',
      fields: { title: 'span.truncate', url: '@href' },
    },
    detail: {
      url: (o, t) => `${o}/apps/${String(t.input.id)}`,
      itemSelector: 'h1',
      fields: { title: '' },
    },
  },

  'jsr.io': {
    search: {
      url: (o, t) => `${o}/packages?search=${enc(t.input.query)}`,
      itemSelector: 'li:has(a[href^="/@"])',
      fields: { title: 'a[href^="/@"]', url: 'a[href^="/@"]@href' },
    },
  },

  // ---------------------------------------------------------------------------
  // Held-out 2. Same rule as before: selectors authored from the rendered DOM,
  // payloads never inspected.
  // ---------------------------------------------------------------------------

  // No list intent for these three: none of them paginates through a URL
  // parameter. tildes uses an after= cursor, itch.io and arbeitnow ignore
  // ?page= entirely, and remoteok scrolls. A recipe replays one static request,
  // so a second page is not expressible — a design limit, not a missing plan.
  'tildes.net': {
    search: {
      url: (o, t) => `${o}/search?q=${enc(t.input.query)}`,
      itemSelector: 'article.topic',
      fields: { title: 'h1.topic-title a', url: 'h1.topic-title a@href', group: 'a.link-group' },
    },
  },

  'remoteok.com': {
    // Filters live in the path rather than a query string.
    search: {
      url: (o, t) => `${o}/remote-${enc(t.input.query)}-jobs`,
      itemSelector: 'tr.job',
      fields: { id: '@data-slug', url: '@data-url' },
    },
  },

  // Held-out 3. Authored from the rendered DOM only, against the browse axis
  // each site allows, because all five disallow /search.

  // A: client-heavy forum. /tag/{tag} redirects to /tag/{tag}/{id}.
  'meta.discourse.org': {
    search: {
      url: (o, t) => `${o}/tag/${enc(t.input.query)}`,
      itemSelector: 'tr.topic-list-item',
      fields: { title: 'a.title', url: 'a.title@href' },
    },
    // ?page=N is the site's own pagination: the tag page emits it as
    // link[rel=next]. It also reorders the first page, so page 1 here is not
    // the listing the bare /tag/{tag} of `search` returns.
    list: {
      url: (o, t) => `${o}/tag/${enc(t.input.query)}?page=${enc(t.input.page)}`,
      itemSelector: 'tr.topic-list-item',
      fields: { title: 'a.title', url: 'a.title@href' },
    },
    // A bare topic id is enough; the site redirects to the slugged form.
    detail: {
      url: (o, t) => `${o}/t/${enc(t.input.id)}`,
      itemSelector: '#topic-title',
      fields: { title: 'h1 a', url: 'h1 a@href', category: 'span.category-name' },
    },
  },

  // B: faceted catalog. The browse axis is the format, which is a path segment.
  'loc.gov': {
    search: {
      url: (o, t) => `${o}/${enc(t.input.query)}/`,
      itemSelector: 'li.item',
      fields: { title: 'span.item-description-title', url: 'a@href' },
    },
    // Pagination is ?sp=N, not ?page=N — the listing's own next/prev links say so.
    list: {
      url: (o, t) => `${o}/${enc(t.input.query)}/?sp=${enc(t.input.page)}`,
      itemSelector: 'li.item',
      fields: { title: 'span.item-description-title', url: 'a@href' },
    },
    // No `url` field: an item page carries no link to itself inside its own
    // root, so the detail tasks narrow the oracle to the fields that exist.
    detail: {
      url: (o, t) => `${o}/item/${enc(t.input.id)}/`,
      itemSelector: '.item-container',
      fields: { title: 'h1 cite', format: 'h1 a.format-label' },
    },
  },

  // C: commercial catalog. /tag/{tag} redirects to /discover/{tag}. The
  // `data-v-*` attributes are build hashes and must never enter a selector.
  'bandcamp.com': {
    search: {
      url: (o, t) => `${o}/tag/${enc(t.input.query)}`,
      itemSelector: 'li.card-item',
      fields: { title: 'a.stretch-link', url: 'a.stretch-link@href' },
    },
  },

  // D: the stateful-pagination slot.
  'lemmy.world': {
    // Slot D exists to put the recipe model's missing pagination state under
    // load, so `page` is a second input rather than a fixed 1.
    search: {
      url: (o, t) => `${o}/c/${enc(t.input.query)}?page=${enc(t.input.page)}`,
      itemSelector: 'article.post-container',
      fields: { title: 'a.link-dark', url: 'a.link-dark@href' },
    },
    list: {
      url: (o, t) => `${o}/c/${enc(t.input.query)}?page=${enc(t.input.page)}`,
      itemSelector: 'article.post-container',
      fields: { title: 'a.link-dark', url: 'a.link-dark@href' },
    },
    // .post-listing, not article.post-container: the latter is emitted twice
    // per post, once for each of the narrow and wide layouts.
    detail: {
      url: (o, t) => `${o}/post/${enc(t.input.id)}`,
      itemSelector: '.post-listing',
      fields: { title: 'a.link-dark', url: 'a.link-dark@href', community: 'a.community-link' },
    },
  },

  // E: positive control. Both inputs are visible in the URL, which is the
  // property the control exists to verify the engine can still exploit.
  'openlibrary.org': {
    search: {
      url: (o, t) => `${o}/trending/${enc(t.input.query)}?page=${enc(t.input.page)}`,
      itemSelector: 'li.searchResultItem',
      fields: {
        title: 'h3.booktitle a.results',
        url: 'h3.booktitle a.results@href',
        author: 'span.bookauthor a',
      },
    },
    list: {
      url: (o, t) => `${o}/trending/${enc(t.input.query)}?page=${enc(t.input.page)}`,
      itemSelector: 'li.searchResultItem',
      fields: {
        title: 'h3.booktitle a.results',
        url: 'h3.booktitle a.results@href',
        author: 'span.bookauthor a',
      },
    },
    // The first /works/ link inside the panel is the work's own, carrying the
    // edition the page chose to display — the same shape the listing yields.
    detail: {
      url: (o, t) => `${o}/works/${enc(t.input.id)}`,
      itemSelector: 'div.workDetails',
      fields: {
        title: 'h1.work-title',
        url: 'a[href^="/works/OL"]@href',
        author: 'h2.edition-byline a',
      },
    },
  },

  // Held-out 4. Authored from the rendered DOM only, on the browse axis each
  // site allows.

  // A: cursor slot. The tag timeline renders its statuses lazily, so most of the
  // 20 `article` elements are empty placeholders until they enter the viewport;
  // the `:has` scopes the listing to the statuses that actually rendered.
  'mastodon.social': {
    search: {
      url: (o, t) => `${o}/tags/${enc(t.input.query)}`,
      itemSelector: 'article:has(a.status__relative-time)',
      fields: { title: '.status__content', url: 'a.status__relative-time@href' },
    },
    // Identical to `search`: the timeline's only next-page affordance is a
    // "Load more" button that changes no URL, so page 2 has no address to name.
    list: {
      url: (o, t) => `${o}/tags/${enc(t.input.query)}`,
      itemSelector: 'article:has(a.status__relative-time)',
      fields: { title: '.status__content', url: 'a.status__relative-time@href' },
    },
  },

  // B: cursor slot. The grid carries no text at all — no caption, no alt, no
  // link title — so `url` is the only field the surface affords.
  'pixelfed.social': {
    search: {
      url: (o, t) => `${o}/discover/tags/${enc(t.input.query)}`,
      itemSelector: '.hashtag-post-square',
      fields: { url: 'a@href' },
    },
    // Identical to `search` for the same reason as mastodon: the page offers no
    // next link, no page parameter, and scrolling adds nothing.
    list: {
      url: (o, t) => `${o}/discover/tags/${enc(t.input.query)}`,
      itemSelector: '.hashtag-post-square',
      fields: { url: 'a@href' },
    },
  },

  // C: metadata catalog. /search, /tag/ and /recording/ are disallowed; the
  // allowed listing is an artist's release-group table, so the axis is an MBID.
  // `artist` is the composed credit column, which is what slot C exists to test.
  'musicbrainz.org': {
    search: {
      url: (o, t) => `${o}/artist/${enc(t.input.query)}`,
      itemSelector: 'tr.odd, tr.even',
      fields: { title: 'a.wrap-anywhere', url: 'a.wrap-anywhere@href', artist: 'td:nth-child(3)' },
    },
    // ?page=N is the listing's own pagination: the table emits numbered links.
    list: {
      url: (o, t) => `${o}/artist/${enc(t.input.query)}?page=${enc(t.input.page)}`,
      itemSelector: 'tr.odd, tr.even',
      fields: { title: 'a.wrap-anywhere', url: 'a.wrap-anywhere@href', artist: 'td:nth-child(3)' },
    },
    detail: {
      url: (o, t) => `${o}/release-group/${enc(t.input.id)}`,
      itemSelector: 'h1',
      fields: { title: 'a', url: 'a@href' },
    },
  },

  // D: client-heavy forum. /search is disallowed; the tag feed is the axis.
  'dev.to': {
    search: {
      url: (o, t) => `${o}/t/${enc(t.input.query)}`,
      itemSelector: 'div.crayons-story',
      fields: { title: 'h2.crayons-story__title a', url: 'h2.crayons-story__title a@href' },
    },
    // Pagination is a path segment, /t/{tag}/page/N, not a query parameter.
    list: {
      url: (o, t) => `${o}/t/${enc(t.input.query)}/page/${enc(t.input.page)}`,
      itemSelector: 'div.crayons-story',
      fields: { title: 'h2.crayons-story__title a', url: 'h2.crayons-story__title a@href' },
    },
    // An article id is a two-segment path, so each segment is encoded on its
    // own; encoding the whole id would escape the separator.
    // No `url` field: nothing inside the article root links to the article.
    detail: {
      url: (o, t) => `${o}/${String(t.input.id).split('/').map(enc).join('/')}`,
      itemSelector: 'article.crayons-article',
      fields: { title: 'h1', author: 'a.crayons-link' },
    },
  },

  // E: positive control. Every class on this site is a build hash (db7ee1ac …),
  // so selectors use the anchors, the landmark ids and the tag names instead.
  'npmjs.com': {
    search: {
      url: (o, t) => `${o}/search?q=${enc(t.input.query)}`,
      itemSelector: 'a[href^="/package/"]',
      fields: { title: '', url: '@href' },
    },
    // npm's page parameter is zero-based — its own "1" link is page=0 — so the
    // task's `page` is that index, and perPage matches the emitted href.
    list: {
      url: (o, t) => `${o}/search?q=${enc(t.input.query)}&page=${enc(t.input.page)}&perPage=20`,
      itemSelector: 'a[href^="/package/"]',
      fields: { title: '', url: '@href' },
    },
    // The readme tab is the package's own canonical link, and the only one on
    // the page that is not a build-hash class.
    detail: {
      url: (o, t) => `${o}/package/${enc(t.input.id)}`,
      itemSelector: 'main#main',
      fields: { title: 'h1', url: 'a#package-tab-readme@href' },
    },
  },

  'itch.io': {
    // /search is disallowed; the tag browse pages carry the same result shape.
    search: {
      url: (o, t) => `${o}/games/tag-${enc(t.input.query)}`,
      itemSelector: '.game_cell',
      fields: { id: '@data-game_id', title: 'a.title', url: 'a.title@href' },
    },
  },

  'arbeitnow.com': {
    search: {
      url: (o, t) => `${o}/jobs?search=${enc(t.input.query)}`,
      itemSelector: 'h3.flex.items-center',
      fields: { title: 'a[href*="/jobs/"]', url: 'a[href*="/jobs/"]@href' },
    },
  },

  // Known-hard case: results live inside app-root's shadow DOM, which neither
  // querySelectorAll nor page.content() can reach. Expected to stay at L3, and
  // included so that the boundary is a measured number rather than an opinion.
  'archive.org': {
    search: {
      url: (o, t) => `${o}/search?query=${enc(t.input.query)}`,
      itemSelector: 'a[href^="/details/"]',
      fields: { url: '@href' },
    },
  },

  // Harness check only. Same server as siteA, graded paired-live with strict
  // ordering, which is the only way orderingAgreement runs outside unit tests:
  // every wild site reorders equally-ranked results, and the other fixtures are
  // graded golden.
  siteOrdered: {
    search: {
      url: (o, t) => `${o}/search?q=${enc(t.input.query)}`,
      itemSelector: 'li.result',
      fields: { id: '@data-id', title: 'a.title' },
    },
  },

  // Harness check only. The selector is meant to find nothing, so the browser
  // returns an unusable baseline and the exclusion path fires deterministically
  // instead of waiting for a real site to time out.
  siteBroken: {
    search: {
      url: (o, t) => `${o}/search?q=${enc(t.input.query)}`,
      itemSelector: '.deliberately-absent',
      fields: { title: 'a.title' },
    },
  },

  // Harness check only. The server serves siteA's page to a browser and refuses
  // the engine's client, so the browser plan is siteA's plan exactly.
  siteRefusing: SITE_A_PLANS,

  // Harness check only. Also siteA's page to a browser, but the engine's client
  // gets a 200 challenge page instead of a 403, so the browser plan has to be
  // siteA's exactly: a re-record must compile the recipe the site already has.
  siteStub: SITE_A_PLANS,

  // Harness check only. The page renders `title by (editor ?? author)`, so the
  // title can only be reproduced by a template with a coalesce in it.
  siteCoalesce: {
    search: {
      url: (o, t) => `${o}/search?q=${enc(t.input.query)}`,
      itemSelector: 'li.result',
      fields: { id: '@data-id', title: 'a', url: 'a@href' },
    },
  },
}
