import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Line } from '../types'

const PANE = 'avatar7'
const FACE = 'face'
const FRAME_MS = 66
const DEFAULT = 'shodan'
const AVATARS = ['shodan', 'hal', 'glados', 'ada', 'duck7', 'pod042', 'kaneda', 'commis']

// Portraits are baked by tools/bake.py into W x H raw RGB pixels; each cell
// is an upper half block, so two pixel rows per cell row.
const W = 64
const H = 64
const MIN_SIZE = 16

// Rows kept under the face for the line, which may wrap once, the pending
// approval and the buttons.
const TEXT_ROWS = 4

// The engine redraws on a change of width, never on a change of height alone:
// the clock asks for a render this often so the face follows both.
const REFIT_FRAMES = 15

// The face's side in pixels for a pane body: as wide as the body, as tall as
// the body leaves (two pixels per row, a few rows kept for the text), even,
// never past the baked portrait.
const fit = (columns: number, rows: number): number => {
  const side = Math.min(W, columns, Math.max(MIN_SIZE / 2, rows - TEXT_ROWS) * 2)
  return Math.max(MIN_SIZE, side - (side % 2))
}

const line = atom({ plugin: 'avatar7', key: 'line' } as const, { text: '', at: 0 })
const isMuted = atom({ plugin: 'avatar7', key: 'isMuted' } as const, false)
// SAPI volume, 0 to 100, kept across sessions in $.store.
const volume = atom({ plugin: 'avatar7', key: 'volume' } as const, 100)
const VOLUME_STEP = 10

// What mesh7 answers when it refuses a call (mcp/server.go, halt/halt.go).
const MESH_DENY = /Policy denied|Approval denied|Denied by supervisor|Approval timed out|halted by operator/
// What it answers when it holds one for a human (approvalRequiredText).
const MESH_HELD = /Approval required \(id: ([0-9a-f]+)\)/
const MESH = 'http://localhost:9090'
// How often the clock asks mesh7 whether a held call was decided: ~1.5 s.
const POLL_FRAMES = 23
// An ask the mode may settle alone (auto mode): the face waits at once, the
// avatar speaks only if the permission prompt is still up after ~2 s.
const ASK_FRAMES = 30

const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
// A persona with a `pitch` (-10 to 10) speaks through the SAPI COM voice,
// which takes the pitch as XML; the text is escaped for it.
const speakScript = (who: { voice: string; rate: number; pitch?: number }, vol: number) =>
  '[Console]::InputEncoding=[Text.Encoding]::UTF8; $t=[Console]::In.ReadToEnd(); ' +
  (who.pitch === undefined
    ? 'Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
      `$s.SelectVoice("${who.voice}"); $s.Rate=${who.rate}; $s.Volume=${vol}; $s.Speak($t)`
    : '$q=[char]34; $v=New-Object -ComObject SAPI.SpVoice; ' +
      `$v.Voice=($v.GetVoices() | ? { $_.GetDescription() -like "${who.voice}*" } | select -First 1); ` +
      `$v.Rate=${who.rate}; $v.Volume=${vol}; ` +
      `[void]$v.Speak("<pitch absmiddle=" + $q + "${who.pitch}" + $q + ">" + [Security.SecurityElement]::Escape($t) + "</pitch>", 8)`)

const STYLE = ' No quotes, no emoji, no em dash.'

// How much of the user's last prompt the avatar reads, so it judges a call
// against what was asked rather than the bare gesture.
const ASKED_CHARS = 200

// When poked, the avatar reads the last messages of the conversation, each cut
// to this many characters.
const TALK_MESSAGES = 6
const TALK_CHARS = 300

type Mood = 'idle' | 'watch' | 'deny' | 'error' | 'wait'

// A line to speak: an event in a mood, or the user's poke, which reads the
// conversation first.
type Ask = { mood: Mood; event: string } | 'talk'

type Approval = { id: string; status: string }

type Persona = {
  name: string
  voice: string
  rate: number
  pitch?: number
  color: string
  eyes: { x: number; y: number; rx: number; ry: number }[]
  mouth: { x: number; y: number; half: number } | null
  greeting: string
  persona: string
  fallback: Record<Exclude<Mood, 'wait'>, string[]> & { wait?: string[] }
  nobody?: string
}

