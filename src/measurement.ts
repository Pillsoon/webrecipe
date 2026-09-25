import { AsyncLocalStorage } from 'node:async_hooks'
import { emptyMeta, type ExecutionMeta, type StrategyName } from './types.js'

/** Decoded response-body bytes, not compressed wire bytes or HTTP headers. */
export type Cost = Pick<ExecutionMeta, 'networkRequests' | 'bytesDownloaded' | 'browserLaunches' | 'pageNavigations' | 'politenessWaitMs'> & { unreadResponseBodies: number }
interface Measurement { cost: Cost; observed: boolean }
const active = new AsyncLocalStorage<Measurement>()

/** Capture at session creation: browser event callbacks may run in another async context. */
export function costSink(): (cost: Partial<Cost>) => void {
  const measurement = active.getStore()
  return (cost) => {
    if (!measurement) return
    measurement.observed = true
    for (const key of Object.keys(cost) as Array<keyof Cost>) measurement.cost[key] += cost[key] ?? 0
  }
}

export class ExecutionFailure extends Error {
  constructor(cause: unknown, readonly meta: ExecutionMeta) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

/** One outer measurement owns nested strategies and healing; costs are never added twice. */
export async function measureResult<T extends { meta: ExecutionMeta }>(
  strategy: StrategyName, operation: () => Promise<T>,
): Promise<T> {
  if (active.getStore()) return operation()
  const measurement: Measurement = { observed: false, cost: {
    networkRequests: 0, bytesDownloaded: 0, browserLaunches: 0,
    pageNavigations: 0, politenessWaitMs: 0, unreadResponseBodies: 0,
  } }
  const started = performance.now()
  return active.run(measurement, async () => {
    const finish = (meta: ExecutionMeta): ExecutionMeta => {
      const elapsedMs = Math.round(performance.now() - started)
      return { ...meta, ...(measurement.observed ? measurement.cost : {}), elapsedMs }
    }
    try {
      const result = await operation()
      return { ...result, meta: finish(result.meta) }
    } catch (error) {
      throw new ExecutionFailure(error, finish(emptyMeta(strategy)))
    }
  })
}
