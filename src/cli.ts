#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { appendUsage, readUsage, summarizeUsage, recipeDigest, type UsageEvent } from './usage.js'
import { emptyMeta } from './types.js'
import { measureResult, ExecutionFailure } from './measurement.js'
import { Command } from 'commander'
import { gzipSync, gunzipSync } from 'node:zlib'
import { writeFile, readFile, readdir, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { UserError, localPaths, siteName, intentName, publicUrl, verificationWarnings } from './local.js'
import { buildEngine } from './wiring.js'
import { formatItems } from './executor/format.js'
import { learn, formatLearn } from './authoring/learn.js'
import { teach } from './authoring/teach.js'
import { PLANS } from '../benchmark/plans.js'
import { ORACLES } from '../benchmark/oracles.js'
import { loadTasks, loadGoldens, captureGoldens, runBaseline, runPairs } from './benchmark/runner.js'
import { summarize, summarizePairs, formatReport, levelOf, failedPairs, excludedBy, type TaskRun } from './benchmark/report.js'
import { screen, formatScreen } from './benchmark/screen.js'
import { checkRecipes, formatHealth } from './benchmark/health.js'
import { runVerificationCases, PAGINATION_CASES } from './benchmark/verification-cases.js'
import { buildCases, runDiscovery, formatDiscovery, DISCOVERY_DOMAINS, HELD_OUT_DOMAINS } from './benchmark/discovery.js'
import { formatLayers } from './benchmark/verification-matrix.js'
import { captureDom } from './authoring/snapshot.js'
import { readUrl, methodStore } from './read.js'
import { PolitenessLayer, DEFAULT_USER_AGENT } from './net/politeness.js'
import { visibleRuns, LabelSchema, type Label } from './benchmark/labels.js'
import { scoreSnapshot, formatCorpus, type SnapshotReport } from './benchmark/selector-score.js'
import { WILD_ORIGINS, StaticSiteResolver } from './sites.js'
import { startAllFixtures } from '../benchmark/fixtures.js'
import { fetchTask, listTasks } from './tasks.js'
import { serveMcp } from './mcp.js'
import type { Intent } from './types.js'

const RECIPE_DIR = join(process.cwd(), 'recipes')
const GOLDEN_DIR = join(process.cwd(), 'benchmark', 'goldens')
const TASKS = join(process.cwd(), 'benchmark', 'tasks.json')
const DOM_DIR = join(process.cwd(), 'benchmark', 'dom')
const tasksFile = (opts: { tasks?: string }): string => opts.tasks ?? TASKS

function inputFrom(opts: { query?: string; id?: string; page?: string }): Record<string, string | number> {
  const input: Record<string, string | number> = {}
  if (opts.query !== undefined) input.query = opts.query
  if (opts.id !== undefined) input.id = opts.id
  if (opts.page !== undefined) {
    if (!/^[1-9]\d*$/.test(opts.page) || !Number.isSafeInteger(Number(opts.page))) throw new UserError('INVALID_INPUT', 'page must be a positive integer')
    input.page = Number(opts.page)
  }
  return input
}

/** `site/intent`, the one handle a saved recipe has. */
function taskRef(value: string): { site: string; intent: Intent } {
  const at = value.indexOf('/')
  if (at < 1 || at === value.length - 1) throw new UserError('INVALID_INPUT', 'task must be site/intent, for example hn/list')
  return { site: siteName(value.slice(0, at)), intent: intentName(value.slice(at + 1)) }
}

/** Reports whether robots.txt permits each wild site's search path. */
async function robotsStatus(net: ReturnType<typeof buildEngine>['net']): Promise<Record<string, string>> {
  const status: Record<string, string> = {}

  for (const [site, origin] of Object.entries(WILD_ORIGINS)) {
    const plan = PLANS[site]?.search
    if (!plan) continue
    const url = plan.url(origin, { id: 'probe', site, intent: 'search', input: { query: 'probe' } })
    try {
      status[site] = (await net.isAllowed(url))
        ? 'allowed'
        : 'disallowed for crawlers (user-agent posture, see spec section 6)'
    } catch (err) {
      status[site] = `unknown (${err instanceof Error ? err.message : String(err)})`
    }
  }
  return status
}

const program = new Command().name('webrecipe').description('save how to read a public web page once, then fetch it over plain HTTP')
  .option('--data-dir <path>', 'where recipes are kept (default: WEBRECIPE_DATA_DIR or ~/.webrecipe)')
  .option('--no-log', 'disable local usage logging for this command')
  .exitOverride()

let usage: UsageEvent | undefined
let usageStarted = 0
let usageRoot = ''
async function writeUsage(event: UsageEvent) {
  try { await appendUsage(usageRoot, event); return true }
  catch (error) { console.error(`LOG_WRITE_FAILED: ${error instanceof Error ? error.message : error}`); return false }
}
program.hook('preAction', async (_program, command) => {
  if (command.parent !== program || !['fetch','inspect','save','read'].includes(command.name()) || !program.opts().log) return
  const opts = command.opts()
  // Positional handles are read leniently here; the action validates them and reports.
  const [site, intent] = command.name() === 'fetch' || command.name() === 'save' ? String(command.args[0] ?? '').split('/') : []
  const url = command.name() === 'inspect' ? command.args[0] : opts.url
  usageRoot = localPaths(program.opts().dataDir).root
  usageStarted = performance.now()
  usage = { version: 1, at: new Date().toISOString(), id: randomUUID(), event: 'start', command: command.name(),
    site, intent, url,
    input: { query: opts.query, id: opts.id, page: opts.page } }
  if (site && intent) {
    try { usage.recipeBefore = await recipeDigest(usageRoot,site,intent) }
    catch { /* Invalid inputs are reported by the action; no recipe snapshot available. */ }
  }
  await writeUsage(usage)
})

program.command('logs').description('summarize local usage; includes failures and unfinished commands')
  .option('--days <days>', 'rolling window', '7')
  .action(async opts => {
    const days = Number(opts.days)
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new UserError('INVALID_INPUT', 'days must be 1..365')
    const root = localPaths(program.opts().dataDir).root
    const {events,malformed} = await readUsage(root,days)
    console.log(JSON.stringify({directory:join(root,'logs'),days,malformed,...summarizeUsage(events)},null,2))
  })

program.command('feedback').description('mark a logged fetch as correct or wrong after checking the source')
  .requiredOption('--run <id>')
  .requiredOption('--verdict <verdict>', 'correct or wrong')
  .option('--note <note>')
  .action(async opts => {
    if (!['correct','wrong'].includes(opts.verdict)) throw new UserError('INVALID_INPUT', 'verdict must be correct or wrong')
    const root = localPaths(program.opts().dataDir).root
    const {events} = await readUsage(root,365)
    if (!events.some(e => e.id === opts.run && e.event === 'finish' && e.command === 'fetch')) throw new UserError('INVALID_INPUT', 'run id not found in the last year of logs')
    await appendUsage(root,{version:1,at:new Date().toISOString(),id:opts.run,event:'feedback',verdict:opts.verdict,note:opts.note})
    console.log('Feedback saved locally.')
  })

program.command('setup').description('install the Chromium browser used by inspect, save and browser fallback')
  .action(async () => {
    const require = createRequire(import.meta.url)
    const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' })
      child.on('error', reject)
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`browser installation failed (${code})`)))
    })
  })

