import { ExecutionFailure } from '../measurement.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Executor } from '../executor/index.js'
import type { BrowserStrategy } from '../executor/strategies/browser.js'
import { gradeGolden, type Golden } from './golden.js'
import { gradePair, planAging, querySemantics, type PairGrade } from './grade.js'
import { OracleSpecSchema, resolveOracle, type OracleSpec } from './oracle.js'
import type { BenchSet, TaskRun } from './report.js'
import type { Recipe } from '../recipes/schema.js'
import type { Task } from '../types.js'

const BenchTaskSchema = z.object({
  id: z.string(),
  set: z.enum(['controlled', 'wild']),
  site: z.string(),
  intent: z.enum(['search', 'list', 'detail']),
  input: z.record(z.union([z.string(), z.number()])),
  volatile: z.array(z.string()).optional(),
  /** A search that legitimately returns nothing; an empty golden is correct here. */
  expectEmpty: z.boolean().optional(),
  oracle: OracleSpecSchema.optional(),
})

export type BenchTask = Task & {
  set: BenchSet
  expectEmpty?: boolean
  oracle?: z.infer<typeof OracleSpecSchema>
}

export interface RunnerDeps {
  executor: Executor
  browser: BrowserStrategy
  goldenDir: string
}

export async function loadTasks(path: string): Promise<BenchTask[]> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
  return z.array(BenchTaskSchema).parse(raw) as BenchTask[]
}

function goldenPath(dir: string, taskId: string): string {
  return join(dir, `${taskId}.json`)
}

