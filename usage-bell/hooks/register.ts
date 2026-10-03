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

  // The rings a new reading raises; `rung` follows it.
  const ring = (key: string, steps: number[], value: number): number | undefined => {
    const before = held(steps, rung.get(key) ?? 0, value)
    const now = Math.max(before, stepOf(steps, value))
    rung.set(key, now)
    return now > before ? now : undefined
  }

  const statusLine = (): string | undefined => {
    const parts: string[] = []
    if (context !== undefined) parts.push(`ctx ${Math.round(context)}%`)
    for (const l of limits) parts.push(`${label(l.kind)} ${Math.round(l.percentUsed)}%`)
    if (memory !== undefined) parts.push(`mem ${memory.lines}/${MEMORY_MAX_LINES}`)
    return parts.length === 0 ? undefined : parts.join(' · ')
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'usage', description: 'Context, rate limits and memory index, against their limits' })

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
        $.ui.status(statusLine())
      } catch {
        // Unreadable for now: try again at the next write.
      }
    })

    return next(e)
  })

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

    $.ui.status(statusLine())
    return next(e)
  })

  // A write into the memory folder: the clock rereads the index.
  for (const tool of ['Write', 'Edit'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const done = await next(e)
      const dir = memoryPath?.slice(0, memoryPath.lastIndexOf('/') + 1)
      if (dir !== undefined && e.file_path.startsWith(dir)) memoryDirty = true
      return done
    })
  }

  on('command.run', { command: 'usage' }, async () => {
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
    return { text: rows.join('\n') }
  })
}
