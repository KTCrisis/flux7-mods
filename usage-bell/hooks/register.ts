import type { Register, SessionRateLimit } from 'claude-code'

// Each threshold rings once on the way up; a value that falls REARM points
// under it (a compaction, /clear, a window that reset) arms it again.
const CONTEXT_STEPS = [70, 85, 95]
const LIMIT_STEPS = [80, 95]
const REARM = 5

// The engine cuts the auto-memory index past these when it loads it (2.1.288);
// the bell rings at 90 % of either, and again once it is cut.
const MEMORY_MAX_LINES = 200
const MEMORY_MAX_BYTES = 25_000
const MEMORY_NEAR = 0.9
const MEMORY_POLL_MS = 2_000

const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

// The mods' own model calls ($.model, avatar7's Haiku): they go through the
// subscription, so no dollar is billed; their worth at API prices says how
// much of the plan they take. $ per million tokens, input and output; a cache
// read is a tenth of the input.
const PRICES: [string, number, number][] = [
  ['haiku', 1, 5],
  ['sonnet', 2, 10],
  ['opus', 4, 20],
  ['fable', 10, 50],
]
export type ModelSpend = { calls: number; input: number; output: number; cacheRead: number; usd: number }
export const priced = (model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }): number => {
  const [, pin, pout] = PRICES.find(([name]) => model.includes(name)) ?? ['', 0, 0]
  return (u.input_tokens * pin + (u.cache_read_input_tokens ?? 0) * pin * 0.1 + u.output_tokens * pout) / 1e6
}

