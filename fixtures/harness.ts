import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FixtureVersion = 'v1' | 'v2'

export interface FixtureServer {
  readonly name: string
  readonly url: string
  version: FixtureVersion
  setVersion(v: FixtureVersion): void
  /** Every path+query this server has been asked for, in order. */
  readonly requestLog: string[]
  close(): Promise<void>
}

export type FixtureHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  server: FixtureServer,
) => void

export async function startFixture(name: string, handler: FixtureHandler, port = 0): Promise<FixtureServer> {
  const requestLog: string[] = []
  let version: FixtureVersion = 'v1'
  let url = ''

  const http = createServer((req, res) => {
    requestLog.push(req.url ?? '')
    handler(req, res, server)
  })

  const server: FixtureServer = {
    name,
    get url() { return url },
    get version() { return version },
    set version(v: FixtureVersion) { version = v },
    setVersion(v) { version = v },
    requestLog,
    close: () => new Promise((resolve) => { http.close(() => resolve()) }),
  }

  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve) })
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  return server
}

export function sendHtml(res: ServerResponse, html: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}

export function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function sendJs(res: ServerResponse, js: string): void {
  res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
  res.end(js)
}
