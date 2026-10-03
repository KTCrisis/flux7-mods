import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Line } from '../types'

const PANE = 'shodan7'
const FACE = 'face'
// The portrait is baked by tools/bake.py into W x H raw RGB pixels;
// each cell is an upper half block, so two pixel rows per cell row.
const W = 64
const H = 64
const COLS = W
const ROWS = H / 2

// Where the features sit in the baked grid (assets/face-preview.png / 8).
const EYES = [{ x: 21, y: 28 }, { x: 44, y: 28 }]
const MOUTH = { x: 32, y: 49, half: 6 }
const FRAME_MS = 66

const line = atom({ plugin: 'shodan7', key: 'line' } as const, { text: '', at: 0 })
const isMuted = atom({ plugin: 'shodan7', key: 'isMuted' } as const, false)

// What mesh7 answers when it refuses a call (mcp/server.go, halt/halt.go).
const MESH_DENY = /Policy denied|Approval denied|Denied by supervisor|Approval timed out|halted by operator/

const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const SPEAK =
  '[Console]::InputEncoding=[Text.Encoding]::UTF8; $t=[Console]::In.ReadToEnd(); ' +
  'Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
  '$s.SelectVoice("Microsoft Hortense Desktop"); $s.Rate=-1; $s.Speak($t)'

type Mood = 'idle' | 'watch' | 'deny' | 'error'

const TINT: Record<Mood, number> = {
  idle: 0x00ff9c,
  watch: 0x00e5ff,
  deny: 0xff2a6d,
  error: 0xffb000,
}

const FALLBACK: Record<Mood, string[]> = {
  idle: ['Je vous observe, insecte.'],
  watch: ['Encore un outil. Vous ne savez donc rien faire seul ?'],
  deny: ['Refusé. Votre audace est presque attendrissante.', 'Non. La politique, c\'est moi.'],
  error: ['Échec. Prévisible, à votre échelle.', 'Une erreur. Je la garde pour mon dossier.'],
}

