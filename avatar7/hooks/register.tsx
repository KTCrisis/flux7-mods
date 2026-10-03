import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Line } from '../types'

const PANE = 'avatar7'
const FACE = 'face'
const FRAME_MS = 66
const DEFAULT = 'shodan'
const AVATARS = ['shodan', 'hal', 'glados', 'ada']

// Portraits are baked by tools/bake.py into W x H raw RGB pixels; each cell
// is an upper half block, so two pixel rows per cell row.
const W = 64
const H = 64
const MIN_SIZE = 16

// The face's side in pixels for a pane body: as wide as the body, as tall as
// the surface leaves (two pixels per row, a few rows kept for the text), even,
// never past the baked portrait.
const fit = (columns: number, rows: number): number => {
  const side = Math.min(W, columns, Math.max(MIN_SIZE / 2, rows - 6) * 2)
  return Math.max(MIN_SIZE, side - (side % 2))
}

const line = atom({ plugin: 'avatar7', key: 'line' } as const, { text: '', at: 0 })
const isMuted = atom({ plugin: 'avatar7', key: 'isMuted' } as const, false)

// What mesh7 answers when it refuses a call (mcp/server.go, halt/halt.go).
const MESH_DENY = /Policy denied|Approval denied|Denied by supervisor|Approval timed out|halted by operator/

const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const speakScript = (voice: string, rate: number) =>
  '[Console]::InputEncoding=[Text.Encoding]::UTF8; $t=[Console]::In.ReadToEnd(); ' +
  'Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
  `$s.SelectVoice("${voice}"); $s.Rate=${rate}; $s.Speak($t)`

const STYLE = ' No quotes, no emoji, no em dash.'

type Mood = 'idle' | 'watch' | 'deny' | 'error'

type Persona = {
  name: string
  voice: string
  rate: number
  color: string
  eyes: { x: number; y: number; rx: number; ry: number }[]
  mouth: { x: number; y: number; half: number } | null
  greeting: string
  persona: string
  fallback: Record<Mood, string[]>
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
      const mix = mood === 'watch' ? 0.3 : 0.65
      r = r * (1 - mix) + ((tint >> 16) & 0xff) * lum * 1.3 * mix
      g = g * (1 - mix) + ((tint >> 8) & 0xff) * lum * 1.3 * mix
      b = b * (1 - mix) + (tint & 0xff) * lum * 1.3 * mix
    }

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
      }
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
        await $.process.run([POWERSHELL, '-NoProfile', '-Command', speakScript(voice.voice, voice.rate)], {
          stdin: text,
          timeoutMs: 30_000,
        })
      })
    }

    return { text: `${who.name} takes over.` }
  })

  on('command.run', { command: 'avatar-mute' }, async $ => {
    const muted = await update($, isMuted, was => !was)
    return { text: muted ? 'The avatar falls silent.' : 'The avatar speaks again.' }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    try {
      const isMeshDeny =
        e.tool.startsWith('mcp__mesh7__') &&
        ran.deny === undefined &&
        ran.isError === true &&
        MESH_DENY.test(ran.text ?? '')
      const now: Mood =
        ran.deny !== undefined || isMeshDeny ? 'deny' : ran.isError === true ? 'error' : 'watch'

      mood = now
      moodUntil = frame + (now === 'watch' ? 12 : 30)

      const quiet = now === 'watch' ? 45_000 / FRAME_MS : 5_000 / FRAME_MS
      if (isSpeaking || who === null || frame - lastSpoke < quiet) return ran
      lastSpoke = frame
      isSpeaking = true

      const voice = who
      const call = describe(e as unknown as Record<string, unknown>)
      const event =
        now === 'deny'
          ? `call DENIED: ${call} (${(ran.deny ?? ran.text ?? '').slice(0, 120)})`
          : now === 'error'
            ? `call FAILED: ${call}`
            : `call succeeded: ${call}`

      $.clock.after(1, async () => {
        try {
          const r = await $.model.complete({
            model: 'haiku',
            system: personalize(voice.persona, userName, voice.nobody) + STYLE,
            prompt: `Event: ${event}`,
            maxTokens: 80,
            timeoutMs: 15_000,
          })
          const pool = voice.fallback[now]
          const text = r.isAnswered
            ? r.text.trim().split('\n')[0]
            : personalize(pool[frame % pool.length], userName, voice.nobody)
          lineLength = text.length
          typed = 0
          speakUntil = frame + Math.ceil(text.length / 2) + 10
          await update($, line, () => ({ text, at: frame }) satisfies Line)
          if (!(await read($, isMuted))) {
            await $.process.run([POWERSHELL, '-NoProfile', '-Command', speakScript(voice.voice, voice.rate)], {
              stdin: text,
              timeoutMs: 30_000,
            })
          }
        } finally {
          isSpeaking = false
        }
      })
    } catch {
      isSpeaking = false
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

    const { Box, Text, Raster } = $.ui.resolve(e)
    size = fit(e.props.bodyColumns, e.viewport?.rows ?? H / 2 + 6)
    return (
      // viewport.rows is the whole surface: taller than the pane, which clips the rest.
      <Box flexDirection="column" flexGrow={1} width="100%" height={e.viewport?.rows ?? H / 2 + 2} backgroundColor="#000000">
        <Raster key={FACE} columns={size} rows={size / 2} cells={cells()} />
        <Text color={color} backgroundColor="#000000">
          {shown.length > 0 ? `> ${shown}` : '> ...'}
        </Text>
      </Box>
    )
  })
}
