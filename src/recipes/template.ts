import { UserError } from '../local.js'
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

export function render(template: string, input: Record<string, string | number>): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    if (!(key in input)) throw new Error(`no value supplied for placeholder "${key}"`)
    return String(input[key])
  })
}

export function renderQuery(
  query: Record<string, string>,
  input: Record<string, string | number>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(query).map(([k, v]) => [k, render(v, input)]))
}

/** Encode user values as URL data, retaining slash-separated detail identifiers. */
export function renderPath(template: string, input: Record<string, string | number>): string {
  return render(template, Object.fromEntries(Object.entries(input).map(([k, v]) =>
    [k, String(v).split('/').map(encodeURIComponent).join('/')],
  )))
}

export function renderUrlTemplate(origin: string, template: string, input: Record<string, string | number>): string {
  const accepted = new Set([...template.matchAll(PLACEHOLDER)].map(match => match[1]))
  for (const key of Object.keys(input)) {
    if (!accepted.has(key)) throw new UserError('INVALID_INPUT', `The saved task does not use input "${key}". Teach a URL containing that input first.`)
  }
  const at = template.indexOf('?')
  const path = at === -1 ? template : template.slice(0, at)
  const url = new URL(renderPath(path, input), origin)
  if (url.origin !== new URL(origin).origin) throw new Error('plan URL escaped its origin')
  if (at !== -1) {
    for (const [key, value] of new URLSearchParams(template.slice(at + 1))) url.searchParams.append(key, render(value, input))
  }
  return url.toString()
}
