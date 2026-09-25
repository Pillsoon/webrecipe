import { costSink } from '../measurement.js'
import { parseRobots, isPathAllowed, type RobotsRules } from './robots.js'
import { UserError } from '../local.js'

export const DEFAULT_USER_AGENT = 'webrecipe/0.1 (+https://github.com/Pillsoon/webrecipe)'

export interface FetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface PoliteResponse {
  status: number
  headers: Record<string, string>
  body: string
  bytesDownloaded: number
  /** The URL that answered, after redirects: relative links in the body resolve against it. */
  url: string
  /** Time spent waiting on the rate limiter, so callers can report it separately. */
  waitedMs: number
}

export interface PolitenessOptions {
  userAgent?: string
  minIntervalMs?: number
  maxRetries?: number
  timeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  fetchImpl?: typeof fetch
  /** Refuse, before requesting it, any URL or redirect target robots.txt disallows. */
  enforceRobots?: boolean
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

interface HostState {
  lastRequestAt: number
  intervalMs: number
  robots: RobotsRules | null
  /** Serialises all requests to this host — the "no parallel requests" rule. */
  queue: Promise<unknown>
}

export class PolitenessLayer {
  private readonly userAgent: string
  private readonly minIntervalMs: number
  private readonly maxRetries: number
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly fetchImpl: typeof fetch
  private readonly enforceRobots: boolean
  private readonly hosts = new Map<string, HostState>()

  constructor(opts: PolitenessOptions = {}) {
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT
    this.minIntervalMs = opts.minIntervalMs ?? 1000
    this.maxRetries = opts.maxRetries ?? 2
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.now = opts.now ?? (() => Date.now())
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.enforceRobots = opts.enforceRobots ?? false
  }

  private state(host: string): HostState {
    let s = this.hosts.get(host)
    if (!s) {
      s = { lastRequestAt: -Infinity, intervalMs: this.minIntervalMs, robots: null, queue: Promise.resolve() }
      this.hosts.set(host, s)
    }
    return s
  }

  private async robotsFor(url: URL): Promise<RobotsRules> {
    const s = this.state(url.host)
    if (s.robots) return s.robots
    const res = await this.raw(new URL('/robots.txt', url.origin).toString())
    s.robots = res.status === 200 ? parseRobots(res.body) : { allow: [], disallow: [], crawlDelaySec: null }
    if (s.robots.crawlDelaySec !== null) {
      s.intervalMs = Math.max(s.intervalMs, s.robots.crawlDelaySec * 1000)
    }
    return s.robots
  }

  async isAllowed(url: string): Promise<boolean> {
    const u = new URL(url)
    const rules = await this.robotsFor(u)
    return isPathAllowed(rules, u.pathname + u.search)
  }

  async crawlDelayMs(url: string): Promise<number> {
    const u = new URL(url)
    await this.robotsFor(u)
    return this.state(u.host).intervalMs
  }

  private async refuseDisallowed(url: string): Promise<void> {
    if (!(await this.isAllowed(url))) throw new UserError('ROBOTS_DISALLOWED', `robots.txt disallows ${url}`)
  }

  /** Bypasses the rate limiter; used only to fetch robots.txt itself. */
  private async raw(url: string, opts: FetchOptions = {}, check?: (url: string) => Promise<void>): Promise<PoliteResponse> {
    const charge = costSink()
    let current = url
    let method = opts.method ?? 'GET'
    let requestBody = opts.body
    const headers = new Headers({ 'user-agent': this.userAgent, ...(opts.headers ?? {}) })
    for (let redirects = 0; ; redirects++) {
      // Before every hop, not only the first: an allowed URL may redirect to a disallowed one.
      await check?.(current)
      charge({ networkRequests: 1 })
      const res = await this.fetchImpl(current, {
        method, headers: Object.fromEntries(headers.entries()), body: requestBody, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs),
      })
      let buffer: Buffer
      try { buffer = Buffer.from(await res.arrayBuffer()) }
      catch (error) { charge({ unreadResponseBodies: 1 }); throw error }
      charge({ bytesDownloaded: buffer.byteLength })
      const location = res.headers.get('location')
      if ([301, 302, 303, 307, 308].includes(res.status) && location !== null) {
        if (redirects >= 20) throw new Error('too many redirects')
        const next = new URL(location, current)
        if (!['http:', 'https:'].includes(next.protocol)) throw new Error('unsupported redirect protocol')
        if (next.origin !== new URL(current).origin) {
          headers.delete('authorization'); headers.delete('cookie'); headers.delete('proxy-authorization')
        }
        if ((res.status === 303 && method !== 'HEAD') || ([301, 302].includes(res.status) && method === 'POST')) {
          method = 'GET'; requestBody = undefined
          for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(name)
        }
        current = next.toString()
        continue
      }
      return {
        status: res.status, headers: Object.fromEntries(res.headers.entries()), url: current,
        body: buffer.toString('utf8'), bytesDownloaded: buffer.byteLength, waitedMs: 0,
      }
    }
  }

  async fetch(url: string, opts: FetchOptions = {}): Promise<PoliteResponse> {
    const u = new URL(url)
    const s = this.state(u.host)
    // Chain onto the host queue so two callers can never be in flight at once.
    const run = s.queue.then(() => this.fetchSerialised(u, opts))
    s.queue = run.catch(() => undefined)
    return run
  }

  private async fetchSerialised(u: URL, opts: FetchOptions): Promise<PoliteResponse> {
    // Loopback is our own fixture server; there is nobody to be polite to.
    const throttled = !LOOPBACK.test(u.host)
    if (throttled) await this.robotsFor(u)

    const s = this.state(u.host)
    let waitedMs = 0

    for (let attempt = 0; ; attempt++) {
      if (throttled) {
        const waitFor = s.lastRequestAt + s.intervalMs - this.now()
        if (waitFor > 60_000) throw new Error(`rate limit requires ${Math.ceil(waitFor / 1000)}s; retry later`)
        if (waitFor > 0) {
          await this.sleep(waitFor)
          waitedMs += waitFor
          costSink()({ politenessWaitMs: waitFor })
        }
      }

      s.lastRequestAt = this.now()
      const res = await this.raw(u.toString(), opts, this.enforceRobots ? (url) => this.refuseDisallowed(url) : undefined)

      if (res.status !== 429 || attempt >= this.maxRetries) return { ...res, waitedMs }

      const retryAfter = Number(res.headers['retry-after'])
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : s.intervalMs * 2 ** (attempt + 1)
      if (backoff > 60_000) throw new Error(`Retry-After requires ${Math.ceil(backoff / 1000)}s; retry later`)
      await this.sleep(backoff)
      waitedMs += backoff
      costSink()({ politenessWaitMs: backoff })
    }
  }
}
