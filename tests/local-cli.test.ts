import { it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startSsrFixture } from '../fixtures/ssr.js'
const exec = promisify(execFile)
const cli = process.env.WEBRECIPE_TEST_CLI ?? fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))

it('saves in one process, fetches from another directory later, fails clearly on drift, and can be saved again', async () => {
  const root = await mkdtemp('/tmp/webrecipe-local-cli-')
  const server = await startSsrFixture()
  const cwdA = join(root,'a'), cwdB = join(root,'b'), data = join(root,'data')
  await mkdir(cwdA); await mkdir(cwdB)
  const invoke = (args: string[], cwd = cwdA) => exec(process.execPath, [...(process.env.WEBRECIPE_TEST_CLI ? [] : ['--import',loader]),cli,'--data-dir',data,...args], { cwd, timeout: 45_000 })
  const saveArgs = ['save','test.local/search','--url',`${server.url}/search?q=rust`,'--query','rust','--items','li.result','--field','title=a.title','url=a.title@href']
  const fetchArgs = ['fetch','test.local/search','--query','rust','--json']
  try {
    const inspected = await invoke(['inspect',`${server.url}/search?q=rust`])
    expect(inspected.stdout).toContain('--items')
    expect((await invoke(saveArgs)).stdout).toContain('sample:')
    // On-disk state from a previous day, then a new CLI process in a different cwd.
    const old = new Date(Date.now() - 48 * 60 * 60_000)
    await utimes(join(data,'plans/test.local/search.json'),old,old)
    const good = JSON.parse((await invoke(fetchArgs,cwdB)).stdout)
    expect(good.ok).toBe(true)
    expect(good.meta.browserLaunches).toBe(0)
    expect(good.items.length).toBeGreaterThan(0)
    await expect(invoke([...fetchArgs,'--page','2'],cwdB)).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('INVALID_INPUT') })
    const alternate = JSON.parse((await invoke(fetchArgs.map(x => x === 'rust' ? 'go' : x),cwdB)).stdout)
    expect(alternate.ok).toBe(true)
    expect(alternate.items).not.toEqual(good.items)
    expect(alternate.meta.browserLaunches).toBe(0)
    server.setVersion('v2')
    await expect(invoke(fetchArgs,cwdB)).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('UNVERIFIED_RESULT') })
    const taughtAgain = saveArgs.map(x => x.replace('li.result','li.hit').replaceAll('a.title','a.name'))
    await invoke(taughtAgain,cwdB)
    expect(JSON.parse((await invoke(fetchArgs,cwdB)).stdout).items).toEqual(good.items)
    expect((await invoke(['list'],cwdB)).stdout).toContain('test.local')
    expect(good.runId).toEqual(expect.any(String))
    await invoke(['feedback','--run',good.runId,'--verdict','correct'])
    const logs = JSON.parse((await invoke(['logs'])).stdout)
    expect(logs.runs).toBe(5)
    expect(logs.failed).toBe(2)
    expect(logs.incomplete).toEqual([])
    expect(logs.feedback.correct).toBe(1)
    const noLog = JSON.parse((await invoke(['--no-log',...fetchArgs])).stdout)
    expect(noLog.runId).toBeUndefined()
    expect(JSON.parse((await invoke(['logs'])).stdout).runs).toBe(logs.runs)
    await expect(invoke(['fetch','unknown.local/list','--json'])).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('NOT_TAUGHT') })
    await expect(invoke(['fetch','test.local/list','--page','oops','--json'])).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('INVALID_INPUT') })
  } finally { await server.close(); await rm(root,{recursive:true,force:true}) }
}, 90_000)