program.command('list').description('list saved recipes and where they are stored')
  .action(async () => {
    const { root, tasks } = await listTasks(program.opts().dataDir)
    console.log(`Data: ${root}`)
    for (const task of tasks) console.log(task)
    if (!tasks.length) console.log('No saved recipes yet. Start with: webrecipe inspect <URL>')
  })

program.command('mcp').description('serve inspect, save, fetch and list as MCP tools over stdio')
  .action(async () => { await serveMcp(program.opts().dataDir) })

program
  .command('read')
  .description('read any public URL: server HTML when it carries the text, a browser when it does not; remembers which worked per URL shape')
  .requiredOption('--url <url>')
  .option('--format <format>', 'text or json', 'text')
  .action(async (opts) => {
    if (opts.format !== 'text' && opts.format !== 'json') throw new UserError('INVALID_INPUT', '--format must be text or json')
    const url = publicUrl(opts.url).toString()
    const net = new PolitenessLayer({ userAgent: DEFAULT_USER_AGENT })
    const result = await readUrl(url, {
      isAllowed: (u) => net.isAllowed(u),
      fetch: (u) => net.fetch(u),
      render: async (u) => (await captureDom(u)).html,
      methods: methodStore(localPaths(program.opts().dataDir).root),
    })
    if (usage) Object.assign(usage, { method: result.method, reason: result.reason, textChars: result.text.length })
    if (opts.format === 'json') console.log(JSON.stringify({ ok: true, runId: usage?.id, ...result }))
    else console.log(`${result.title ? `# ${result.title}\n` : ''}(${result.method}: ${result.reason})\n\n${result.text}`)
  })

program
  .command('fetch')
  .description('fetch a saved recipe: plain HTTP when the recipe holds, a browser when it does not')
  .argument('<task>', 'site/intent, as saved')
  .option('--query <query>')
  .option('--id <id>')
  .option('--page <page>')
  .option('--json', 'one JSON object on stdout (default: TSV)')
  .option('--no-heal', 'do not recompile the recipe on fallback')
  .action(async (task: string, opts) => {
    const { site, intent } = taskRef(task)
    const input = inputFrom(opts)
    const { outcome, verification, warnings } = await fetchTask(site, intent, input, { dataDir: program.opts().dataDir, heal: opts.heal, runId: 'cli' })
    if (usage) Object.assign(usage, {meta:outcome.meta, items:outcome.items.length, reasons:outcome.reasons, recipeUsed:outcome.recipeUsed, fellBack:outcome.fellBack, blocked:outcome.blocked})
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, runId: usage?.id, items: outcome.items, meta: outcome.meta, verification, warnings }))
    } else {
      console.error(`Strategy: ${outcome.meta.strategy} (${levelOf(outcome.meta.strategy)})`)
      console.error(`Verification: ${verification.status}`)
      for (const warning of verificationWarnings(verification)) console.error(`  ${warning}`)
      console.error(`Browser launches: ${outcome.meta.browserLaunches}`)
      console.error(`Elapsed: ${outcome.meta.elapsedMs}ms`)
      console.error(`Requests: ${outcome.meta.networkRequests}`)
      if (outcome.reasons.length) console.error(`Fallback: ${outcome.reasons.join('; ')}`)
      console.log(formatItems(outcome.items, 'tsv'))
    }
  })

