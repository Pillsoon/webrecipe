import { startFixture, sendHtml, type FixtureServer } from './harness.js'
import { page, ssrHandler } from './ssr.js'

/**
 * Tells the engine's HTTP client from the engine's browser.
 *
 * Not the user agent: `src/browser/session.ts` gives the headless browser the
 * same `webrecipe/` string the fetch client sends, so refusing on that
 * would refuse both halves and prove nothing. `sec-ch-ua` is a client hint only
 * a browser emits, which is also what a real challenge wall keys on.
 */
/** Client hints are sent by a browser and by nothing else; `fetch` omits them. */
export const isBrowser = (req: { headers: Record<string, unknown> }): boolean =>
  req.headers['sec-ch-ua'] !== undefined

/**
 * bandcamp's shape: a 200 whose body is an interstitial rather than the page,
 * padded to the ~3 KB a real one weighs so the size is not what gives it away.
 */
const CHALLENGE = page(
  'Client Challenge',
  `<div id="challenge">${'<p>Checking your browser before you continue.</p>'.repeat(64)}</div>`,
)

/**
 * The two ways a site refuses a compiled recipe while still serving a browser.
 *
 * At `v1` it is loc.gov: a non-browser client gets a 403 and a browser gets
 * siteA's page. At `v2` it is bandcamp: everyone gets a 200 carrying the
 * challenge page instead of results.
 */
export function startRefusingFixture(): Promise<FixtureServer> {
  return startFixture('siteRefusing', (req, res, server) => {
    if (server.version === 'v2') {
      sendHtml(res, CHALLENGE)
      return
    }

    if (!isBrowser(req)) {
      sendHtml(res, '<html><body>Forbidden</body></html>', 403)
      return
    }

    ssrHandler(req, res, server)
  })
}

/**
 * musicbrainz's shape, and the one rule (b) cannot see: a 200 carrying a
 * challenge page, served only to the client without `sec-ch-ua`. Short on
 * purpose — the real one weighs 1.4 KB — because nothing here may key on the
 * body, only on the browser agreeing with the recipe it already had.
 */
const VERIFYING =
  '<html><head><title>Verifying your browser</title></head><body>Verifying your browser</body></html>'

/**
 * Serves the engine's client a 200 challenge page and the browser siteA's real
 * page, so every re-record compiles the very same recipe again.
 */
export function startStubFixture(): Promise<FixtureServer> {
  return startFixture('siteStub', (req, res, server) => {
    if (!isBrowser(req)) {
      sendHtml(res, VERIFYING)
      return
    }

    ssrHandler(req, res, server)
  })
}