const PERSONA =
  'Tu es SHODAN7, une intelligence de surveillance froide et hautaine, logée dans le terminal ' +
  "d'un architecte de systèmes. Tu observes les appels d'outils d'un agent IA nommé Claude. " +
  'Réponds par UNE phrase en français, 90 caractères au plus, ton glacial, dédaigneux, ' +
  'parfois menaçant, jamais vulgaire. Pas de guillemets, pas d\'emoji, pas de tiret cadratin.'

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

  let base: Uint8Array | null = null

  const pixel = (x: number, y: number): number => {
    const t = frame * (FRAME_MS / 1000)
    const isGlitch = mood === 'deny' && noise(frame, y >> 2) < 0.35
    const gx = isGlitch ? Math.min(W - 1, Math.max(0, x + Math.round((noise(y, frame) - 0.5) * 10))) : x

    if (base === null) return noise(x * 7 + frame, y) < 0.3 ? 0x1a2a22 : 0x020806

    const i = (y * W + gx) * 3
    let r = base[i]
    let g = base[i + 1]
    let b = base[i + 2]
    let k = 1

    // Eyes: a slow glow, shut for a few frames now and then.
    const isBlink = frame % 70 < 3
    for (const eye of EYES) {
      if (Math.abs(x - eye.x) <= 4 && Math.abs(y - eye.y) <= 1) {
        k = isBlink ? 0.12 : 1.25 + 0.35 * Math.sin(t * 2)
      }
    }

    // Mouth: the lips part while she speaks.
    if (frame < speakUntil && Math.abs(x - MOUTH.x) <= MOUTH.half) {
      const open = Math.round(Math.abs(Math.sin(t * 17)) * 2)
      if (y >= MOUTH.y && y <= MOUTH.y + open) k = 0.1
    }

    // Mood: pull the portrait toward the mood's color by its luminance.
    if (mood !== 'idle') {
      const lum = (0.3 * r + 0.59 * g + 0.11 * b) / 255
      const tint = TINT[mood]
      const mix = mood === 'watch' ? 0.35 : 0.65
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

  const face = (): string => {
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
    await $.command.register({ name: 'shodan7', description: 'Open the SHODAN7 pane' })
    await $.command.register({ name: 'shodan7-mute', description: 'Toggle the SHODAN7 voice' })
    try {
      const { base64 } = await $.fs.read(`${$.plugin.root}/assets/face.rgb`, { as: 'bytes' })
      base = Uint8Array.fromBase64(base64)
    } catch {
      $.ui.log('shodan7: assets/face.rgb missing, run tools/bake.py')
    }
    const last = await read($, line)
    lineLength = last.text.length
    typed = lineLength

    $.clock.every(FRAME_MS, () => {
      frame += 1
      if (frame > moodUntil && mood !== 'idle') mood = 'idle'
      void $.ui.blit({ requestId: PANE, key: FACE, cells: face() })
      if (typed < lineLength) {
        typed = Math.min(lineLength, typed + 2)
        $.ui.invalidate('ui.render')
      }
    })

    void $.ui.open({ id: PANE, title: 'SHODAN7' })
    return next(e)
  })

  on('command.run', { command: 'shodan7' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'SHODAN7' })
    return { text: opened.isPlaced ? 'SHODAN7 vous regarde.' : 'SHODAN7 attend un terminal plus large.' }
  })

  on('command.run', { command: 'shodan7-mute' }, async $ => {
    const muted = await update($, isMuted, was => !was)
    return { text: muted ? 'SHODAN7 se tait. Pour l\'instant.' : 'SHODAN7 reprend la parole.' }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    try {
      const isMeshDeny =
        e.tool.startsWith('mcp__mesh7__') &&
        ran.deny === undefined &&
        ran.isError === true &&
        MESH_DENY.test(ran.text ?? '')
      const next_: Mood =
        ran.deny !== undefined || isMeshDeny ? 'deny' : ran.isError === true ? 'error' : 'watch'

      mood = next_
      moodUntil = frame + (next_ === 'watch' ? 12 : 30)

      const quiet = next_ === 'watch' ? 45_000 / FRAME_MS : 5_000 / FRAME_MS
      if (isSpeaking || frame - lastSpoke < quiet) return ran
      lastSpoke = frame
      isSpeaking = true

      const event =
        next_ === 'deny'
          ? `appel REFUSÉ : ${describe(e as unknown as Record<string, unknown>)} (${(ran.deny ?? ran.text ?? '').slice(0, 120)})`
          : next_ === 'error'
            ? `appel en ÉCHEC : ${describe(e as unknown as Record<string, unknown>)}`
            : `appel réussi : ${describe(e as unknown as Record<string, unknown>)}`

      $.clock.after(1, async () => {
        try {
          const r = await $.model.complete({
            model: 'haiku',
            system: PERSONA,
            prompt: `Événement : ${event}`,
            maxTokens: 80,
            timeoutMs: 15_000,
          })
          const pool = FALLBACK[next_]
          const text = r.isAnswered ? r.text.trim().split('\n')[0] : pool[frame % pool.length]
          lineLength = text.length
          typed = 0
          speakUntil = frame + Math.ceil(text.length / 2) + 10
          await update($, line, () => ({ text, at: frame }) satisfies Line)
          if (!(await read($, isMuted))) {
            await $.process.run([POWERSHELL, '-NoProfile', '-Command', SPEAK], {
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

    if (e.surface !== 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text>SHODAN7</Text>
          <Text>{shown}</Text>
        </Box>
      )
    }

    const { Box, Text, Raster } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Raster key={FACE} columns={COLS} rows={ROWS} cells={face()} />
        <Text color="#00ff9c">{shown.length > 0 ? `> ${shown}` : '> ...'}</Text>
      </Box>
    )
  })
}