// The API keys' spend (hoshi7, bayes, the agents...), real dollars, from ops7,
// which alone holds the Admin key: asked every five minutes, as ops7 caches it.
const SPEND_URL = 'http://127.0.0.1:8710/spend'
const SPEND_POLL_MS = 300_000
// A day's API spend rings at these dollars, once each on the way up.
const API_DAY_STEPS = [5, 10, 20]
export type ApiSpend = {
  ok: boolean
  error?: string
  total?: { today: number; yesterday: number; month: number }
  workspaces?: Record<string, { today: number; yesterday: number; month: number }>
}
export const parseSpend = (stdout: string): ApiSpend | undefined => {
  try {
    const j = JSON.parse(stdout) as ApiSpend
    return typeof j === 'object' && j !== null && typeof j.ok === 'boolean' ? j : undefined
  } catch {
    return undefined
  }
}
// One more call on a model's tally.
export const addUsage = (was: ModelSpend | undefined, model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }): ModelSpend => {
  const w = was ?? { calls: 0, input: 0, output: 0, cacheRead: 0, usd: 0 }
  return {
    calls: w.calls + 1,
    input: w.input + u.input_tokens,
    output: w.output + u.output_tokens,
    cacheRead: w.cacheRead + (u.cache_read_input_tokens ?? 0),
    usd: w.usd + priced(model, u),
  }
}
const usd = (v: number): string => (v < 10 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`)
const ktok = (n: number): string => (n < 1000 ? String(n) : `${Math.round(n / 1000)}k`)

const label = (kind: string): string => LIMIT_LABEL[kind] ?? kind

const hhmm = (iso: string | undefined): string => {
  if (iso === undefined) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const days = Math.floor((d.getTime() - Date.now()) / 86_400_000)
  const at = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return days >= 1 ? `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${at}` : at
}

// The highest step at or under `value`, 0 when none.
const stepOf = (steps: number[], value: number): number => steps.filter(s => value >= s).at(-1) ?? 0

// The step still held once `value` has fallen: each step it fell REARM under
// is released.
const held = (steps: number[], rung: number, value: number): number =>
  steps.filter(s => s <= rung && value > s - REARM).at(-1) ?? 0

export const register: Register = on => {
  // What each gauge last rang at, by key (`context`, `limit:five_hour`, `memory`).
  const rung = new Map<string, number>()
  let context: number | undefined
  let limits: SessionRateLimit[] = []
  let memory: { path: string; lines: number; bytes: number } | undefined
  let memoryPath: string | undefined
  let memoryDirty = false
  // This session's mods' calls, by model; and the API's day, month, workspaces.
  const mods = new Map<string, ModelSpend>()
  let api: ApiSpend | undefined

  // The rings a new reading raises; `rung` follows it.
  const ring = (key: string, steps: number[], value: number): number | undefined => {
    const before = held(steps, rung.get(key) ?? 0, value)
    const now = Math.max(before, stepOf(steps, value))
    rung.set(key, now)
    return now > before ? now : undefined
  }

  // The readings, dim at the end of the hint line under the prompt: a pinned
  // status line would come with the engine's warning sign, and these are not
  // warnings; the toasts are.
  let tail = ''
  const statusLine = (): string | undefined => {
    const parts: string[] = []
    if (context !== undefined) parts.push(`ctx ${Math.round(context)}%`)
    for (const l of limits) parts.push(`${label(l.kind)} ${Math.round(l.percentUsed)}%`)
    if (memory !== undefined) parts.push(`mem ${memory.lines}/${MEMORY_MAX_LINES}`)
    const m = [...mods.values()].reduce((a, b) => ({ tok: a.tok + b.input + b.output + b.cacheRead, usd: a.usd + b.usd }), { tok: 0, usd: 0 })
    if (m.tok > 0) parts.push(`mods ${ktok(m.tok)} tok ≈${usd(m.usd)}`)
    if (api?.ok === true && api.total !== undefined) parts.push(`api ${usd(api.total.today)} today`)
    return parts.length === 0 ? undefined : parts.join(' · ')
  }

  on('session.start', async ($, e, next) => {
    // For avatar7, when loaded: a limit near is a warning, in amber.
    await $.state.set({ plugin: 'usage-bell', key: 'announce' }, { mood: 'error', event: 'the session is nearing a limit' })
    await $.command.register({ name: 'usage7', description: 'Context, rate limits, memory index, the mods\' model calls and the API spend (test: a sample ring)' })
    // A status line pinned by an earlier version stays until cleared.
    $.ui.status(undefined)

    // The auto-memory index this session loaded, from the free local estimate.
    try {
      const usage = await $.session.usage({ breakdown: 'summary' })
      memoryPath = usage.context.breakdown?.memoryFiles.find(
        f => f.type === 'AutoMem' && f.path.endsWith('/MEMORY.md'),
      )?.path
      memoryDirty = memoryPath !== undefined
    } catch {
      // No breakdown here: the bell watches context and limits only.
    }

    // The memory index is read here, the only hook that keeps the $; a write
    // into its folder only raises the flag.
    $.clock.every(MEMORY_POLL_MS, async () => {
      if (!memoryDirty || memoryPath === undefined) return
      memoryDirty = false
      try {
        const text = await $.fs.read(memoryPath)
        const lines = text.trim().split('\n').length
        const bytes = new TextEncoder().encode(text).length
        memory = { path: memoryPath, lines, bytes }
        const fill = Math.max(lines / MEMORY_MAX_LINES, bytes / MEMORY_MAX_BYTES) * 100
        const step = ring('memory', [MEMORY_NEAR * 100, 100], fill)
        if (step === 100) {
          $.ui.toast(`memory index is cut at load: ${lines} lines, ${bytes} bytes (limit ${MEMORY_MAX_LINES} / ${MEMORY_MAX_BYTES})`)
        } else if (step !== undefined) {
          $.ui.toast(`memory index near its limit: ${lines}/${MEMORY_MAX_LINES} lines, ${Math.round(bytes / 1000)}/${MEMORY_MAX_BYTES / 1000} kB`)
        }
        tail = statusLine() ?? ''
        $.ui.invalidate('ui.render')
      } catch {
        // Unreadable for now: try again at the next write.
      }
    })

    // The API spend, from ops7 (absent when ops7 or its key is not there).
    const askSpend = async (): Promise<void> => {
      const r = await $.process.run(['curl', '-s', '--max-time', '5', SPEND_URL]).catch(() => undefined)
      const got = r?.exitCode === 0 ? parseSpend(r.stdout) : undefined
      api = got ?? { ok: false, error: 'ops7 did not answer on :8710' }
      if (api.ok && api.total !== undefined) {
        const step = ring('api:today', API_DAY_STEPS, api.total.today)
        if (step !== undefined) $.ui.toast(`API spend today ${usd(api.total.today)}, past $${step} (month ${usd(api.total.month)})`)
      }
      tail = statusLine() ?? ''
      $.ui.invalidate('ui.render')
    }
    void askSpend()
    $.clock.every(SPEND_POLL_MS, askSpend)

    return next(e)
  })

  // Each model call a mod publishes (avatar7's lines and journals, jukebox7's
  // intents): counted, and priced as the API would, though the subscription
  // bills none of it. A hook on model.complete does not see another mod's call.
  for (const plugin of ['avatar7', 'jukebox7'] as const) {
    on('state.set', { plugin, key: 'modelUse' }, async ($, e, next) => {
      const done = await next(e)
      const u = e.value
      mods.set(u.model, addUsage(mods.get(u.model), u.model, {
        input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cacheRead,
      }))
      tail = statusLine() ?? ''
      $.ui.invalidate('ui.render')
      return done
    })
  }

  on('session.measure', async ($, e, next) => {
    if (e.context.percent !== undefined) {
      context = e.context.percent
      const step = ring('context', CONTEXT_STEPS, context)
      if (step !== undefined) {
        const tokens = e.context.tokens === undefined ? '' : ` (${Math.round(e.context.tokens / 1000)}k of ${Math.round(e.context.window / 1000)}k)`
        $.ui.toast(`context ${Math.round(context)}% full${tokens}${step >= 95 ? ', compaction is close' : ''}`)
      }
    }

    limits = e.rateLimits
    for (const l of limits) {
      const step = ring(`limit:${l.kind}`, LIMIT_STEPS, l.percentUsed)
      if (step !== undefined) {
        const reset = hhmm(l.resetsAt)
        $.ui.toast(`${label(l.kind)} rate limit ${Math.round(l.percentUsed)}% used${reset === '' ? '' : `, resets ${reset}`}`)
      }
    }

    tail = statusLine() ?? ''
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) =>
    tail === '' ? next(e) : next({ ...e, props: { ...e.props, tail: `${e.props.tail ?? ''} · ${tail}` } }),
  )

  // A write into the memory folder: the clock rereads the index.
  for (const tool of ['Write', 'Edit'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const done = await next(e)
      const dir = memoryPath?.slice(0, memoryPath.lastIndexOf('/') + 1)
      if (dir !== undefined && e.file_path.startsWith(dir)) memoryDirty = true
      return done
    })
  }

  // `/usage7 test`: a sample ring, so the voice avatar7 lends the bell can
  // be heard without waiting for a real threshold.
  on('command.run', { command: 'usage7' }, async ($, e) => {
    if (e.args.trim() === 'test') {
      $.ui.toast('test ring: context 72% full, a sample, no real limit is near')
      return { text: 'test ring sent.' }
    }
    const rows: string[] = []
    rows.push(context === undefined ? 'context: no reading yet' : `context: ${Math.round(context)}%, rings at ${CONTEXT_STEPS.join(' / ')}`)
    if (limits.length === 0) rows.push('rate limits: no reading (not on a subscription, or no response yet)')
    for (const l of limits) {
      const reset = hhmm(l.resetsAt)
      rows.push(`${label(l.kind)}: ${Math.round(l.percentUsed)}%${reset === '' ? '' : `, resets ${reset}`}, rings at ${LIMIT_STEPS.join(' / ')}`)
    }
    rows.push(
      memory === undefined
        ? 'memory index: not found in this session'
        : `memory index: ${memory.lines}/${MEMORY_MAX_LINES} lines, ${memory.bytes}/${MEMORY_MAX_BYTES} bytes (${memory.path})`,
    )
    if (mods.size === 0) rows.push('mods (subscription): no model call yet this session')
    for (const [model, m] of mods) {
      rows.push(`mods ${model}: ${m.calls} calls, ${ktok(m.input)} in, ${ktok(m.output)} out, ${ktok(m.cacheRead)} cached; ≈${usd(m.usd)} at API prices, billed to the plan, not in dollars`)
    }
    if (api === undefined) rows.push('api: not asked yet')
    else if (!api.ok || api.total === undefined) rows.push(`api: ${api.error ?? 'no answer'}`)
    else {
      rows.push(`api: ${usd(api.total.today)} today, ${usd(api.total.yesterday)} yesterday, ${usd(api.total.month)} this month (UTC days), rings at $${API_DAY_STEPS.join(' / $')} a day`)
      for (const [ws, v] of Object.entries(api.workspaces ?? {})) {
        rows.push(`  ${ws}: ${usd(v.today)} today, ${usd(v.month)} month`)
      }
    }
    return { text: rows.join('\n') }
  })
}
