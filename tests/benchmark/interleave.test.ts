import { describe, it, expect } from 'vitest'
import { runPairs } from '../../src/benchmark/runner.js'
import type { BenchTask } from '../../src/benchmark/runner.js'
import { emptyMeta, type Result } from '../../src/types.js'

const tasks: BenchTask[] = [1, 2, 3].map((n) => ({
  id: `t${n}`, set: 'wild', site: 's', intent: 'search', input: { query: String(n) },
}))

function tracker() {
  const order: string[] = []
  return {
    order,
    browser: {
      execute: async (_r: unknown, t: { id: string }): Promise<Result> => {
        order.push(`baseline:${t.id}`)
        return { items: [{ id: t.id }], meta: { ...emptyMeta('browser'), browserLaunches: 1 } }
      },
    },
    executor: {
      run: async (t: { id: string }) => {
        order.push(`engine:${t.id}`)
        return { items: [{ id: t.id }], meta: emptyMeta('http-html'), recipeUsed: true, fellBack: false, reasons: [] }
      },
    },
  }
}

describe('runPairs', () => {
  it('alternates which side goes first, so neither is always later', async () => {
    const t = tracker()
    await runPairs(tasks, [], { executor: t.executor as never, browser: t.browser as never, goldenDir: '' }, {})
    expect(t.order).toEqual([
      'baseline:t1', 'engine:t1',
      'engine:t2', 'baseline:t2',
      'baseline:t3', 'engine:t3',
    ])
  })

  it('returns one pair per task, each carrying its resolved oracle', async () => {
    const t = tracker()
    const pairs = await runPairs(tasks, [], { executor: t.executor as never, browser: t.browser as never, goldenDir: '' }, {})
    expect(pairs.map((p) => p.task.id)).toEqual(['t1', 't2', 't3'])
    expect(pairs[0]!.oracle.mode).toBe('golden')
  })

  it('applies the site oracle, and a task override over it', async () => {
    const t = tracker()
    const withOverride = [
      { ...tasks[0]!, site: 'vol' },
      { ...tasks[1]!, site: 'vol', oracle: { mode: 'golden' as const } },
    ]
    const pairs = await runPairs(withOverride, [], {
      executor: t.executor as never, browser: t.browser as never, goldenDir: '',
    }, { vol: { mode: 'paired-live', volatility: 'high' } })
    expect(pairs[0]!.oracle.mode).toBe('paired-live')
    expect(pairs[1]!.oracle.mode).toBe('golden')
    expect(pairs[1]!.oracle.volatility).toBe('high')
  })
})
