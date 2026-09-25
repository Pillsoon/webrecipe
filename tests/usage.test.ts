import { it, expect } from 'vitest'
import { mkdtemp, rm, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendUsage, readUsage, summarizeUsage, type UsageEvent } from '../src/usage.js'

it('keeps completed failures, unfinished commands and human correctness separate', async () => {
  const root = await mkdtemp('/tmp/webrecipe-usage-')
  const base = {version:1 as const,at:new Date().toISOString(),command:'fetch'}
  const events:UsageEvent[] = [
    {...base,id:'a',event:'start'}, {...base,id:'a',event:'finish',ok:true,wallMs:10,meta:{browserLaunches:0}},
    {...base,id:'b',event:'start'}, {...base,id:'b',event:'finish',ok:false,wallMs:30},
    {...base,id:'c',event:'start'},
    {...base,id:'a',event:'feedback',verdict:'correct'}, {...base,id:'a',event:'feedback',verdict:'wrong'},
  ]
  try {
    for (const event of events) await appendUsage(root,event)
    await appendFile(join(root,'logs',`${base.at.slice(0,10)}.jsonl`),'broken tail\n')
    const read = await readUsage(root,7)
    expect(read.malformed).toBe(1)
    expect(summarizeUsage(read.events)).toMatchObject({runs:2,succeeded:1,failed:1,incomplete:['c'],medianRunWallMs:20,browserFreeRuns:1,feedback:{correct:0,wrong:1}})
  } finally { await rm(root,{recursive:true,force:true}) }
})