program
  .command('inspect')
  .description('open one page in a browser and print the repeated structures and field selectors to choose from')
  .argument('<url>')
  .option('--depth <n>', 'how many item candidates to detail', '10')
  .action(async (url: string, opts) => {
    publicUrl(url)
    const depth = Number(opts.depth)
    if (!Number.isInteger(depth) || depth < 1 || depth > 50) throw new UserError('INVALID_INPUT', 'depth must be between 1 and 50')
    const measured = await measureResult('browser', async () => ({report: await learn(url, depth), meta: emptyMeta('browser')}))
    if (usage) usage.meta = measured.meta
    console.log(formatLearn(measured.report))
  })

program
  .command('save')
  .description('save the item selector and fields you chose, then compile an HTTP recipe from them')
  .argument('<task>', 'site/intent, for example hn/list; intent is search, list or detail')
  .requiredOption('--url <url>', 'the page, with any --query/--id/--page value written into it')
  .requiredOption('--items <selector>')
  .requiredOption('--field <name=spec...>', 'repeatable, e.g. --field title="a.title" --field url="a.title@href"')
  .option('--query <query>')
  .option('--id <id>')
  .option('--page <page>')
  .option('--skip-semantic-verification', 'do not spend requests probing what the contract requires; the check stays required and untested')
  .action(async (task: string, opts) => {
    const { site, intent } = taskRef(task)
    publicUrl(opts.url)
    const paths = localPaths(program.opts().dataDir)
    const fields = Object.fromEntries((opts.field as string[]).map((pair) => {
      const at = pair.indexOf('=')
      if (at < 1) throw new Error(`--field needs name=spec, got ${JSON.stringify(pair)}`)
      return [pair.slice(0, at), pair.slice(at + 1)]
    }))

    const result = await measureResult('browser', async () => ({...await teach({
      site,
      intent,
      url: opts.url,
      input: inputFrom(opts),
      itemSelector: opts.items,
      fields,
      planDir: paths.plans,
      recipeDir: paths.recipes,
      skipSemanticVerification: opts.skipSemanticVerification === true,
    }), meta: emptyMeta('browser')}))

    if (usage) Object.assign(usage, {meta:result.meta, recipeStrategy:result.recipe?.strategy.type ?? null, refused:result.refused})
    console.log(`sample: ${JSON.stringify(result.sample)}`)
    console.log(`plan:   ${result.planPath}`)
    console.log(`url:    ${result.plan.urlTemplate}`)
    console.log(result.recipe === null
      ? `recipe: none — ${result.refused}\n        the plan is stored, so fetch falls back to a browser and still answers`
      : `recipe: ${result.recipe.strategy.type} at ${result.recipe.request.path}`)

    const contract = result.plan.verification?.contract
    if (contract) {
      console.log(`contract: ${contract.required.join(', ')}`)
      // Reported apart from `refused`, which is about compiling a recipe: a
      // verification that came back untested is not a compile failure.
      const honored = result.plan.verification?.evidence.query_honored
      if (honored) console.log(`query_honored: ${honored.status}${honored.reason ? ` — ${honored.reason}` : ''}`)
      else if (contract.required.includes('query_honored')) console.log('query_honored: not_tested — probing was skipped')
    }
  })

