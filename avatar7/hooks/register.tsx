import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Announce, Line } from '../types'

const PANE = 'avatar7'
const FACE = 'face'
const FRAME_MS = 66
const DEFAULT = 'shodan'
const AVATARS = ['shodan', 'hal', 'glados', 'ada', 'duck7', 'pod042', 'kaneda', 'commis', 'fox', 'adjutant', 'morte', 'pda']

// Portraits are baked by tools/bake.py into W x H raw RGB pixels; each cell
// is an upper half block, so two pixel rows per cell row.
const W = 64
const H = 64
const MIN_SIZE = 16

// Rows kept under the face for the line, which may wrap once, the pending
// approval, the buttons and the two rules between them.
const TEXT_ROWS = 6

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
// The avatar on duty, by its id: other mods read it (jukebox7 picks its music).
const onDuty = atom({ plugin: 'avatar7', key: 'avatar' } as const, '')
// The on-duty persona's color, read by jukebox7 to light its pane alike.
const tint = atom({ plugin: 'avatar7', key: 'color' } as const, '')
// The mods that asked for a voice, by plugin name: each publishes its own
// `announce` key, and the avatar hears the write.
const announcers = atom({ plugin: 'avatar7', key: 'announcers' } as const, {} as Record<string, Announce>)

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

// A persona with a `piper` voice speaks through Piper (local neural TTS, on
// the CPU, in WSL), its WAV played by Windows through SAPI; SAPI stays the voice
// when Piper or the model is missing. Piper lives in ~/.local/share/piper:
// .venv with piper-tts, voices/<name>.onnx. A private voice at
// custom/<avatar id>.onnx wins over the persona's (its own pace, no filter
// unless custom/<id>.fx holds one): voices one keeps out of the repo.
// Synthesis and playback are two runs so the line can be typed with the voice:
// this one prints the WAV's path and its length in seconds, or speaks through
// SAPI itself and prints nothing when Piper is missing.
const PIPER = '$HOME/.local/share/piper'
export const synthArgv = (id: string, who: Persona, vol: number): string[] => [
  'bash',
  '-c',
  [
    't=$(cat)',
    `m="${PIPER}/voices/$1.onnx"`,
    `c="${PIPER}/custom/$6"`,
    'if [ -n "$6" ] && [ -f "$c.onnx" ]; then m="$c.onnx"; set -- "$c" "$2" 1 "$4" "$(cat "$c.fx" 2>/dev/null)" "$6"; fi',
    `if [ -n "$1" ] && [ -f "$m" ] && [ -x "${PIPER}/.venv/bin/python" ]; then`,
    '  w=$(mktemp --suffix=.wav)',
    `  printf %s "$t" | "${PIPER}/.venv/bin/python" -m piper -m "$m" -f "$w" --volume "$2" --length-scale "$3" 2>/dev/null || exit 1`,
    // The persona's ffmpeg filter (pitch, metal, glitch), skipped without ffmpeg.
    '  if [ -n "$5" ] && command -v ffmpeg >/dev/null; then',
    '    f=$(mktemp --suffix=.wav)',
    '    ffmpeg -loglevel error -y -i "$w" -af "$5" "$f" && mv "$f" "$w"',
    '  fi',
    `  "${PIPER}/.venv/bin/python" -c 'import sys, wave; w = wave.open(sys.argv[1]); print(sys.argv[1]); print(w.getnframes() / w.getframerate())' "$w"`,
    'else',
    `  printf %s "$t" | "${POWERSHELL}" -NoProfile -Command "$4"`,
    'fi',
  ].join('\n'),
  'avatar7-speak',
  who.piper?.voice ?? '',
  String(Math.max(0, Math.min(100, vol)) / 100),
  String(who.piper?.lengthScale ?? 1),
  speakScript(who, vol),
  who.piper?.fx ?? '',
  id,
]

// SAPI plays the WAV: SoundPlayer on a \\wsl.localhost path can fall silent
// (returns at once, no error) while SAPI still reads it.
const playArgv = (wav: string): string[] => [
  'bash',
  '-c',
  `"${POWERSHELL}" -NoProfile -Command "\\$v=New-Object -ComObject SAPI.SpVoice; \\$s=New-Object -ComObject SAPI.SpFileStream; \\$s.Open('$(wslpath -w "$1")'); [void]\\$v.SpeakStream(\\$s); \\$s.Close()"; rm -f "$1"`,
  'avatar7-play',
  wav,
]

