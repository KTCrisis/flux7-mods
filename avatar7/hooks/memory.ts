// A persona's memory across sessions, kept by a mem7 of its own (the
// memory_url option; empty, the personas forget as before). Each persona is a
// mem7 agent: it writes its exchanges with the user and its visits, reads its
// own memories and the shared `world`, never another persona's (the scopes of
// that mem7). At the start of a session, the persona on duty sums up what
// happened since its last journal; the journal stays, the exchanges word for
// word go after 30 days. Here: what is kept, the JSON-RPC bodies and the
// parsing. The engine calls ($) stay in register.tsx, which the engine
// requires: $ is never followed across an import.

import type { Ask } from './speech'

// The exchanges word for word, then only the journals.
export const EPISODE_TTL_S = 30 * 24 * 3600
// What a line recalls: a few exchanges matching what was said, the last
// journals whatever was said.
export const RECALL_EPISODES = 3
export const RECALL_JOURNALS = 2
// And older journals that match what was said: past two sessions, an
// exchange is gone in 30 days, and only its journal still holds it.
export const RECALL_OLD_JOURNALS = 2
// And the last visits with each persona the line names, found by name rather
// than by search: a French question finds no word of an English visit.
export const RECALL_VISITS = 2
// How far back the visits are scanned for a name.
export const VISIT_SCAN = 60
// An exchange recalled is cut to this many characters, a journal to more:
// it is already the short form.
export const RECALL_CHARS = 300
export const JOURNAL_CHARS = 900
// At most this many exchanges summed up in one journal.
export const CONSOLIDATE_MAX = 40

// The identity mem7 honours on a request that carries its token.
export const META_AGENT = 'art.flux7/agent'

export type Memory = { key: string; value: string; updated: string }

// Where the persona's memory lives: the mem7 URL and the file holding its
// token (MEM7_TOKEN=...). The token goes to curl through a file descriptor,
// never on the command line, where ps would show it.
export type MemoryAt = { url: string; envFile: string }

export const memoryAt = (options: Record<string, unknown>): MemoryAt | null => {
  const url = typeof options.memory_url === 'string' ? options.memory_url.trim().replace(/\/+$/, '') : ''
  const env = typeof options.memory_env === 'string' ? options.memory_env.trim() : ''
  return url === '' ? null : { url, envFile: env }
}

// The argv that posts one JSON-RPC body (on stdin) to mem7's /rpc.
export const rpcArgv = (at: MemoryAt): string[] => [
  'bash',
  '-c',
  'f=$1; case $f in "~/"*) f=$HOME/${f#"~/"};; esac; tok=$( [ -r "$f" ] && sed -n "s/^MEM7_TOKEN=//p" "$f" ); ' +
    'curl -sS -m 5 -H @<(printf "Authorization: Bearer %s\\n" "$tok") -H "Content-Type: application/json" --data-binary @- "$2/rpc"',
  'avatar7-mem7',
  at.envFile,
  at.url,
]

const call = (agent: string, name: string, args: Record<string, unknown>): string =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { [META_AGENT]: agent } } })

export const storeBody = (agent: string, key: string, value: string, tags: string[], ttl = 0): string =>
  call(agent, 'memory_store', { key, value, tags, ...(ttl > 0 ? { ttl } : {}) })

// Search in plain words over the persona's memories (mem7 scopes the reads).
export const contextBody = (agent: string, query: string, tags: string[], limit: number): string =>
  call(agent, 'memory_context', { query, mode: 'natural', tags, limit })

// The most recent memories with these tags, whatever their words.
export const recallBody = (agent: string, tags: string[], limit: number): string =>
  call(agent, 'memory_recall', { tags, limit })

// The text of a tools/call answer, or '' for an error or anything else.
const resultText = (stdout: string): string => {
  try {
    const r = JSON.parse(stdout) as { result?: { content?: { text?: string }[]; isError?: boolean } }
    if (r.result === undefined || r.result.isError === true) return ''
    return r.result.content?.[0]?.text ?? ''
  } catch {
    return ''
  }
}

// memory_context answers a JSON array inside the text.
export const parseContext = (stdout: string): Memory[] => {
  try {
    const rows = JSON.parse(resultText(stdout)) as { key?: unknown; value?: unknown; updated?: unknown }[]
    if (!Array.isArray(rows)) return []
    return rows.flatMap(r =>
      typeof r.key === 'string' && typeof r.value === 'string' ? [{ key: r.key, value: r.value, updated: typeof r.updated === 'string' ? r.updated : '' }] : [],
    )
  } catch {
    return []
  }
}