const bench = program.command('bench').description('benchmark commands')

bench
  .command('capture')
  .description('record golden results with the browser; overwrites existing goldens')
  .option('--only <substring>', 'restrict to task ids containing this substring')
  .option('--tasks <path>', 'use a different task file')
  .action(async (opts) => {
    const fixtures = await startAllFixtures()
    const engine = buildEngine({
      recipeDir: RECIPE_DIR, plans: PLANS, heal: false, origins: fixtures.origins,
    })
    try {
      const all = await loadTasks(tasksFile(opts))
      const tasks = opts.only ? all.filter((t) => t.id.includes(opts.only)) : all

      const goldens = await captureGoldens(tasks, {
        executor: engine.executor, browser: engine.browser, goldenDir: GOLDEN_DIR,
      })

      const hasValues = (g: { items: Array<Record<string, unknown>> }): boolean =>
        g.items.some((item) => Object.values(item).some((v) => v !== null && v !== undefined && v !== ''))
      const expectedEmpty = new Set(tasks.filter((t) => t.expectEmpty).map((t) => t.id))
      const empty = goldens.filter((g) => !expectedEmpty.has(g.taskId) && (g.items.length === 0 || !hasValues(g)))
      console.log(`captured ${goldens.length} goldens`)
      if (empty.length > 0) {
        console.log(`\n${empty.length} golden(s) have no field values — the browser plan is wrong for these:`)
        for (const g of empty) console.log(`  ${g.taskId}`)
        console.log('\nFix benchmark/plans.ts and recapture. An empty golden passes forever.')
        process.exitCode = 1
      }
    } finally {
      await engine.warm.close()
      await fixtures.close()
    }
  })

