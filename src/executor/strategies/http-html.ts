import { measureResult } from '../../measurement.js'
import type { PolitenessLayer } from '../../net/politeness.js'
import type { SiteResolver } from '../../sites.js'
import type { Recipe } from '../../recipes/schema.js'
import { render } from '../../recipes/template.js'
import { buildUrl } from './http-json.js'
import { extractHtmlItems, htmlSignature } from '../extract.js'
import { countTokens } from '../tokens.js'
import { formatItems } from '../format.js'
import { emptyMeta, type Result, type Strategy, type Task } from '../../types.js'

export class HttpHtmlStrategy implements Strategy {
  readonly name = 'http-html' as const

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

    const items = extractHtmlItems(recipe, res.body, res.url)
    meta.llmTokens = countTokens(formatItems(items, 'tsv'))

    return { items, meta, payload: htmlSignature(recipe, items), status: res.status }
  }
}