// memory_recall answers markdown: "## key", the value (lines and all), then
// "Tags:", "Agent:", "Updated:" lines. Most recent first.
export const parseRecall = (stdout: string): Memory[] => {
  const text = resultText(stdout)
  if (!text.startsWith('## ')) return []
  return text
    .split(/^## /m)
    .filter(Boolean)
    .flatMap(block => {
      const nl = block.indexOf('\n')
      const key = block.slice(0, nl).trim()
      const rest = block.slice(nl + 1)
      const tags = rest.search(/\nTags: [^\n]*\n(Agent: [^\n]*\n)?Updated: /)
      if (nl < 0 || tags < 0) return []
      const updated = /\nUpdated: (\S+)/.exec(rest.slice(tags))?.[1] ?? ''
      return [{ key, value: rest.slice(0, tags), updated }]
    })
}

// The lines that recall: those that answer the user or speak of the session,
// and the opening of a visit. A tool's verdict stays immediate.
export const recalls = (ask: Ask): boolean => {
  if (ask === 'talk' || ask === 'question') return true
  if ('duo' in ask) return ask.turn <= 1
  return 'chat' in ask || 'answer' in ask || 'consult' in ask
}

// What the recall searches for: what the user said, else the visitor, else
// the last prompt typed.
export const queryFor = (ask: Ask, asked: string, other: string): string => {
  if (typeof ask === 'object') {
    if ('chat' in ask) return ask.chat
    if ('consult' in ask) return ask.consult
    if ('answer' in ask) return `${ask.question} ${ask.answer}`
    if ('duo' in ask) return other
  }
  return asked
}

// What the model reads of the past, after the prompt; '' when nothing came back.
// The journals a line reads: the last ones and the older ones that matched,
// each once, most recent first.
export const journalsFor = (latest: Memory[], matched: Memory[]): Memory[] => {
  const seen = new Set(latest.map(j => j.key))
  return [...latest, ...matched.filter(j => !seen.has(j.key)).slice(0, RECALL_OLD_JOURNALS)].sort((a, b) => (a.updated < b.updated ? 1 : -1))
}

export const memoryNote = (journals: Memory[], episodes: Memory[]): string => {
  if (journals.length === 0 && episodes.length === 0) return ''
  const cut = (s: string, max: number): string => {
    const one = s.replace(/\s+/g, ' ').trim()
    return one.length > max ? `${one.slice(0, max)}...` : one
  }
  const parts = ['\nWhat you remember from earlier sessions (use it only if it fits; never invent more):']
  for (const j of [...journals].reverse()) parts.push(`- (${j.updated.slice(0, 10)}, your journal) ${cut(j.value, JOURNAL_CHARS)}`)
  for (const e of episodes) parts.push(`- (${e.updated.slice(0, 10)}) ${cut(e.value, RECALL_CHARS)}`)
  return parts.join('\n')
}

// The exchange kept for a line, or null when the line keeps none: the user's
// words and the persona's answer, as they were said.
export const episodeOf = (ask: Ask, name: string, text: string): { value: string; kind: string } | null => {
  if (typeof ask !== 'object' || text === '') return null
  if ('chat' in ask) return { value: `User: ${ask.chat}\n${name}: ${text}`, kind: 'chat' }
  if ('consult' in ask) return { value: `User asked your opinion: ${ask.consult}\n${name}: ${text}`, kind: 'consult' }
  if ('answer' in ask) return { value: `${name} asked: ${ask.question}\nUser: ${ask.answer}\n${name}: ${text}`, kind: 'answer' }
  return null
}

// The words of a text, lowercased and without accents.
const wordsOf = (s: string): string[] =>
  s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

// The names a line speaks of: each name whose words follow one another in
// it, or whose words joined are one of its words ("pod042" for "Pod 042").
export const namedIn = (text: string, names: string[]): string[] => {
  const w = wordsOf(text)
  return names.filter(name => {
    const n = wordsOf(name)
    if (n.length === 0) return false
    if (w.includes(n.join(''))) return true
    return w.some((_, i) => n.every((x, k) => w[i + k] === x))
  })
}

// The last visits with that persona, most recent first, from a recall of visits.
export const visitsWith = (visits: Memory[], name: string, n = RECALL_VISITS): Memory[] =>
  visits.filter(v => v.value.startsWith(`Visit with ${name}:`)).slice(0, n)

// Episodes for a line: the visits first, then the search hits not already there.
export const withVisits = (visits: Memory[], episodes: Memory[]): Memory[] => {
  const seen = new Set(visits.map(v => v.key))
  return [...visits, ...episodes.filter(e => !seen.has(e.key))]
}

// A visit, kept whole by each of the two at its last line, each in its own memory.
export const visitOf = (history: string[], last: string, other: string): string => `Visit with ${other}:\n${[...history, last].join('\n')}`

// Keys sort by time; the milliseconds keep two lines of one second apart.
const stamp = (at: Date): string => at.toISOString().replace(/[-:]/g, '').replace('.', '')
export const episodeKey = (agent: string, at: Date): string => `${agent}.ep.${stamp(at)}`
export const journalKey = (agent: string, at: Date): string => `${agent}.journal.${stamp(at)}`

// The exchanges not yet summed up: newer than the last journal, oldest first.
export const unsummed = (episodes: Memory[], journals: Memory[]): Memory[] => {
  const since = journals.reduce((m, j) => (j.updated > m ? j.updated : m), '')
  return episodes
    .filter(e => e.updated > since)
    .sort((a, b) => (a.updated < b.updated ? -1 : 1))
    .slice(-CONSOLIDATE_MAX)
}

// The model's answer when there is nothing to keep.
export const NOTHING = 'NOTHING'

// The last journal goes along so the new one does not say it again: pda wrote
// "Marc holds every key" in 15 journals of 19 and kept little else. Each
// persona met gets its own line, or the visits leave no trace past 30 days.
export const journalPrompt = (episodes: Memory[], user: string, last = ''): string =>
  (last.trim() !== '' ? `Your last journal said:\n${last.trim()}\n\n` : '') +
  `Here are your exchanges since your last journal, oldest first:\n` +
  episodes.map(e => `(${e.updated.slice(0, 10)}) ${e.value}`).join('\n\n') +
  `\n\nWrite your journal entry, first person, in English. First, two or three sentences on what you learned about ${user}; ` +
  `say only what is new, never again what your last journal already said. Then one line for each other persona you met here, ` +
  `at most four, each starting "With <name>:" and under twenty words, on what happened that would matter next time. ` +
  `Drop the small talk. Never write about money, family or health, even if they came up. If nothing is worth keeping, answer only ${NOTHING}.`

export const journalFrom = (r: { isAnswered: true; text: string } | { isAnswered: false }): string | null => {
  if (!r.isAnswered) return null
  const text = r.text.replace(/\s+/g, ' ').trim()
  return text === '' || text.startsWith(NOTHING) ? null : text
}
