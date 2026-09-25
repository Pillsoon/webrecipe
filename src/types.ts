export type Intent = 'search' | 'list' | 'detail'

export interface Task {
  id: string
  site: string
  intent: Intent
  input: Record<string, string | number>
  /** Fields whose values change between runs; golden-compared by presence and type only. */
  volatile?: string[]
}

export type Item = Record<string, string | number | null>

export type StrategyName = 'http-json' | 'http-html' | 'warm-browser' | 'browser'

export interface ExecutionMeta {
  strategy: StrategyName
  /** Legacy wait-excluded timing. Use elapsedMs for user-visible task duration. */
  latencyMs: number
  /** Wall time at the execution boundary; absent in historical records. */
  elapsedMs?: number
  /** Bodies unavailable after closing the page; bytes are a lower bound when nonzero. */
  unreadResponseBodies?: number
  browserLaunches: number
  pageNavigations: number
  networkRequests: number
  bytesDownloaded: number
  /**
   * Tokens an agent would have to read to get this task's answer from this
   * strategy's output: the TSV emission `webrecipe fetch` prints by default for an
   * http run, the page's accessibility snapshot for a browser run. The snapshot
   * rather than the visible text because every oracle compares `url`, and
   * innerText carries no hrefs — a reading that cannot yield the answer is not
   * the task's cost.
   * On a browser run 0 means the page read failed: a rendered page is never empty.
   */
  llmTokens: number
  /**
   * Time spent in explicit rate-limit spacing and retry backoff sleeps.
   * Legacy latency excludes these waits. elapsedMs includes waits, queue time,
   * extraction and cleanup; use it for user-perceived execution duration.
   */
  politenessWaitMs: number
}

export interface Result {
  items: Item[]
  meta: ExecutionMeta
  /** Raw parsed response, used by the validator for fingerprinting. Absent for browser runs. */
  payload?: unknown
  /** The status actually observed. Absent for browser runs. */
  status?: number
}

export interface Strategy {
  readonly name: StrategyName
  execute(recipe: import('./recipes/schema.js').Recipe, task: Task): Promise<Result>
}

/**
 * What a task cost in total, not what the attempt that happened to answer it
 * cost. A run that tried a recipe, lost, fell back to a browser and re-recorded
 * on the way paid for all three; reporting only the last describes a cheaper
 * run than the one that happened.
 *
 * `answered` is the attempt that produced the items, so it keeps the strategy
 * name and the token count: the agent reads one answer, not three.
 */
export function addMeta(answered: ExecutionMeta, ...spent: ExecutionMeta[]): ExecutionMeta {
  return spent.reduce((total, one) => ({
    ...total,
    latencyMs: total.latencyMs + one.latencyMs,
    browserLaunches: total.browserLaunches + one.browserLaunches,
    pageNavigations: total.pageNavigations + one.pageNavigations,
    networkRequests: total.networkRequests + one.networkRequests,
    bytesDownloaded: total.bytesDownloaded + one.bytesDownloaded,
    politenessWaitMs: total.politenessWaitMs + one.politenessWaitMs,
  }), answered)
}

export function emptyMeta(strategy: StrategyName): ExecutionMeta {
  return {
    strategy,
    latencyMs: 0,
    browserLaunches: 0,
    pageNavigations: 0,
    networkRequests: 0,
    bytesDownloaded: 0,
    llmTokens: 0,
    politenessWaitMs: 0,
  }
}
