import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Line } from '../types'

const PANE = 'shodan7'
const FACE = 'face'
const COLS = 48
const ROWS = 24 // two pixels per cell with the upper half block
const W = COLS
const H = ROWS * 2
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

const scale = (rgb: number, k: number): number => {
  const c = (shift: number) => Math.min(255, Math.round(((rgb >> shift) & 0xff) * k))
  return (c(16) << 16) | (c(8) << 8) | c(0)
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

  const pixel = (x: number, y: number): number => {
    const t = frame * (FRAME_MS / 1000)
    const tint = TINT[mood]
    const isGlitch = mood === 'deny' && noise(frame, y >> 2) < 0.35
    const gx = isGlitch ? x + Math.round((noise(y, frame) - 0.5) * 8) : x

    const u = (gx - W / 2) / (W * 0.4)
    const v = (y - H / 2) / (H * 0.45)
    const d = u * u + v * v
    let k = 0

    // Wireframe skull: rim, latitudes, meridians.
    if (Math.abs(d - 1) < 0.07) k = 0.9
    else if (d < 1) {
      if (y % 5 === 0) k = 0.18
      const half = Math.sqrt(Math.max(0.0001, 1 - v * v))
      const m = (u / half) * 3
      if (Math.abs(m - Math.round(m)) < 0.08) k = Math.max(k, 0.22)
    }

    // Eyes: almonds with a drifting pupil and an occasional blink.
    const isBlink = frame % 70 < 3
    const gaze = Math.sin(t * 0.7) * 0.07
    for (const side of [-1, 1]) {
      const ex = (u - side * 0.38) / 0.17
      const ey = (v + 0.2) / (isBlink ? 0.015 : 0.07)
      if (ex * ex + ey * ey < 1) {
        k = Math.max(k, 0.75)
        const px = (u - side * 0.38 - gaze) / 0.05
        const py = (v + 0.2) / 0.05
        if (!isBlink && px * px + py * py < 1) return 0xe8fff8
      }
    }

    // Mouth: a line that opens while speaking.
    const open = frame < speakUntil ? Math.abs(Math.sin(t * 17)) * 0.07 : 0
    if (Math.abs(u) < 0.32 && (Math.abs(v - 0.45 - open) < 0.025 || Math.abs(v - 0.45 + open) < 0.025)) {
      k = Math.max(k, 0.95)
    }

    // CRT: scanlines, a rolling bar, and snow when glitching.
    if (y % 2 === 1) k *= 0.55
    if (y === Math.floor((frame * 0.8) % H)) k = Math.min(1, k + 0.25)
    if (isGlitch && noise(x, y + frame) < 0.04) k = 1

    return k === 0 ? 0x020806 : scale(tint, k)
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