function failedRun(task: BenchTask, error: unknown): TaskRun {
  const reason = message(error)
  return {
    taskId: task.id,
    site: task.site,
    set: task.set,
    meta: error instanceof ExecutionFailure ? error.meta : {
      strategy: 'browser', latencyMs: 0, browserLaunches: 0,
      pageNavigations: 0, networkRequests: 0, bytesDownloaded: 0, llmTokens: 0, politenessWaitMs: 0,
    },
    success: false,
    reasons: [reason],
    items: [],
    threw: true,
    blocked: false,
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Explicit, never implicit: a golden is only written when this is called. */
export async function captureGoldens(tasks: BenchTask[], deps: RunnerDeps): Promise<Golden[]> {
  await mkdir(deps.goldenDir, { recursive: true })
  const goldens: Golden[] = []

  for (const task of tasks) {
    const result = await deps.browser.execute({} as Recipe, task)
    const golden: Golden = { taskId: task.id, capturedAt: new Date().toISOString(), items: result.items }
    await writeFile(goldenPath(deps.goldenDir, task.id), JSON.stringify(golden, null, 2), 'utf8')
    goldens.push(golden)
  }
  return goldens
}

export async function loadGoldens(dir: string, tasks: BenchTask[]): Promise<Golden[]> {
  const goldens: Golden[] = []
  for (const task of tasks) {
    try {
      goldens.push(JSON.parse(await readFile(goldenPath(dir, task.id), 'utf8')) as Golden)
    } catch {
      // A missing golden means this task has never been captured; skip it.
    }
  }
  return goldens
}

export async function runBaseline(tasks: BenchTask[], goldens: Golden[], deps: RunnerDeps): Promise<TaskRun[]> {
  const byId = new Map(goldens.map((g) => [g.taskId, g]))
  const runs: TaskRun[] = []

  for (const task of tasks) {
    try {
      const result = await deps.browser.execute({} as Recipe, task)
      const golden = byId.get(task.id)
      const grade = golden
        ? gradeGolden(golden, result.items, task.volatile)
        : { schema: true, semantic: true, ordering: null, reasons: [] }
      runs.push({
        taskId: task.id, site: task.site, set: task.set, meta: result.meta,
        success: grade.schema && grade.semantic, schema: grade.schema, ordering: grade.ordering,
        reasons: grade.reasons,
        items: result.items, threw: false, blocked: false,
      })
    } catch (err) {
      runs.push(failedRun(task, err))
    }
  }
  return runs
}

async function runBenchmark(tasks: BenchTask[], goldens: Golden[], deps: RunnerDeps): Promise<TaskRun[]> {
  const byId = new Map(goldens.map((g) => [g.taskId, g]))
  const runs: TaskRun[] = []

  for (const task of tasks) {
    try {
      const outcome = await deps.executor.run(task)
      const golden = byId.get(task.id)
      const grade = golden
        ? gradeGolden(golden, outcome.items, task.volatile)
        : { schema: true, semantic: true, ordering: null, reasons: [] }
      runs.push({
        taskId: task.id, site: task.site, set: task.set, meta: outcome.meta,
        success: grade.schema && grade.semantic, schema: grade.schema, ordering: grade.ordering,
        reasons: [...outcome.reasons, ...grade.reasons],
        items: outcome.items, threw: false, blocked: outcome.blocked,
      })
    } catch (err) {
      runs.push(failedRun(task, err))
    }
  }
  return runs
}

export interface PairedRun {
  task: BenchTask
  oracle: OracleSpec
  baseline: TaskRun
  engine: TaskRun
  grade: PairGrade
  aging: string | null
}

/** An engine that threw produced no items to grade; scoring it against an
 * empty reference (an `expectEmpty` baseline, an empty golden) would read as a
 * pass, which is worse than the failure it stands in for. Decided before
 * either mode's layer two runs, so the two never diverge on it. */
function engineException(engine: TaskRun): Pick<PairGrade, 'entities' | 'query' | 'ordering' | 'reasons'> {
  return {
    entities: false, query: null, ordering: null,
    reasons: engine.reasons.length > 0 ? engine.reasons : ['engine threw'],
  }
}

/**
 * Grades by mode, because the two modes ask different questions.
 *
 * `golden` asks whether the engine matches a stored capture. A live browser
 * that times out says nothing about that, so it must not gate it — routing
 * every mode through `gradePair` would have excluded a task whose engine
 * matched its golden exactly, on the strength of an unrelated timeout. The
 * baseline is still run, because the speedup figure needs it.
 *
 * `paired-live` asks whether the engine matches the browser beside it, so there
 * the baseline's validity is exactly the right gate.
 */
export function gradeByOracle(
  oracle: OracleSpec,
  stored: Golden | undefined,
  baseline: TaskRun,
  engine: TaskRun,
  task: BenchTask,
): PairGrade {
  if (oracle.mode === 'paired-live') {
    const grade = gradePair(baseline.items, engine.items, oracle, {
      threw: baseline.threw,
      expectEmpty: task.expectEmpty === true,
      input: task.input,
    })
    return grade.usable && engine.threw ? { ...grade, ...engineException(engine) } : grade
  }

  if (stored === undefined) {
    return {
      usable: false, validityReason: 'no stored golden for this task', excludeReason: 'no-golden',
      entities: null, query: null, ordering: null,
      reasons: ['no stored golden for this task'],
    }
  }

  if (engine.threw) {
    return { usable: true, validityReason: null, excludeReason: null, ...engineException(engine) }
  }

  const graded = gradeGolden(stored, engine.items, task.volatile, oracle.compare.fields)
  const query = querySemantics(engine.items, task.input, oracle)

  return {
    usable: true,
    validityReason: null,
    excludeReason: null,
    entities: graded.schema && graded.semantic,
    query: query.match,
    ordering: oracle.compare.ordering === 'ignore' ? null : graded.ordering,
    reasons: [...graded.reasons, ...query.reasons],
  }
}

/**
 * Runs both sides of each task before moving to the next, alternating which
 * goes first.
 *
 * Running the whole baseline and then the whole engine put every engine
 * measurement later in time than its baseline, which on a job board cost 25
 * points of apparent correctness. Pairing removes that; alternating removes the
 * residual bias of one side always going first. Comparison happens once both
 * halves are in hand, so order within a pair does not decide which is the
 * reference.
 */
export async function runPairs(
  tasks: BenchTask[],
  goldens: Golden[],
  deps: RunnerDeps,
  oracles: Record<string, unknown>,
): Promise<PairedRun[]> {
  const byId = new Map(goldens.map((g) => [g.taskId, g]))
  const pairs: PairedRun[] = []

  for (const [index, task] of tasks.entries()) {
    const oracle = resolveOracle(
      OracleSpecSchema.optional().parse(oracles[task.site]),
      task.oracle,
    )

    const engineFirst = index % 2 === 1
    let baseline: TaskRun
    let engine: TaskRun

    if (engineFirst) {
      engine = (await runBenchmark([task], goldens, deps))[0]!
      baseline = (await runBaseline([task], goldens, deps))[0]!
    } else {
      baseline = (await runBaseline([task], goldens, deps))[0]!
      engine = (await runBenchmark([task], goldens, deps))[0]!
    }

    const grade = gradeByOracle(oracle, byId.get(task.id), baseline, engine, task)
    const aging = oracle.mode === 'paired-live'
      ? planAging(byId.get(task.id)?.items, baseline.items, oracle)
      : null
    pairs.push({ task, oracle, baseline, engine, grade, aging })
  }
  return pairs
}
