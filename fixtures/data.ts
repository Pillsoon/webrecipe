export interface FixtureRecord {
  id: string
  title: string
  author: string
  tags: string[]
  body: string
}

const TOPICS = ['engineer', 'designer', 'analyst', 'manager'] as const
const STACKS = ['rust', 'typescript', 'go', 'python', 'elixir'] as const

export const DATASET: FixtureRecord[] = Array.from({ length: 40 }, (_, i) => {
  const topic = TOPICS[i % TOPICS.length]!
  const stack = STACKS[i % STACKS.length]!
  return {
    id: String(100 + i),
    title: `Senior ${stack} ${topic} #${i}`,
    author: `author-${i % 7}`,
    tags: [stack, topic],
    body: `Full description for record ${100 + i}. Stack is ${stack}.`,
  }
})

export const PAGE_SIZE = 10

export function search(query: string, page = 1): FixtureRecord[] {
  const q = query.toLowerCase().trim()
  const hits = q === '' ? DATASET : DATASET.filter((r) =>
    r.title.toLowerCase().includes(q) || r.tags.some((t) => t.includes(q)))
  const start = (page - 1) * PAGE_SIZE
  return hits.slice(start, start + PAGE_SIZE)
}

export function byId(id: string): FixtureRecord | undefined {
  return DATASET.find((r) => r.id === id)
}