// The line waits for its voice: typed from when SAPI starts the WAV (PowerShell
// takes ~0.3 s to get there), over the audio's length. Without a WAV within
// HOLD_FRAMES (Piper missing, SAPI speaking itself) it is typed anyway.
const PLAY_LEAD_FRAMES = 5
const HOLD_FRAMES = 75

const STYLE = ' No quotes, no emoji, no em dash.'

// How much of the user's last prompt the avatar reads, so it judges a call
// against what was asked rather than the bare gesture.
const ASKED_CHARS = 200

// When poked, the avatar reads the last messages of the conversation, each cut
// to this many characters.
const TALK_MESSAGES = 6
const TALK_CHARS = 300

type Mood = 'idle' | 'watch' | 'deny' | 'error' | 'wait'

// A write another mod made, as an announce the avatar keeps, or undefined:
// its own key `announce`, a calm or amber face, and the event in words.
export const heard = (w: { plugin: string; key: string; value: unknown }): Announce | undefined => {
  if (w.key !== 'announce' || w.plugin === 'avatar7') return undefined
  const a = w.value as Partial<Announce> | undefined
  return a !== undefined && (a.mood === 'watch' || a.mood === 'error') && typeof a.event === 'string'
    ? { mood: a.mood, event: a.event }
    : undefined
}

// A line to speak: an event in a mood, or the user's poke, which reads the
// conversation first.
type Ask = { mood: Mood; event: string } | 'talk'

type Approval = { id: string; status: string }

