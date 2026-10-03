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
const COLS = W
const ROWS = H / 2

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
}

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

export const register: Register = on => {
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

    // CRT: scanlines, a rolling bar, and snow when glitching.
    if (y % 2 === 1) k *= 0.7
    if (y === Math.floor((frame * 0.8) % H)) k *= 1.35
    if (isGlitch && noise(x, y + frame) < 0.04) return 0xffffff

    const c = (v: number) => Math.min(255, Math.round(v * k))
    return (c(r) << 16) | (c(g) << 8) | c(b)
  }

  const cells = (): string => {
    const words = new Uint32Array(COLS * ROWS * 3)
    for (let row = 0; row < ROWS; row++) {
      for (let x = 0; x < COLS; x++) {
        const i = (row * COLS + x) * 3
        words[i] = 0x2580
        words[i + 1] = pixel(x, row * 2)
        words[i + 2] = pixel(x, row * 2 + 1)
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
      void $.ui.blit({ requestId: PANE, key: FACE, cells: cells() })
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

    const text = who.greeting
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
            system: voice.persona + STYLE,
            prompt: `Event: ${event}`,
            maxTokens: 80,
            timeoutMs: 15_000,
          })
          const pool = voice.fallback[now]
          const text = r.isAnswered ? r.text.trim().split('\n')[0] : pool[frame % pool.length]
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
    return (
      <Box flexDirection="column">
        <Raster key={FACE} columns={COLS} rows={ROWS} cells={cells()} />
        <Text color={color}>{shown.length > 0 ? `> ${shown}` : '> ...'}</Text>
      </Box>
    )
  })
}