bench
  .command('discovery')
  .description('run the frozen verifier over real sites and record where it and an independent judgement disagree')
  .option('--tasks <paths...>', 'task files to draw the corpus from', ['benchmark/heldout.json', 'benchmark/heldout3.json', 'benchmark/heldout4.json'])
  .option('--out <dir>', 'where to write runs.jsonl, skips.jsonl and the raw evidence')
  .option('--held-out', 'run the untouched domains instead; only after a verifier change')
  .option('--domains <names...>', 'restrict to some of them, for a first pass')
  .action(async (opts) => {
    const all = opts.heldOut === true ? HELD_OUT_DOMAINS : DISCOVERY_DOMAINS
    const domains = opts.domains === undefined ? all : all.filter((d) => (opts.domains as string[]).includes(d))
    if (domains.length === 0) throw new UserError('INVALID_INPUT', `no such domain in this set; it holds ${all.join(', ')}`)
    const tasks = (await Promise.all((opts.tasks as string[]).map(loadTasks))).flat()
    const cases = buildCases(tasks, domains)
    const out = opts.out ?? join(process.cwd(), 'benchmark', 'results', `discovery-${new Date().toISOString().slice(0, 10)}${opts.heldOut === true ? '-heldout' : ''}`)
    console.error(`${cases.length} learned tasks over ${domains.length} domains -> ${out}`)
    const { records, skips } = await runDiscovery(cases, {
      outDir: out,
      onRecord: (r) => console.error(`  ${r.finalStatus.padEnd(19)} ${r.judgement.padEnd(13)} ${r.site} ${r.taskId}`),
      onSkip: (s) => console.error(`  ${s.reason.padEnd(19)} ${'-'.padEnd(13)} ${s.site} ${s.taskId}`),
    })
    console.log(formatDiscovery(records, skips, cases.length))
  })

bench
  .command('verification')
  .description("count how often the verifier's verdict and an independent oracle disagree, over the fixture cases")
  .action(async () => {
    console.log('== query cases ==\n')
    console.log(formatLayers(await runVerificationCases(), [
      { label: 'query_honored', required: ['query_honored'] },
      { label: 'query_honored + lexical_query_consistency', required: ['query_honored', 'lexical_query_consistency'] },
    ]))
    // A denominator of its own: these fixtures exercise a page control and the
    // query ones do not, so a pooled rate would be over a population nobody chose.
    console.log('\n\n== pagination cases ==\n')
    console.log(formatLayers(await runVerificationCases(PAGINATION_CASES), [
      { label: 'pagination_honored', required: ['pagination_honored'] },
    ]))
  })

bench
  .command('screen')
  .description('measure one listing URL before a plan exists: engine page vs browser page, render latency, largest repeated structure')
  .requiredOption('--url <url>')
  .action(async (opts) => {
    console.log(formatScreen(await screen(opts.url)))
  })

async function readSnapshot(name: string): Promise<string> {
  return gunzipSync(await readFile(join(DOM_DIR, `${name}.html.gz`))).toString('utf8')
}

async function readLabel(name: string): Promise<Label> {
  return LabelSchema.parse(JSON.parse(await readFile(join(DOM_DIR, `${name}.label.json`), 'utf8')))
}

bench
  .command('snapshot')
  .description('save one rendered DOM, so a hand-written label keeps its meaning')
  .requiredOption('--url <url>')
  .requiredOption('--as <name>', 'file name to save under, without an extension')
  .action(async (opts) => {
    const { html, capturedAt } = await captureDom(opts.url)
    await mkdir(DOM_DIR, { recursive: true })
    const path = join(DOM_DIR, `${opts.as}.html.gz`)
    const packed = gzipSync(Buffer.from(html, 'utf8'))
    await writeFile(path, packed)
    console.log(`${path}  ${(packed.byteLength / 1024).toFixed(1)}KB (${(html.length / 1024).toFixed(1)}KB raw)`)
    console.log(`\nSave the label beside it as ${opts.as}.label.json, filling in items by hand:\n`)
    console.log(JSON.stringify(
      { snapshot: opts.as, url: opts.url, capturedAt, note: '', identifier: 'text', items: [] },
      null, 2,
    ))
    console.log(`\nRun \`bench label --snapshot ${opts.as}\` to read the page's text in order.`)
  })

bench
  .command('label')
  .description("print a snapshot's visible text in document order, for labelling by hand")
  .requiredOption('--snapshot <name>')
  .action(async (opts) => {
    visibleRuns(await readSnapshot(opts.snapshot)).forEach((run, i) => {
      console.log(`${String(i + 1).padStart(4)}  ${run}`)
    })
  })

