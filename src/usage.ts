import { createHash } from 'node:crypto'
import { siteName, intentName } from './local.js'
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface UsageEvent {
  version: 1
  at: string
  id: string
  event: 'start' | 'finish' | 'feedback'
  command?: string
  [key: string]: unknown
}

/** Local only. No HTML, result contents, cookies or headers. */
export async function appendUsage(root: string, event: UsageEvent): Promise<void> {
  const dir = join(root, 'logs')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await appendFile(join(dir, `${event.at.slice(0, 10)}.jsonl`), JSON.stringify(event) + '\n', { mode: 0o600 })
}

export async function readUsage(root: string, days: number): Promise<{ events: UsageEvent[]; malformed: number }> {
  const dir = join(root, 'logs')
  const files = await readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
  const since = Date.now() - days * 86_400_000
  const events: UsageEvent[] = []
  let malformed = 0
  for (const file of files.filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
    if (file.slice(0,10) < new Date(since).toISOString().slice(0,10)) continue
    for (const line of (await readFile(join(dir,file),'utf8')).split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line) as UsageEvent
        if (event.version !== 1 || !['start','finish','feedback'].includes(event.event) || typeof event.id !== 'string' || !Number.isFinite(Date.parse(event.at))) throw new Error('invalid record')
        if (Date.parse(event.at) >= since) events.push(event)
      } catch { malformed++ }
    }
  }
  return {events, malformed}
}

export function summarizeUsage(events: UsageEvent[]) {
  const starts = events.filter(e => e.event === 'start')
  const finishes = events.filter(e => e.event === 'finish')
  const runs = finishes.filter(e => e.command === 'fetch')
  const completed = new Set(finishes.map(e => e.id))
  const times = runs.map(e => Number(e.wallMs)).filter(Number.isFinite).sort((a,b) => a-b)
  const feedback = new Map(events.filter(e => e.event === 'feedback').map(e => [e.id,e.verdict]))
  return {
    started: starts.length, finished: finishes.length,
    incomplete: starts.filter(e => !completed.has(e.id)).map(e => e.id),
    measuredCommands: finishes.filter(e => e.meta !== undefined).length,
    totalRequests: finishes.reduce((sum,e) => sum + Number((e.meta as {networkRequests?:number} | undefined)?.networkRequests ?? 0),0),
    totalPolitenessWaitMs: finishes.reduce((sum,e) => sum + Number((e.meta as {politenessWaitMs?:number} | undefined)?.politenessWaitMs ?? 0),0),
    fallbackRuns: runs.filter(e => e.fellBack === true).length,
    recipeChanges: finishes.filter(e => e.recipeChanged === true).length,
    runs: runs.length, succeeded: runs.filter(e => e.ok === true).length,
    failed: runs.filter(e => e.ok === false).length,
    medianRunWallMs: times.length ? (times[Math.floor((times.length-1)/2)]! + times[Math.floor(times.length/2)]!) / 2 : null,
    browserFreeRuns: runs.filter(e => e.ok === true && (e.meta as {browserLaunches?:number} | undefined)?.browserLaunches === 0).length,
    feedback: {correct: [...feedback.values()].filter(v => v === 'correct').length, wrong: [...feedback.values()].filter(v => v === 'wrong').length},
    recent: finishes.slice(-10).map(({id,command,site,intent,ok,wallMs,error}) => ({id,command,site,intent,ok,wallMs,error})),
  }
}

export async function recipeDigest(root: string, site: string, intent: string): Promise<string | null> {
  const path = join(root,'recipes',siteName(site),`${intentName(intent)}.yaml`)
  try { return createHash('sha256').update(await readFile(path)).digest('hex') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
