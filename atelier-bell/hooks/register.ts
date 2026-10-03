import type { Engine, Register } from 'claude-code'

// flux7-studio and the ComfyUI behind it, both local.
const STUDIO = 'http://localhost:8700'
const COMFY = 'http://localhost:8188'
const POLL_MS = 3_000

type Output = { name: string; kind: string; mtime: number }
type Queue = { queue_running: unknown[]; queue_pending: unknown[] }

const clock = (seconds: number): string => {
  const d = new Date(seconds * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// For avatar7, when loaded: a render ready is calm news.
async function announce($: Engine): Promise<void> {
  await $.state.set({ plugin: 'atelier-bell', key: 'announce' }, { mood: 'watch', event: 'an atelier finished its work' })
}

export const register: Register = on => {
  // Outputs already there; null until the first answer, which only seeds it,
  // so a session never rings for renders made before it started.
  let seen: Set<string> | null = null
  let status = ''
  let last = ''

  on('session.start', async ($, e, next) => {
    await announce($)
    await $.command.register({ name: 'bell', description: 'What the ateliers are doing now (test: a sample ring)' })
    // A status line pinned by an earlier version stays until cleared.
    $.ui.status(undefined)

    $.clock.every(POLL_MS, async () => {
      try {
        const [out, queue] = await Promise.all([$.http.fetch(`${STUDIO}/outputs`), $.http.fetch(`${COMFY}/queue`)])
        if (!out.ok) return
        const outputs = JSON.parse(out.text) as Output[]

        if (seen === null) {
          seen = new Set(outputs.map(o => o.name))
        } else {
          const fresh = outputs.filter(o => !seen?.has(o.name)).sort((a, b) => a.mtime - b.mtime)
          // A purge drops names; the set follows what is there.
          seen = new Set(outputs.map(o => o.name))
          const newest = fresh.at(-1)
          if (newest !== undefined) {
            last = `${newest.name} at ${clock(newest.mtime)}`
            $.ui.toast(
              fresh.length === 1
                ? `studio: ${newest.kind} ${newest.name} is ready`
                : `studio: ${fresh.length} renders are ready, the last ${newest.name}`,
            )
          }
        }

        const q = queue.ok ? (JSON.parse(queue.text) as Queue) : { queue_running: [], queue_pending: [] }
        const running = q.queue_running.length
        const waiting = q.queue_pending.length
        const now =
          running > 0
            ? `studio: rendering${waiting > 0 ? `, ${waiting} queued` : ''}`
            : last !== ''
              ? `studio: last ${last}`
              : ''
        if (now !== status) {
          status = now
          $.ui.invalidate('ui.render')
        }
      } catch {
        // studio or ComfyUI down: stay quiet, try again at the next poll.
      }
    })

    return next(e)
  })

  // The status, dim at the end of the hint line under the prompt: a pinned
  // status line would come with the engine's warning sign; the toasts ring.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) =>
    status === '' ? next(e) : next({ ...e, props: { ...e.props, tail: `${e.props.tail ?? ''} · ${status}` } }),
  )

  // `/bell test`: a sample ring, so the voice avatar7 lends the bell can be
  // heard without waiting for a render.
  on('command.run', { command: 'bell' }, async ($, e) => {
    if (e.args.trim() === 'test') {
      await announce($)
      $.ui.toast('test ring: studio: image sample.png is ready, a sample, nothing was rendered')
      return { text: 'test ring sent.' }
    }
    return { text: status === '' ? 'studio: nothing rendered since this session started.' : status }
  })
}