bench
  .command('selectors')
  .description('rank item-selector candidates against a hand-written label')
  .option('--snapshot <name>', 'one snapshot; omit to run every labelled snapshot')
  .action(async (opts) => {
    const names: string[] = opts.snapshot
      ? [opts.snapshot]
      : (await readdir(DOM_DIR).catch(() => []))
          .filter((f) => f.endsWith('.label.json'))
          .map((f) => f.slice(0, -'.label.json'.length))
          .sort()

    if (names.length === 0) {
      console.log('no labelled snapshots in benchmark/dom')
      return
    }

    const reports: SnapshotReport[] = []
    for (const name of names) {
      reports.push(scoreSnapshot(name, await readSnapshot(name), await readLabel(name)))
    }
    console.log(formatCorpus(reports))
  })

bench
  .command('health')
  .description('replay the stored recipes and report which are still alive, blocked or broken')
  .option('--tasks <paths...>', 'task files to draw replay inputs from', [TASKS])
  .option('--samples <n>', 'tasks to replay per recipe', '3')
  .action(async (opts) => {
    const tasks = (await Promise.all((opts.tasks as string[]).map(loadTasks))).flat()
    const health = await checkRecipes({
      recipeDir: RECIPE_DIR,
      tasks,
      samples: Number(opts.samples),
      net: buildEngine({ recipeDir: RECIPE_DIR, plans: PLANS }).net,
      sites: new StaticSiteResolver(WILD_ORIGINS),
    })
    console.log(formatHealth(health))
  })

bench
  .command('run')
  .description('run the benchmark and print the controlled/wild report')
  .option('--baseline', 'report the browser baseline instead of the engine')
  .option('--only <substring>', 'restrict to task ids containing this substring')
  .option('--tasks <path>', 'use a different task file')
  .option('--json <path>', 'also write one record per task, so a run split across invocations can be recombined exactly')
  .action(async (opts) => {
    const fixtures = await startAllFixtures()
    const engine = buildEngine({ recipeDir: RECIPE_DIR, plans: PLANS, origins: fixtures.origins })
    try {
      const all = await loadTasks(tasksFile(opts))
      const tasks = opts.only ? all.filter((t) => t.id.includes(opts.only)) : all
      const goldens = await loadGoldens(GOLDEN_DIR, tasks)
      const deps = { executor: engine.executor, browser: engine.browser, goldenDir: GOLDEN_DIR }

      if (opts.baseline) {
        const baseline: TaskRun[] = await runBaseline(tasks, goldens, deps)
        // No engine ran, so there is nothing to grade — omit the block rather
        // than print correctness figures this path cannot compute.
        console.log(formatReport(summarize(baseline, baseline), await robotsStatus(engine.net), { correctness: false }))

        const failed = baseline.filter((r) => !r.success)
        if (failed.length > 0) {
          console.log(`failed tasks (${failed.length}/${baseline.length})`)
          for (const f of failed) console.log(`  ${f.taskId}: ${f.reasons.join('; ') || 'no reason recorded'}`)
        }
        return
      }

      // Paired, so the engine is not always measured later than its baseline.
      const pairs = await runPairs(tasks, goldens, deps, ORACLES)
      console.log(formatReport(summarizePairs(pairs), await robotsStatus(engine.net)))

      // A median over 50 tasks cannot be rebuilt from five per-site medians, so
      // a run forced into several invocations needs the per-task rows.
      if (opts.json) {
        await writeFile(opts.json, JSON.stringify(pairs.map((p) => ({
          taskId: p.task.id, site: p.task.site, set: p.task.set,
          oracleMode: p.oracle.mode, measurementVersion: 'task-cost-v2',
          engine: { strategy: p.engine.meta.strategy, latencyMs: p.engine.meta.latencyMs,
                    elapsedMs: p.engine.meta.elapsedMs,
                    unreadResponseBodies: p.engine.meta.unreadResponseBodies,
                    browserLaunches: p.engine.meta.browserLaunches,
                    politenessWaitMs: p.engine.meta.politenessWaitMs,
                    bytesDownloaded: p.engine.meta.bytesDownloaded,
                    networkRequests: p.engine.meta.networkRequests,
                    agentTokens: p.engine.meta.llmTokens,
                    threw: p.engine.threw, blocked: p.engine.blocked,
                    items: p.engine.items.length, reasons: p.engine.reasons },
          baseline: { latencyMs: p.baseline.meta.latencyMs,
                      elapsedMs: p.baseline.meta.elapsedMs,
                      unreadResponseBodies: p.baseline.meta.unreadResponseBodies, threw: p.baseline.threw,
                      bytesDownloaded: p.baseline.meta.bytesDownloaded,
                      networkRequests: p.baseline.meta.networkRequests,
                      agentTokens: p.baseline.meta.llmTokens,
                      items: p.baseline.items.length },
          grade: p.grade, aging: p.aging,
        })), null, 1) + '\n')
      }

      // Two different causes, so a healthy browser run whose task simply has no
      // stored golden is never reported as a baseline problem.
      const excludedBaseline = excludedBy(pairs, 'baseline')
      if (excludedBaseline.length > 0) {
        console.log(`excluded (baseline unusable): ${excludedBaseline.length}`)
        for (const e of excludedBaseline) console.log(`  ${e.taskId}: ${e.reason}`)
      }

      const excludedNoGolden = excludedBy(pairs, 'no-golden')
      if (excludedNoGolden.length > 0) {
        console.log(`excluded (no stored golden): ${excludedNoGolden.length}`)
        for (const e of excludedNoGolden) console.log(`  ${e.taskId}: ${e.reason}`)
      }

      const aging = pairs.filter((p) => p.aging !== null)
      if (aging.length > 0) {
        console.log(`plan aging (${aging.length}):`)
        for (const p of aging) console.log(`  ${p.task.id}: ${p.aging}`)
      }

      // Denominator is the usable tasks, matching the rates printed above —
      // an excluded task is unjudged, not a candidate for this list at all.
      const usable = pairs.filter((p) => p.grade.usable)
      const failed = failedPairs(pairs)
      if (failed.length > 0) {
        console.log(`failed tasks (${failed.length}/${usable.length})`)
        for (const f of failed) console.log(`  ${f.taskId}: ${f.reasons.join('; ') || 'no reason recorded'}`)
      }
    } finally {
      await engine.warm.close()
      await fixtures.close()
    }
  })

