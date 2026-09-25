import { it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startSsrFixture } from '../fixtures/ssr.js'
import { startSpaFixture } from '../fixtures/spa.js'
const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))

it('reads server HTML over HTTP, renders a JS shell, and remembers the shell needs a browser', async () => {
  const data = await mkdtemp('/tmp/fwa-read-cli-')
  const ssr = await startSsrFixture(), spa = await startSpaFixture()
  const read = async (url: string) => JSON.parse((await exec(process.execPath, ['--import', loader, cli, '--data-dir', data, 'read', '--url', url, '--format', 'json'], { timeout: 60_000 })).stdout)
  try {
    const server = await read(`${ssr.url}/search?q=rust`)
    expect(server).toMatchObject({ ok: true, method: 'http' })
    expect(server.runId).toBeTruthy()

    const shell = await read(`${spa.url}/search?q=rust`)
    expect(shell).toMatchObject({ ok: true, method: 'browser' })
    expect(shell.reason).toMatch(/shell/)
    expect(shell.text.length).toBeGreaterThan(0)

    const again = await read(`${spa.url}/search?q=go`)
    expect(again.reason).toMatch(/remembered/)
    const methods = JSON.parse(await readFile(join(data, 'read-methods.json'), 'utf8'))
    expect(Object.values(methods).sort()).toEqual(['browser', 'http'])
  } finally { await ssr.close(); await spa.close() }
})
