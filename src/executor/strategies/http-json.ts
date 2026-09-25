import { measureResult } from '../../measurement.js'
import type { PolitenessLayer } from '../../net/politeness.js'
import type { SiteResolver } from '../../sites.js'
import type { Recipe } from '../../recipes/schema.js'
import { render, renderPath, renderQuery } from '../../recipes/template.js'
import { extractJsonItems, jsonSignature } from '../extract.js'
import { countTokens } from '../tokens.js'
import { formatItems } from '../format.js'
import { emptyMeta, type Result, type Strategy, type Task } from '../../types.js'

export function buildUrl(siteOrigin: string, recipe: Recipe, task: Task): string {
  const origin = new URL(recipe.request.origin ?? siteOrigin).origin
  const url = new URL(renderPath(recipe.request.path, task.input), origin)

  // An input value must not be able to redirect a request the recipe did not
  // describe: a rendered path beginning `//`, such as a `detail` input of
  // `/evil.example/x` against a path of `/{{id}}`, is protocol-relative and
  // `new URL` resolves it against that host instead of `origin`.
  if (url.origin !== origin) throw new Error(`recipe would request ${url.origin}, outside ${origin}`)

  for (const [k, v] of Object.entries(renderQuery(recipe.request.query ?? {}, task.input))) {
    url.searchParams.set(k, v)
  }
  return url.toString()
}

export class HttpJsonStrategy implements Strategy {
  readonly name = 'http-json' as const

  constructor(
    private readonly net: PolitenessLayer,
    private readonly sites: SiteResolver,
  ) {}

  async execute(recipe: Recipe, task: Task): Promise<Result> {
    return measureResult(this.name, () => this.executeAttempt(recipe, task))
  }

  private async executeAttempt(recipe: Recipe, task: Task): Promise<Result> {
    const meta = emptyMeta(this.name)
    const started = performance.now()

    const url = buildUrl(this.sites.origin(task.site), recipe, task)
    const res = await this.net.fetch(url, {
      method: recipe.request.method,
      headers: recipe.request.headers,
      body: recipe.request.body ? render(recipe.request.body, task.input) : undefined,
    })

    meta.networkRequests = 1
    meta.bytesDownloaded = res.bytesDownloaded
    meta.politenessWaitMs = res.waitedMs
    meta.latencyMs = Math.max(0, Math.round(performance.now() - started) - res.waitedMs)

    // Reported, not thrown. A status that becomes an error message is invisible
    // to the validator that has to judge it and to the executor that has to tell
    // a site refusing us from a recipe that rotted.
    if (res.status !== recipe.validation.status) {
      return { items: [], meta, status: res.status, payload: undefined }
    }

    let payload: unknown
    try {
      payload = JSON.parse(res.body)
    } catch {
      // A challenge page answers 200 with HTML where the API used to be; that is
      // a site response like any other and is reported the same way.
      return { items: [], meta, status: res.status, payload: undefined }
    }

    if (recipe.output.type !== 'json') throw new Error('http-json requires a json recipe')
    const items = extractJsonItems(recipe, payload)
    meta.llmTokens = countTokens(formatItems(items, 'tsv'))

    return {
      items,
      meta,
      payload: jsonSignature({ output: recipe.output }, payload),
      status: res.status,
    }
  }
}