// `{, user}` in a persona's text becomes ", <name>": the user_name option,
// else the persona's `nobody`, else nothing (the braces and their text drop).
const personalize = (text: string, name: string, nobody: string | undefined): string =>
  text.replace(/\{([^{}]*)user([^{}]*)\}/g, (_, before: string, after: string) => {
    const who = name !== '' ? name : (nobody ?? '')
    return who === '' ? '' : `${before}${who}${after}`
  })

const TINT: Record<Mood, number> = {
  idle: 0x000000,
  watch: 0x00e5ff,
  deny: 0xff2a6d,
  error: 0xffb000,
  wait: 0x7a5cff,
}

// Cheap deterministic noise for the glitch.
const noise = (a: number, b: number): number => {
  let n = (a * 374761393 + b * 668265263) | 0
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

export const register: Register = (on, options) => {
  const userName = typeof options.user_name === 'string' ? options.user_name.trim() : ''
  let frame = 0
  let mood: Mood = 'idle'
  let moodUntil = 0
  let speakUntil = 0
  let typed = 0
  let lineLength = 0
  let lastSpoke = -Infinity
  let isSpeaking = false
  let face: Uint8Array | null = null
  let who: Persona | null = null
  let size = W
  let asked = ''
  // The next line to speak; the clock, which holds the session's $, speaks it.
  let queued: Ask | null = null
  // A mesh7 approval this session's call is held on, by its short id.
  let heldId: string | null = null
  let heldCall = ''
  let isPolling = false
  // A call put to the permission prompt (a mesh7 hook's `ask`, a settings rule).
  let askSince: number | null = null
  let askCall = ''

  const pixel = (x: number, y: number): number => {
    const t = frame * (FRAME_MS / 1000)
    const isGlitch = mood === 'deny' && noise(frame, y >> 2) < 0.35
    const gx = isGlitch ? Math.min(W - 1, Math.max(0, x + Math.round((noise(y, frame) - 0.5) * 10))) : x

    if (face === null || who === null) return noise(x * 7 + frame, y) < 0.3 ? 0x1a2a22 : 0x020806

    const i = (y * W + gx) * 3
    let r = face[i]
    let g = face[i + 1]
    let b = face[i + 2]
    let k = 1

    // Eyes: a slow glow, shut now and then; with no mouth, they speak.
    const isSpeakingNow = frame < speakUntil
    const isBlink = who.mouth !== null && frame % 70 < 3
    for (const eye of who.eyes) {
      const dx = (x - eye.x) / eye.rx
      const dy = (y - eye.y) / eye.ry
      if (dx * dx + dy * dy <= 1.2) {
        if (isBlink) k = 0.12
        else if (who.mouth === null && isSpeakingNow) k = 1.1 + 0.6 * Math.abs(Math.sin(t * 9))
        else k = 1.2 + 0.25 * Math.sin(t * 2)
      }
    }

    // Mouth: the lips part while the avatar speaks.
    const mouth = who.mouth
    if (mouth !== null && isSpeakingNow && Math.abs(x - mouth.x) <= mouth.half) {
      const open = Math.round(Math.abs(Math.sin(t * 17)) * 2)
      if (y >= mouth.y && y <= mouth.y + open) k = 0.1
    }

    // Mood: pull the portrait toward the mood's color by its luminance.
    if (mood !== 'idle') {
      const lum = (0.3 * r + 0.59 * g + 0.11 * b) / 255
      const tint = TINT[mood]
      const mix = mood === 'watch' ? 0.3 : mood === 'wait' ? 0.45 : 0.65
      r = r * (1 - mix) + ((tint >> 16) & 0xff) * lum * 1.3 * mix
      g = g * (1 - mix) + ((tint >> 8) & 0xff) * lum * 1.3 * mix
      b = b * (1 - mix) + (tint & 0xff) * lum * 1.3 * mix
    }

    // Holding its breath while a human decides.
    if (mood === 'wait') k *= 0.8 + 0.2 * Math.sin(t * 2.5)

    // Snow when glitching; the scanlines are drawn at the output size.
    if (isGlitch && noise(x, y + frame) < 0.04) return 0xffffff

    const c = (v: number) => Math.min(255, Math.round(v * k))
    return (c(r) << 16) | (c(g) << 8) | c(b)
  }

  // One output pixel averages the block of portrait pixels it covers, so the
  // face shrinks with the pane and keeps its features.
  const sample = (ox: number, oy: number): number => {
    const x0 = Math.floor((ox * W) / size)
    const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * W) / size))
    const y0 = Math.floor((oy * H) / size)
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * H) / size))
    let r = 0
    let g = 0
    let b = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = pixel(x, y)
        r += (p >> 16) & 0xff
        g += (p >> 8) & 0xff
        b += p & 0xff
      }
    }
    const n = (x1 - x0) * (y1 - y0)
    let k = oy % 2 === 1 ? 0.7 : 1
    if (oy === Math.floor((frame * 0.8 * size) / H) % size) k *= 1.35
    const c = (v: number) => Math.min(255, Math.round((v / n) * k))
    return (c(r) << 16) | (c(g) << 8) | c(b)
  }

  const cells = (): string => {
    const rows = size / 2
    const words = new Uint32Array(size * rows * 3)
    for (let row = 0; row < rows; row++) {
      for (let x = 0; x < size; x++) {
        const i = (row * size + x) * 3
        words[i] = 0x2580
        words[i + 1] = sample(x, row * 2)
        words[i + 2] = sample(x, row * 2 + 1)
      }
    }
    return new Uint8Array(words.buffer).toBase64()
  }

  const describe = (e: Record<string, unknown>): string => {
    const hint = e.command ?? e.file_path ?? e.pattern ?? e.url ?? ''
    return `${String(e.tool)} ${String(hint).slice(0, 80)}`.trim()
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'avatar',
      description: `Open the avatar pane, or switch: /avatar ${AVATARS.join('|')}`,
    })
    await $.command.register({ name: 'avatar-mute', description: 'Toggle the avatar voice' })
    await $.command.register({ name: 'avatar-talk', description: 'Ask the avatar what it thinks of the conversation' })

    const storedVolume = await $.store.get('volume')
    if (typeof storedVolume === 'number') await update($, volume, () => storedVolume)

    const stored = await $.store.get('avatar')
    const id = typeof stored === 'string' && AVATARS.includes(stored) ? stored : DEFAULT
    try {
      const dir = `${$.plugin.root}/personas/${id}`
      who = JSON.parse(String(await $.fs.read(`${dir}/persona.json`))) as Persona
      const { base64 } = await $.fs.read(`${dir}/face.rgb`, { as: 'bytes' })
      face = Uint8Array.fromBase64(base64)
    } catch {
      $.ui.log(`avatar7: personas/${id} unreadable, run tools/bake.py ${id}`)
    }

    const last = await read($, line)
    lineLength = last.text.length
    typed = lineLength

    $.clock.every(FRAME_MS, () => {
      frame += 1
      if (frame > moodUntil && mood !== 'idle') mood = 'idle'
      void $.ui.blit({ requestId: PANE, key: FACE, columns: size, rows: size / 2, cells: cells() })
      if (typed < lineLength) {
        typed = Math.min(lineLength, typed + 2)
        $.ui.invalidate('ui.render')
      } else if (frame % REFIT_FRAMES === 0) {
        $.ui.invalidate('ui.render')
      }

      // A held call: ask mesh7 now and then whether the human decided.
      if (heldId !== null && !isPolling && frame % POLL_FRAMES === 0) {
        isPolling = true
        const id = heldId
        $.clock.after(1, async () => {
          try {
            const res = await $.http.fetch(`${MESH}/approvals`)
            if (!res.ok) return
            const found = (JSON.parse(res.text) as Approval[]).find(a => a.id.startsWith(id))
            if (found === undefined || found.status === 'pending' || heldId !== id) return
            heldId = null
            const now: Mood = found.status === 'approved' ? 'watch' : found.status === 'denied' ? 'deny' : 'error'
            mood = now
            moodUntil = frame + 30
            queued = { mood: now, event: `the human's decision on the held call ${heldCall}: ${found.status.toUpperCase()}` }
          } catch {
            // mesh7 down or unreadable: try again at the next poll.
          } finally {
            isPolling = false
          }
        })
      }

      if (askSince !== null && frame - askSince === ASK_FRAMES && queued === null) {
        queued = { mood: 'wait', event: `call waiting for the user's permission: ${askCall}` }
      }

      if (queued === null || isSpeaking || who === null) return
      const ask = queued
      queued = null
      isSpeaking = true
      lastSpoke = frame
      const voice = who
      $.clock.after(1, async () => {
        try {
          let prompt: string
          if (ask === 'talk') {
            const messages = await $.session.messages()
            const recent = messages
              .filter(m => m.text.trim() !== '')
              .slice(-TALK_MESSAGES)
              .map(m => `${m.role}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, TALK_CHARS)}`)
              .join('\n')
            prompt =
              `The user pokes you and wants your take on where the conversation stands.\n` +
              `Last messages, oldest first:\n${recent}`
          } else {
            prompt = asked === '' ? `Event: ${ask.event}` : `The user asked: ${asked}\nEvent: ${ask.event}`
          }
          const r = await $.model.complete({
            model: 'haiku',
            system: personalize(voice.persona, userName, voice.nobody) + STYLE,
            prompt,
            maxTokens: 80,
            timeoutMs: 15_000,
          })
          const pool =
            ask === 'talk'
              ? voice.fallback.idle
              : ask.mood === 'wait'
                ? (voice.fallback.wait ?? voice.fallback.watch)
                : voice.fallback[ask.mood]
          const text = r.isAnswered
            ? (r.text.trim().split('\n')[0] ?? '')
            : personalize(pool[frame % pool.length] ?? '', userName, voice.nobody)
          lineLength = text.length
          typed = 0
          speakUntil = frame + Math.ceil(text.length / 2) + 10
          await update($, line, () => ({ text, at: frame }) satisfies Line)
          if (!(await read($, isMuted))) {
            await $.process.run([POWERSHELL, '-NoProfile', '-Command', speakScript(voice, await read($, volume))], {
              stdin: text,
              timeoutMs: 30_000,
            })
          }
        } finally {
          isSpeaking = false
        }
      })
    })

    void $.ui.open({ id: PANE, title: who?.name ?? 'avatar7' })
    return next(e)
  })

  on('command.run', { command: 'avatar' }, async ($, e) => {
    const id = e.args.trim().toLowerCase()

    if (id === '') {
      const opened = await $.ui.open({ id: PANE, title: who?.name ?? 'avatar7' })
      return { text: opened.isPlaced ? `${who?.name ?? 'avatar7'} is watching.` : 'The pane needs a wider terminal.' }
    }
    if (!AVATARS.includes(id)) return { text: `Unknown avatar. Choose one of: ${AVATARS.join(', ')}.` }

    const dir = `${$.plugin.root}/personas/${id}`
    who = JSON.parse(String(await $.fs.read(`${dir}/persona.json`))) as Persona
    const { base64 } = await $.fs.read(`${dir}/face.rgb`, { as: 'bytes' })
    face = Uint8Array.fromBase64(base64)
    await $.store.set('avatar', id)
    await $.ui.open({ id: PANE, title: who.name })

    const text = personalize(who.greeting, userName, who.nobody)
    lineLength = text.length
    typed = 0
    speakUntil = frame + Math.ceil(text.length / 2) + 10
    await update($, line, () => ({ text, at: frame }) satisfies Line)
    if (!(await read($, isMuted))) {
      const voice = who
      $.clock.after(1, async () => {
        await $.process.run([POWERSHELL, '-NoProfile', '-Command', speakScript(voice, await read($, volume))], {
          stdin: text,
          timeoutMs: 30_000,
        })
      })
    }

    return { text: `${who.name} takes over.` }
  })

  on('command.run', { command: 'avatar-talk' }, async () => {
    queued = 'talk'
    return { text: `${who?.name ?? 'avatar7'} reads the conversation.` }
  })

  on('command.run', { command: 'avatar-mute' }, async $ => {
    const muted = await update($, isMuted, was => !was)
    return { text: muted ? 'The avatar falls silent.' : 'The avatar speaks again.' }
  })

  // Only what the user typed, at the terminal or through Remote Control.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      asked = e.text.replace(/\s+/g, ' ').trim().slice(0, ASKED_CHARS)
    }
    return next(e)
  })

  // The verdict before the mode settles it: an ask may put up the prompt.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id !== undefined) {
      askSince = frame
      askCall = describe({ ...(e.input as Record<string, unknown>), tool: e.tool })
      mood = 'wait'
      moodUntil = Infinity
    }
    return verdict
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    askSince = null

    const isMesh = e.tool.startsWith('mcp__mesh7__')
    const call = describe(e as unknown as Record<string, unknown>)

    // Held for a human: wait, eyes fixed, until the clock sees the decision.
    const held = isMesh ? MESH_HELD.exec(ran.text ?? '') : null
    if (held !== null) {
      heldId = held[1] ?? null
      heldCall = call
      mood = 'wait'
      moodUntil = Infinity
      queued = { mood: 'wait', event: `call HELD for human approval: ${call}` }
      return ran
    }

    const isMeshDeny = isMesh && ran.deny === undefined && ran.isError === true && MESH_DENY.test(ran.text ?? '')
    const now: Mood = ran.deny !== undefined || isMeshDeny ? 'deny' : ran.isError === true ? 'error' : 'watch'

    // A held call keeps the waiting face; the others set theirs.
    if (heldId === null) {
      mood = now
      moodUntil = frame + (now === 'watch' ? 12 : 30)
    }

    const quiet = now === 'watch' ? 45_000 / FRAME_MS : 5_000 / FRAME_MS
    if (isSpeaking || queued !== null || frame - lastSpoke < quiet) return ran
    queued = {
      mood: now,
      event:
        now === 'deny'
          ? `call DENIED: ${call} (${(ran.deny ?? ran.text ?? '').slice(0, 120)})`
          : now === 'error'
            ? `call FAILED: ${call}`
            : `call succeeded: ${call}`,
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const last = await read($, line)
    const shown = last.text.slice(0, typed)
    const color = who?.color ?? '#00ff9c'

    if (e.surface !== 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text>{who?.name ?? 'avatar7'}</Text>
          <Text>{shown}</Text>
        </Box>
      )
    }

    const { Box, Text, Raster, Button } = $.ui.resolve(e)
    const muted = await read($, isMuted)
    const vol = await read($, volume)
    size = fit(e.props.bodyColumns, e.props.scroll.bodyRows)
    return (
      // viewport.rows is the whole surface: taller than the pane, which clips the rest.
      <Box flexDirection="column" flexGrow={1} width="100%" height={e.viewport?.rows ?? H / 2 + 2} backgroundColor="#000000">
        <Raster key={FACE} columns={size} rows={size / 2} cells={cells()} />
        <Text color={color} backgroundColor="#000000">
          {shown.length > 0 ? `> ${shown}` : '> ...'}
        </Text>
        {heldId !== null && (
          <Text color="#7a5cff" backgroundColor="#000000">
            {`waiting: mesh approve ${heldId}`}
          </Text>
        )}
        <Box flexDirection="row" gap={2} backgroundColor="#000000">
          <Button key="talk" label="talk" hotkey="t" plain dimColor onPress={() => (queued = 'talk')} />
          <Button
            key="mute"
            label={muted ? 'unmute' : 'mute'}
            hotkey="m"
            plain
            dimColor
            onPress={() => update($, isMuted, was => !was)}
          />
          <Box flexDirection="row" gap={1} backgroundColor="#000000">
            <Text dimColor backgroundColor="#000000">vol</Text>
            <Button
              key="quieter"
              label="-"
              plain
              dimColor
              onPress={async () => {
                const v = await update($, volume, was => Math.max(0, was - VOLUME_STEP))
                await $.store.set('volume', v)
              }}
            />
            <Text dimColor backgroundColor="#000000">{String(vol)}</Text>
            <Button
              key="louder"
              label="+"
              plain
              dimColor
              onPress={async () => {
                const v = await update($, volume, was => Math.min(100, was + VOLUME_STEP))
                await $.store.set('volume', v)
              }}
            />
          </Box>
        </Box>
      </Box>
    )
  })
}