type Persona = {
  name: string
  voice: string
  rate: number
  pitch?: number
  // Piper voice name and pace (length-scale, under 1 is faster).
  // fx: an ffmpeg audio filter run on the WAV, from aresample=22050 so pitch
  // shifts by asetrate hold whatever the voice's own rate.
  piper?: { voice: string; lengthScale?: number; fx?: string }
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
  // Characters typed per frame, from which frame, and which line they belong to.
  let typeRate = 2
  let typeFrom = 0
  let lineSeq = 0
  let lastSpoke = -Infinity
  let isSpeaking = false
  let face: Uint8Array | null = null
  let who: Persona | null = null
  // The avatar `who` was read from, so a line keeps its voice through a switch.
  let whoId = ''
  let size = W
  let asked = ''
  // The next line to speak; the clock, which holds the session's $, speaks it.
  let queued: Ask | null = null
  // An avatar picked in the pane or by /avatar; the clock swaps it in.
  let pendingAvatar: string | null = null
  let isPicking = false
  // Display names for the picker, read from each persona.json.
  const names: Record<string, string> = {}
  // A mesh7 approval this session's call is held on, by its short id.
  let heldId: string | null = null
  let heldCall = ''
  let isPolling = false
  // A call put to the permission prompt (a mesh7 hook's `ask`, a settings rule).
  let askSince: number | null = null
  let askCall = ''

  // A new line under the face: held until its voice is ready, unless muted.
  const startLine = (text: string, isQuiet: boolean): number => {
    lineLength = text.length
    typed = 0
    typeRate = 2
    typeFrom = isQuiet ? frame : frame + HOLD_FRAMES
    speakUntil = typeFrom + Math.ceil(text.length / 2) + 10
    lineSeq += 1
    return lineSeq
  }

  // The WAV synthArgv made, its line then typed over the audio's length while
  // SAPI plays it; '' when SAPI already spoke.
  const voiced = (seq: number, stdout: string, length: number): string => {
    const [wav = '', seconds = ''] = stdout.trim().split('\n')
    const frames = Math.round((Number(seconds) * 1000) / FRAME_MS)
    if (wav === '' || !(frames > 0)) return ''
    if (seq === lineSeq) {
      typeRate = Math.max(length / frames, 0.2)
      typeFrom = frame + PLAY_LEAD_FRAMES
      speakUntil = typeFrom + frames
    }
    return wav
  }

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

    // Eyes: a slow glow; a face (one with a mouth) blinks now and then, the
    // mouth itself stays still; a lens (no mouth) pulses while it speaks.
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
    // A daemon's background session (a spare kept warm, a `claude --bg`)
    // inherits the plugin dirs but nobody watches it: no face, no voice.
    const kind = await $.process.run(['sh', '-c', 'printf %s "$CLAUDE_CODE_SESSION_KIND"'])
    if (kind.stdout === 'bg') return next(e)

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
    await update($, onDuty, () => id)
    try {
      const dir = `${$.plugin.root}/personas/${id}`
      who = JSON.parse(String(await $.fs.read(`${dir}/persona.json`))) as Persona
      whoId = id
      await update($, tint, () => who?.color ?? '')
      const { base64 } = await $.fs.read(`${dir}/face.rgb`, { as: 'bytes' })
      face = Uint8Array.fromBase64(base64)
    } catch {
      $.ui.log(`avatar7: personas/${id} unreadable, run tools/bake.py ${id}`)
    }
    for (const each of AVATARS) {
      try {
        names[each] = (JSON.parse(String(await $.fs.read(`${$.plugin.root}/personas/${each}/persona.json`))) as Persona).name
      } catch {
        names[each] = each
      }
    }

    const last = await read($, line)
    lineLength = last.text.length
    typed = lineLength

    $.clock.every(FRAME_MS, () => {
      frame += 1
      if (pendingAvatar !== null) {
        const id = pendingAvatar
        pendingAvatar = null
        void (async () => {
          const dir = `${$.plugin.root}/personas/${id}`
          who = JSON.parse(String(await $.fs.read(`${dir}/persona.json`))) as Persona
          whoId = id
          await update($, tint, () => who?.color ?? '')
          const { base64 } = await $.fs.read(`${dir}/face.rgb`, { as: 'bytes' })
          face = Uint8Array.fromBase64(base64)
          await $.store.set('avatar', id)
          await update($, onDuty, () => id)
          await $.ui.open({ id: PANE, title: who.name })
  
          const text = personalize(who.greeting, userName, who.nobody)
          const isQuiet = await read($, isMuted)
          const seq = startLine(text, isQuiet)
          await update($, line, () => ({ text, at: frame }) satisfies Line)
          if (!isQuiet) {
            const voice = who
            $.clock.after(1, async () => {
              const made = await $.process.run(synthArgv(id, voice, await read($, volume)), {
                stdin: text,
                timeoutMs: 30_000,
              })
              const wav = voiced(seq, made.stdout, text.length)
              if (wav !== '') await $.process.run(playArgv(wav), { timeoutMs: 60_000 })
            })
          }
        })()
      }
      if (frame > moodUntil && mood !== 'idle') mood = 'idle'
      void $.ui.blit({ requestId: PANE, key: FACE, columns: size, rows: size / 2, cells: cells() })
      if (typed < lineLength && frame >= typeFrom) {
        typed = Math.min(lineLength, typed + typeRate)
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
      const voiceId = whoId
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
          const isQuiet = await read($, isMuted)
          const seq = startLine(text, isQuiet)
          await update($, line, () => ({ text, at: frame }) satisfies Line)
          if (!isQuiet) {
            const made = await $.process.run(synthArgv(voiceId, voice, await read($, volume)), {
              stdin: text,
              timeoutMs: 30_000,
            })
            const wav = voiced(seq, made.stdout, text.length)
            if (wav !== '') await $.process.run(playArgv(wav), { timeoutMs: 60_000 })
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

    pendingAvatar = id
    return { text: `${names[id] ?? id} takes over.` }
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

  // A mod that wants its toasts voiced publishes `announce` under its own
  // name (atelier-bell, usage-bell, jukebox7...): the avatar keeps a record
  // of each, so plugging a mod in is enough, and no mod depends on avatar7.
  on('state.set', async ($, e, next) => {
    const done = await next(e)
    const w = e as { plugin: string; key: string; value: unknown }
    const a = done.isSet ? heard(w) : undefined
    if (a !== undefined) await update($, announcers, was => ({ ...was, [w.plugin]: a }))
    return done
  })

  // Their toasts, announced in the avatar's own voice past the tool-call
  // rate limits; a warning in amber.
  on('ui.toast', async ($, e, next) => {
    const from = next.origin.plugin
    const bell = from === undefined || from === 'avatar7' ? undefined : (await read($, announcers))[from]
    if (bell !== undefined && who !== null) {
      if (heldId === null && askSince === null) {
        mood = bell.mood
        moodUntil = frame + 30
      }
      queued = { mood: bell.mood, event: `${bell.event}: ${e.text}` }
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
    const shown = last.text.slice(0, Math.floor(typed))
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
    const current = await read($, onDuty)
    size = fit(e.props.bodyColumns, e.props.scroll.bodyRows)
    // Rules in the persona's color between the face, the line and the
    // controls, drawn as a terminal's: a label, a status on the right, a
    // cursor that blinks at each redraw, dashes that glitch on a denial.
    const cols = Math.max(8, e.props.bodyColumns)
    const isBlink = Math.floor(frame / REFIT_FRAMES) % 2 === 0
    const moodColor = mood === 'idle' ? color : `#${TINT[mood].toString(16).padStart(6, '0')}`
    const seconds = Math.floor((frame * FRAME_MS) / 1000)
    const clock = [seconds / 3600, (seconds / 60) % 60, seconds % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':')
    const dashes = (n: number, salt: number): string =>
      Array.from({ length: Math.max(0, n) }, (_, i) =>
        mood === 'deny' && noise(frame + salt, i) < 0.12 ? '╳▚░'[i % 3] : '─',
      ).join('')
    const rule = (key: string, label: string, status: string, statusColor: string, salt: number) => {
      const left = `╾─┤ ${label} ├`
      const right = ` ${status} ${isBlink ? '█' : ' '}╼`
      return (
        <Text key={key} backgroundColor="#000000" wrap="truncate">
          <Text color={color} dimColor>{'╾─┤ '}</Text>
          <Text color={color} bold>{label}</Text>
          <Text color={color} dimColor>{' ├' + dashes(cols - left.length - right.length, salt) + ' '}</Text>
          <Text color={statusColor}>{`${status} ${isBlink ? '█' : ' '}`}</Text>
          <Text color={color} dimColor>{'╼'}</Text>
        </Text>
      )
    }
    return (
      // The body's own height, so the controls can sit on its last row.
      <Box flexDirection="column" flexGrow={1} width="100%" height={e.props.scroll.bodyRows} backgroundColor="#000000">
        <Box flexDirection="row" justifyContent="center" width="100%" backgroundColor="#000000">
          <Raster key={FACE} columns={size} rows={size / 2} cells={cells()} />
        </Box>
        {rule('rule-face', (who?.name ?? 'avatar7').toUpperCase(), `[${mood.toUpperCase()}]`, moodColor, 0)}
        <Text color={color} backgroundColor="#000000">
          {shown.length > 0 ? `> ${shown}` : '> ...'}
          {typed < last.text.length ? '█' : ''}
        </Text>
        {heldId !== null && (
          <Text color="#7a5cff" backgroundColor="#000000">
            {`waiting: mesh approve ${heldId}`}
          </Text>
        )}
        <Box flexGrow={1} backgroundColor="#000000" />
        {rule('rule-controls', 'CTRL', `UP ${clock}`, color, 7)}
        {isPicking && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2} backgroundColor="#000000">
            {AVATARS.map(id => (
              <Button
                key={`pick-${id}`}
                label={names[id] ?? id}
                plain
                dimColor={id !== current}
                onPress={() => {
                  if (id !== current) pendingAvatar = id
                  isPicking = false
                  $.ui.invalidate('ui.render')
                }}
              />
            ))}
          </Box>
        )}
        <Box flexDirection="row" gap={2} backgroundColor="#000000">
          <Button key="talk" label="talk" hotkey="t" plain dimColor onPress={() => (queued = 'talk')} />
          <Button
            key="avatars"
            label={isPicking ? 'close' : 'avatars'}
            hotkey="c"
            plain
            dimColor
            onPress={() => {
              isPicking = !isPicking
              $.ui.invalidate('ui.render')
            }}
          />
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