try {
  await program.parseAsync(process.argv)
} catch (error) {
  const err = error as Error & { code?: string; exitCode?: number }
  if (err.exitCode === 0) { /* help/version was printed */ }
  else {
    let cause: unknown = err
    while (cause instanceof Error && !(cause instanceof UserError) && cause.cause) cause = cause.cause
    const code = cause instanceof UserError ? cause.code : err.code?.startsWith('commander.') ? 'INVALID_INPUT' : 'EXECUTION_FAILED'
    if (usage) Object.assign(usage, {ok:false, error:{code,message:err.message}, ...(error instanceof ExecutionFailure ? {meta:error.meta} : {})})
    const payload = { ok: false, runId: usage?.id, error: { code, message: err.message } }
    const jsonRequested = program.commands.some(command =>
      (command.name() === 'fetch' && command.opts().json === true) || (command.name() === 'read' && command.opts().format === 'json'))
    if (jsonRequested) console.log(JSON.stringify(payload))
    else console.error(`${code}: ${err.message}`)
    process.exitCode = 1
  }
}
 finally {
  if (usage) {
    if ('recipeBefore' in usage) {
      try {
        usage.recipeAfter = await recipeDigest(usageRoot,String(usage.site),String(usage.intent))
        usage.recipeChanged = usage.recipeBefore !== usage.recipeAfter
      } catch (error) { console.error(`LOG_SNAPSHOT_FAILED: ${String(error)}`) }
    }
    const logged = await writeUsage({...usage,event:'finish',at:new Date().toISOString(),ok:usage.ok !== false,wallMs:Math.round(performance.now()-usageStarted)})
    if (logged) console.error(`Run log: ${usage.id} (${join(usageRoot,'logs')})`)
  }
}
