import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { RecordedRequest } from './types.js'

/** Bodies at or below this stay in the trace; larger ones spill to a file. */
const INLINE_LIMIT_BYTES = 256 * 1024

/** A body this large is a mistake, not a page. Recorded as truncated. */
const SAFETY_CAP_BYTES = 64 * 1024 * 1024

export interface CapturedBody {
  body: string | null
  bodyPath: string | null
  bodySize: number
  truncated: boolean
}

/**
 * Preserves response bodies of any size.
 *
 * A fixed inline cap silently dropped flathub.org's 662KB search page, which
 * left the html compiler with nothing to work from — the strategy was not
 * refused, it was absent. Size is a property of the page, not a reason to lose
 * the observation, so large bodies go to a file and the trace keeps a pointer.
 * That also keeps a serialised trace small enough to read.
 */
export class BodyStore {
  private constructor(private readonly dir: string) {}

  static async create(): Promise<BodyStore> {
    return new BodyStore(await mkdtemp(join(tmpdir(), 'fwa-bodies-')))
  }

  async put(key: string, buffer: Buffer, cap: number = SAFETY_CAP_BYTES): Promise<CapturedBody> {
    const bodySize = buffer.byteLength

    if (bodySize > cap) {
      return { body: null, bodyPath: null, bodySize, truncated: true }
    }
    if (bodySize <= INLINE_LIMIT_BYTES) {
      return { body: buffer.toString('utf8'), bodyPath: null, bodySize, truncated: false }
    }

    const name = createHash('sha256').update(key).digest('hex').slice(0, 16)
    const bodyPath = join(this.dir, `${name}.body`)
    await writeFile(bodyPath, buffer)
    return { body: null, bodyPath, bodySize, truncated: false }
  }

  async dispose(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true })
  }
}

/**
 * The body of a recorded request, wherever it was kept. Synchronous because
 * every caller is a compiler reading one trace, not a hot path.
 */
export function readBody(request: Pick<RecordedRequest, 'body' | 'bodyPath'>): string | null {
  if (request.body !== null) return request.body
  if (request.bodyPath === null) return null
  try {
    return readFileSync(request.bodyPath, 'utf8')
  } catch {
    return null
  }
}
