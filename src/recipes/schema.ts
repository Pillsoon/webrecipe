import { z } from 'zod'

export const RecipeSchema = z.object({
  site: z.string().min(1),
  intent: z.enum(['search', 'list', 'detail']),
  inputs: z.record(z.object({ type: z.enum(['string', 'number']) })),
  strategy: z.object({ type: z.enum(['http-json', 'http-html', 'browser']) }),
  request: z.object({
    method: z.enum(['GET', 'POST']),
    /** Set when the data request lives on another host than the site, e.g. a search vendor. */
    origin: z.string().url().optional(),
    path: z.string(),
    query: z.record(z.string()).optional(),
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
  }),
  output: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('json'),
      items: z.object({ path: z.string(), fields: z.record(z.string()) }),
    }),
    z.object({
      type: z.literal('html'),
      /** A field value of `@attr` reads that attribute off the item element; anything else is a CSS selector. */
      items: z.object({ selector: z.string(), fields: z.record(z.string()) }),
    }),
  ]),
  validation: z.object({
    status: z.number().int(),
    required: z.array(z.string()),
    minItems: z.number().int().default(1),
  }),
  fingerprint: z.object({
    endpoint: z.string(),
    hash: z.string(),
    responseFields: z.array(z.string()),
  }),
  fallback: z.object({ type: z.literal('browser') }),
})

export type Recipe = z.infer<typeof RecipeSchema>
