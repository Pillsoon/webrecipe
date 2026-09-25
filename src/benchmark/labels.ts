import { z } from 'zod'
import { elementsOf, isEl, loadPage, normalize, type El } from '../authoring/candidates.js'

/**
 * What a human read off the rendered page, and nothing else.
 *
 * There is deliberately nowhere in this schema to put a selector. The whole
 * harness rests on the label being content while the candidate is structure; a
 * label derived from a selector would score that selector against itself, which
 * is the circle the compile-time equivalence check is already stuck in.
 */
export const LabelSchema = z.object({
  snapshot: z.string().min(1),
  url: z.string().url(),
  capturedAt: z.string().min(1),
  note: z.string().default(''),
  /** Which of the two a human used to write the items down. */
  identifier: z.enum(['text', 'href']),
  items: z.array(z.string().min(1)).min(1),
})

export type Label = z.infer<typeof LabelSchema>

/**
 * The page's text in document order, so a human can mark the item boundaries
 * without a selector having proposed them first.
 */
export function visibleRuns(html: string): string[] {
  const $ = loadPage(html)

  const runs: string[] = []
  const walk = (node: El): void => {
    for (const child of $(node).contents().toArray()) {
      if (child.type === 'text') {
        const text = normalize($(child).text())
        if (text !== '') runs.push(text)
      } else if (isEl(child)) {
        // An image speaks through its alt, and on a page of covers that is the
        // only thing the item says.
        const alt = normalize(child.tagName.toLowerCase() === 'img' ? $(child).attr('alt') ?? '' : '')
        if (alt !== '') runs.push(alt)
        walk(child)
      }
    }
  }

  const root = elementsOf($, 'body')[0] ?? elementsOf($, 'html')[0]
  if (root === undefined) return []
  walk(root)
  return runs
}
