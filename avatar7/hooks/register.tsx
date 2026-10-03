import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { Announce, Line, Say, Station } from '../types'

const PANE = 'avatar7'
const FACE = 'face'
const FRAME_MS = 66
const DEFAULT = 'shodan'
const AVATARS = ['shodan', 'hal', 'glados', 'ada', 'duck7', 'pod042', 'kaneda', 'commis', 'fox', 'adjutant', 'morte', 'pda', 'lain', 'tachikoma']

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
// The on-duty persona's station, read by jukebox7 for its avatar's pick.
const station = atom({ plugin: 'avatar7', key: 'station' } as const, { name: '', artists: [] } as Station)
// The mods that asked for a voice, by plugin name: each publishes its own
// `announce` key, and the avatar hears the write.
// True while a line is heard: jukebox7 lowers its music meanwhile.
const isVoicing = atom({ plugin: 'avatar7', key: 'isVoicing' } as const, false)
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
    'if [ -n "$6" ] && [ -f "$c.onnx" ]; then m="$c.onnx"; set -- "$c" "$2" 1 "$4" "$(cat "$c.fx" 2>/dev/null)" "$6" ""; fi',
    `if [ -n "$1" ] && [ -f "$m" ] && [ -x "${PIPER}/.venv/bin/python" ]; then`,
    '  w=$(mktemp --suffix=.wav)',
    // $7: a speaker of a multi-speaker model (vctk, libritts_r), by its id.
    `  printf %s "$t" | "${PIPER}/.venv/bin/python" -m piper -m "$m" \${7:+-s "$7"} -f "$w" --volume "$2" --length-scale "$3" 2>/dev/null || exit 1`,
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
  who.piper?.speaker === undefined ? '' : String(who.piper.speaker),
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
// How long PowerShell takes to start a detached playback, at most (measured
// ~0.3 s warm, more cold): the voice is held this much past the WAV's length.
const PLAY_START_MS = 900

// A command run in its own session: the engine kills a module's children on
// reload, and a line half spoken was cut with them.
const detachedArgv = (argv: string[]): string[] => ['bash', '-c', 'setsid "$0" "$@" </dev/null >/dev/null 2>&1 &', ...argv]
const HOLD_FRAMES = 75

// Rules every persona keeps, whatever its character: added to each prompt.
const STYLE = ' The user may write in French; you always answer in English. Never flattering. No quotes, no emoji, no em dash.'

// How much of the user's last prompt the avatar reads, so it judges a call
// against what was asked rather than the bare gesture.
const ASKED_CHARS = 200

// When poked, the avatar reads the last messages of the conversation, each cut
// to this many characters.
const TALK_MESSAGES = 6
const TALK_CHARS = 300

type Mood = 'idle' | 'watch' | 'deny' | 'error' | 'wait'

// Whether a write landed. The host answers a plain write without `isSet`
// (2.1.288, despite StateSetResult): only a write another one beat says false.
export const landed = (done: unknown): boolean => (done as { isSet?: boolean } | undefined)?.isSet !== false

// A write another mod made, as an announce the avatar keeps, or undefined:
// its own key `announce`, a calm or amber face, and the event in words.
export const heard = (w: { plugin: string; key: string; value: unknown }): Announce | undefined => {
  if (w.key !== 'announce' || w.plugin === 'avatar7') return undefined
  const a = w.value as Partial<Announce> | undefined
  return a !== undefined && (a.mood === 'watch' || a.mood === 'error') && typeof a.event === 'string'
    ? { mood: a.mood, event: a.event }
    : undefined
}

// A `say` another mod published: speak it now, no toast needed.
export const heardSay = (w: { plugin: string; key: string; value: unknown }): Say | undefined => {
  if (w.key !== 'say' || w.plugin === 'avatar7') return undefined
  const a = w.value as Partial<Say> | undefined
  return a !== undefined &&
    (a.mood === 'watch' || a.mood === 'error' || a.mood === 'deny' || a.mood === 'wait') &&
    typeof a.event === 'string' &&
    typeof a.at === 'number'
    ? { mood: a.mood, event: a.event, at: a.at }
    : undefined
}

// The run of like outcomes the last calls made: a third denial in a row, or
// a success after a string of failures, is news the line should carry.
export type Streak = { mood: 'watch' | 'deny' | 'error'; count: number }

export const nextStreak = (s: Streak, now: Streak['mood']): Streak =>
  s.mood === now ? { mood: now, count: s.count + 1 } : { mood: now, count: 1 }

const ordinal = (n: number): string =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`

export const streakNote = (before: Streak, after: Streak): string => {
  const what = (m: Streak['mood'], n: number) => (m === 'deny' ? 'denial' : 'failure') + (n > 1 ? 's' : '')
  if (after.mood !== 'watch' && after.count >= 2) return ` (${ordinal(after.count)} ${what(after.mood, 1)} in a row)`
  if (after.mood === 'watch' && before.mood !== 'watch' && before.count >= 3) {
    return ` (first success after ${before.count} ${what(before.mood, before.count)} in a row)`
  }
  return ''
}

// The avatar's last lines, given back to the model so it does not repeat
// its own wording over a long session.
const RECENT_LINES = 3

export const recentNote = (lines: string[]): string =>
  lines.length === 0 ? '' : `\nYour last lines, do not reuse their wording or openings:\n${lines.map(l => `- ${l}`).join('\n')}`

// A line to speak: an event in a mood, or the user's poke, which reads the
// conversation first; or, now and then, a moment of the persona's own story,
// a question it puts to the user, and its reaction to the user's answer.
type Ask =
  | { mood: Mood; event: string }
  | 'talk'
  | { story: string; mood: Mood }
  | 'question'
  | { question: string; answer: string }
  | Duo
  | { greet: string }

// One turn of a dialogue with a visiting persona: even turns are the host's,
// odd ones the guest's; `history` holds the lines said so far, by name.
export type Duo = { duo: string; turn: number; topic: 'session' | 'stories'; history: string[] }
export const DUO_TURNS = 6

// A guest for the persona on duty: any other avatar, its `friends` three
// times as likely as the rest, picked by `roll` in [0, 1).
const FRIEND_WEIGHT = 3

export const pickGuest = (avatars: string[], current: string, roll: number, friends: string[] = []): string | undefined => {
  const others = avatars.filter(a => a !== current)
  const weights = others.map(a => (friends.includes(a) ? FRIEND_WEIGHT : 1))
  let left = roll * weights.reduce((sum, w) => sum + w, 0)
  for (const [i, a] of others.entries()) {
    left -= weights[i] ?? 1
    if (left < 0) return a
  }
  return others.at(-1)
}

export type Story = { story: string; mood: Exclude<Mood, 'idle'> }

// One of the persona's own events, or undefined when it has none: a story
// or a question, even odds when it has both. `roll` and `pick` are in [0, 1).
export const pickEvent = (stories: Story[], canAsk: boolean, roll: number, pick: number): Ask | undefined => {
  const story = stories[Math.floor(pick * stories.length)]
  if (story !== undefined && (!canAsk || roll < 0.5)) return { story: story.story, mood: story.mood }
  return canAsk ? 'question' : undefined
}

// Rare: one event every 20 to 40 minutes, and only after a minute of quiet.
const EVENT_MIN_FRAMES = (20 * 60_000) / 66
const EVENT_SPAN_FRAMES = (20 * 60_000) / 66
const EVENT_QUIET_FRAMES = 60_000 / 66
// A question unanswered for five minutes goes away.
const QUESTION_FRAMES = (5 * 60_000) / 66

// The lines waiting for the voice, most urgent first: the user's poke, a
// refusal, a failure or a wait, then calm news; among equals the oldest. Full,
// the least urgent goes; a line that waited too long is dropped unspoken.
type Queued = { ask: Ask; rank: number; at: number }
const QUEUE_MAX = 4
// ~20 s of frames: past that, a line speaks of something already gone.
const STALE_FRAMES = 300

// The persona's own events come last; the user's poke and answer first.
export const rankOf = (ask: Ask): number => {
  if (ask === 'talk') return 4
  if (ask === 'question') return 0
  if ('duo' in ask) return 0
  if ('answer' in ask || 'greet' in ask) return 4
  if ('story' in ask) return 0
  return ask.mood === 'deny' ? 3 : ask.mood === 'error' || ask.mood === 'wait' ? 2 : 1
}

export const enqueue = (queue: Queued[], ask: Ask, at: number): Queued[] =>
  [...queue, { ask, rank: rankOf(ask), at }].sort((a, b) => b.rank - a.rank || a.at - b.at).slice(0, QUEUE_MAX)

export const fresh = (queue: Queued[], now: number): Queued[] =>
  queue.filter(
    q => q.ask === 'talk' || (typeof q.ask === 'object' && ('answer' in q.ask || 'greet' in q.ask)) || now - q.at <= STALE_FRAMES,
  )

type Approval = { id: string; status: string }

type Persona = {
  name: string
  voice: string
  rate: number
  pitch?: number
  // Piper voice name and pace (length-scale, under 1 is faster).
  // fx: an ffmpeg audio filter run on the WAV, from aresample=22050 so pitch
  // shifts by asetrate hold whatever the voice's own rate.
  // speaker: for a multi-speaker model, the speaker's id (speaker_id_map).
  piper?: { voice: string; lengthScale?: number; fx?: string; speaker?: number }
  color: string
  eyes: { x: number; y: number; rx: number; ry: number }[]
  mouth: { x: number; y: number; half: number } | null
  greeting: string
  persona: string
  fallback: Record<Exclude<Mood, 'wait'>, string[]> & { wait?: string[] }
  nobody?: string
  // The artists this persona would put on; jukebox7 plays them.
  station?: string[]
  // Moments of its own story it lives now and then, and the bent of the
  // questions it asks the user; either may be absent.
  events?: Story[]
  asks?: string
  // The avatars it gets on with, or against: they visit it more often.
  friends?: string[]
}

// A visiting persona: its text and its face, read from its folder.
type Guest = { id: string; persona: Persona; face: Uint8Array }

async function loadGuest($: Engine, id: string): Promise<Guest | null> {
  try {
    const dir = `${$.plugin.root}/personas/${id}`
    const persona = JSON.parse(String(await $.fs.read(`${dir}/persona.json`))) as Persona
    const { base64 } = await $.fs.read(`${dir}/face.rgb`, { as: 'bytes' })
    return { id, persona, face: Uint8Array.fromBase64(base64) }
  } catch {
    return null
  }
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
  let typed = 0
  let lineLength = 0
  // Characters typed per frame, from which frame, and which line they belong to.
  let typeRate = 2
  let typeFrom = 0
  let lineSeq = 0
  let lastSpoke = -Infinity
  let streak: Streak = { mood: 'watch', count: 0 }
  // The persona's own events: on unless /avatar events off; the next one's frame.
  let eventsOn = true
  // Visits from other personas, a share of the events, switched apart.
  let visitsOn = true
  let nextEventAt = Infinity
  const nextGap = (): number => EVENT_MIN_FRAMES + Math.random() * EVENT_SPAN_FRAMES
  // A question the avatar put to the user, until answered or five minutes pass.
  let openQuestion: { text: string; at: number } | null = null
  // A visit: the guest read (loadGuest), then the host opens.
  const startDuo = (g: Guest, topic: Duo['topic']): void => {
    guest = g
    mood = 'watch'
    moodUntil = frame + 30
    speakLater({ duo: g.id, turn: 0, topic, history: [] })
  }
  const startEvent = (ask: Ask): void => {
    if (typeof ask === 'object' && 'story' in ask) {
      mood = ask.mood
      moodUntil = frame + 60
    }
    speakLater(ask)
  }
  const recentLines: string[] = []
  let isSpeaking = false
  let face: Uint8Array | null = null
  // A visiting persona during a dialogue, and whether its face is on screen.
  let guest: Guest | null = null
  let isGuestShown = false
  let who: Persona | null = null
  // The avatar `who` was read from, so a line keeps its voice through a switch.
  let whoId = ''
  let size = W
  let asked = ''
  // The lines to speak; the clock, which holds the session's $, speaks them.
  let queue: Queued[] = []
  const speakLater = (ask: Ask): void => {
    queue = enqueue(queue, ask, frame)
  }
  // The last `say` of each mod, for /avatar voices.
  const saidHere = new Map<string, Say>()
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
    lineSeq += 1
    return lineSeq
  }

  // The WAV synthArgv made, its line then typed over the audio's length while
  // SAPI plays it; '' when SAPI already spoke.
  const voiced = (seq: number, stdout: string, length: number): { wav: string; ms: number } => {
    const [wav = '', seconds = ''] = stdout.trim().split('\n')
    const ms = Number(seconds) * 1000
    const frames = Math.round(ms / FRAME_MS)
    if (wav === '' || !(frames > 0)) return { wav: '', ms: 0 }
    if (seq === lineSeq) {
      typeRate = Math.max(length / frames, 0.2)
      typeFrom = frame + PLAY_LEAD_FRAMES
    }
    return { wav, ms }
  }

  const pixel = (x: number, y: number): number => {
    const t = frame * (FRAME_MS / 1000)
    const isGlitch = mood === 'deny' && noise(frame, y >> 2) < 0.35
    const gx = isGlitch ? Math.min(W - 1, Math.max(0, x + Math.round((noise(y, frame) - 0.5) * 10))) : x

    const img = isGuestShown && guest !== null ? guest.face : face
    if (img === null || who === null) return noise(x * 7 + frame, y) < 0.3 ? 0x1a2a22 : 0x020806

    const i = (y * W + gx) * 3
    let r = img[i]
    let g = img[i + 1]
    let b = img[i + 2]
    // No eye glow, blink or pulse for now: on several portraits the ellipses
    // missed the eyes and read as smudges. `eyes` and `mouth` stay in each
    // persona.json for a better effect.
    let k = 1

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
      description: `Open the avatar pane, or switch: /avatar ${AVATARS.join('|')}; /avatar event, /avatar duo [id], /avatar events on|off, /avatar visits on|off`,
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
      await update($, station, () => ({ name: who?.name ?? '', artists: who?.station ?? [] }))
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
    eventsOn = (await $.store.get('events')) !== false
    visitsOn = (await $.store.get('visits')) !== false
    nextEventAt = frame + nextGap()

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
          await update($, station, () => ({ name: who?.name ?? '', artists: who?.station ?? [] }))
          const { base64 } = await $.fs.read(`${dir}/face.rgb`, { as: 'bytes' })
          face = Uint8Array.fromBase64(base64)
          await $.store.set('avatar', id)
          await update($, onDuty, () => id)
          await $.ui.open({ id: PANE, title: who.name })
  
          // Through the queue like any line: never over another voice, and
          // jukebox7 hears isVoicing for it too.
          speakLater({ greet: personalize(who.greeting, userName, who.nobody) })
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
            speakLater({ mood: now, event: `the human's decision on the held call ${heldCall}: ${found.status.toUpperCase()}` })
          } catch {
            // mesh7 down or unreadable: try again at the next poll.
          } finally {
            isPolling = false
          }
        })
      }

      if (askSince !== null && frame - askSince === ASK_FRAMES && queue.length === 0) {
        speakLater({ mood: 'wait', event: `call waiting for the user's permission: ${askCall}` })
      }

      // Now and then, when nothing else happens, a moment of the persona's own.
      if (
        eventsOn &&
        who !== null &&
        frame >= nextEventAt &&
        queue.length === 0 &&
        !isSpeaking &&
        heldId === null &&
        askSince === null &&
        openQuestion === null &&
        frame - lastSpoke > EVENT_QUIET_FRAMES
      ) {
        nextEventAt = frame + nextGap()
        // One event in three is a visit from another persona.
        const gid = visitsOn && Math.random() < 1 / 3 ? pickGuest(AVATARS, whoId, Math.random(), who.friends) : undefined
        if (gid !== undefined) {
          void loadGuest($, gid).then(g => {
            if (g !== null) startDuo(g, Math.random() < 0.5 ? 'session' : 'stories')
          })
        } else {
          const ev = pickEvent(who.events ?? [], who.asks !== undefined, Math.random(), Math.random())
          if (ev !== undefined) startEvent(ev)
        }
      }
      if (openQuestion !== null && frame - openQuestion.at > QUESTION_FRAMES) {
        openQuestion = null
        $.ui.invalidate('ui.render')
      }

      queue = fresh(queue, frame)
      const first = queue[0]
      if (first === undefined || isSpeaking || who === null) return
      queue = queue.slice(1)
      const ask = first.ask
      isSpeaking = true
      lastSpoke = frame
      // In a dialogue the guest speaks the odd turns, with its own voice and face.
      const isGuestTurn = typeof ask === 'object' && 'duo' in ask && ask.turn % 2 === 1 && guest !== null
      const voice = isGuestTurn && guest !== null ? guest.persona : who
      const voiceId = isGuestTurn && guest !== null ? guest.id : whoId
      isGuestShown = isGuestTurn
      $.clock.after(1, async () => {
        try {
          // The line: a greeting as written, anything else from the model.
          const write = async (): Promise<string> => {
            let prompt: string
            const conversation = async (): Promise<string> =>
              (await $.session.messages())
                .filter(m => m.text.trim() !== '')
                .slice(-TALK_MESSAGES)
                .map(m => `${m.role}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, TALK_CHARS)}`)
                .join('\n')
            if (ask === 'talk') {
              prompt =
                `The user pokes you and wants your take on where the conversation stands.\n` +
                `Last messages, oldest first:\n${await conversation()}`
            } else if (ask === 'question') {
              prompt =
                `Ask the user ONE short question, then stop: philosophical, from your own story, or technical, ` +
                `about the work in the conversation below. Your bent: ${voice.asks ?? 'what your character would wonder'}.\n` +
                `Last messages, oldest first:\n${await conversation()}`
            } else if ('story' in ask) {
              prompt = `A moment of your own story happens now, unrelated to the tool calls: ${ask.story}. Say what you live or feel in it.`
            } else if ('duo' in ask) {
              const other = isGuestTurn ? (who?.name ?? 'the host') : (guest?.persona.name ?? 'a visitor')
              const about =
                ask.topic === 'session'
                  ? `the work going on in this terminal session. Last messages, oldest first:\n${await conversation()}`
                  : 'where your two stories cross'
              prompt =
                ask.turn === 0
                  ? `${other} visits your terminal. Open a short exchange with them, speaking to them directly, about ${about}`
                  : `You are talking with ${other}. The exchange so far:\n${ask.history.join('\n')}\n` +
                    (ask.turn === DUO_TURNS - 1 ? 'Close the exchange in one sentence, to them.' : 'Answer them in one sentence.')
            } else if ('answer' in ask) {
              prompt =
                `You asked the user: ${ask.question}\nThe user answered: ${ask.answer}\n` +
                `React in character: challenge it, approve it your way, or ask one follow-up.`
            } else {
              prompt = asked === '' ? `Event: ${ask.event}` : `The user asked: ${asked}\nEvent: ${ask.event}`
            }
            prompt += recentNote(recentLines)
            const r = await $.model.complete({
              model: 'haiku',
              system: personalize(voice.persona, userName, voice.nobody) + STYLE,
              prompt,
              maxTokens: 80,
              timeoutMs: 15_000,
            })
            // A question with no model answer is simply not asked.
            const pool =
              ask === 'question' || 'duo' in ask
                ? []
                : ask === 'talk' || 'story' in ask || 'answer' in ask
                  ? voice.fallback.idle
                  : ask.mood === 'wait'
                    ? (voice.fallback.wait ?? voice.fallback.watch)
                    : voice.fallback[ask.mood as Exclude<Mood, 'idle' | 'wait'>]
            return r.isAnswered
              ? (r.text.trim().split('\n')[0] ?? '')
              : personalize(pool[frame % pool.length] ?? '', userName, voice.nobody)
          }
          const text = typeof ask === 'object' && 'greet' in ask ? ask.greet : await write()
          if (text === '') return
          if (ask === 'question') {
            openQuestion = { text, at: frame }
            $.ui.invalidate('ui.render')
          }
          if (text !== '') {
            recentLines.push(text)
            if (recentLines.length > RECENT_LINES) recentLines.shift()
          }
          const isDuo = typeof ask === 'object' && 'duo' in ask
          const shown = isDuo ? `${voice.name}: ${text}` : text
          const isQuiet = await read($, isMuted)
          const seq = startLine(shown, isQuiet)
          await update($, line, () => ({ text: shown, at: frame }) satisfies Line)
          if (!isQuiet) {
            const made = await $.process.run(synthArgv(voiceId, voice, await read($, volume)), {
              stdin: text,
              timeoutMs: 30_000,
            })
            const { wav, ms } = voiced(seq, made.stdout, shown.length)
            if (wav !== '') {
              // Detached, so a reload of this module no longer cuts the line;
              // the voice is held for the WAV's length plus PowerShell's start.
              await update($, isVoicing, () => true)
              await $.process.run(detachedArgv(playArgv(wav)))
              await $.clock.sleep(ms + PLAY_START_MS)
            }
          }
          if (typeof ask === 'object' && 'duo' in ask && ask.turn < DUO_TURNS - 1) {
            speakLater({ ...ask, turn: ask.turn + 1, history: [...ask.history, `${voice.name}: ${text}`] })
          }
        } finally {
          // A dialogue ends on its last turn, or on a turn that said nothing.
          if (typeof ask === 'object' && 'duo' in ask && !queue.some(q => typeof q.ask === 'object' && 'duo' in q.ask)) {
            isGuestShown = false
            guest = null
          }
          isSpeaking = false
          if (await read($, isVoicing)) await update($, isVoicing, () => false)
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
    // The mods heard asking for a voice, and what they asked.
    // The persona's own events: one now, or switched on or off for good.
    if (id === 'event') {
      const ev = who === null ? undefined : pickEvent(who.events ?? [], who.asks !== undefined, Math.random(), Math.random())
      if (ev === undefined) return { text: `${who?.name ?? 'avatar7'} has no events of its own yet.` }
      startEvent(ev)
      return { text: ev === 'question' ? `${who?.name} has a question.` : `Something happens to ${who?.name}.` }
    }
    // A visit now: /avatar duo <id>, or a guest picked at random.
    if (id === 'duo' || id.startsWith('duo ')) {
      const want = id.slice(3).trim()
      const gid = want !== '' ? want : pickGuest(AVATARS, whoId, Math.random(), who?.friends)
      if (gid === undefined || !AVATARS.includes(gid) || gid === whoId) {
        return { text: `Pick another avatar: ${AVATARS.filter(a => a !== whoId).join(', ')}.` }
      }
      const g = await loadGuest($, gid)
      if (g === null) return { text: `personas/${gid} is unreadable.` }
      startDuo(g, Math.random() < 0.5 ? 'session' : 'stories')
      return { text: `${g.persona.name} visits ${who?.name ?? 'avatar7'}.` }
    }
    if (id === 'visits on' || id === 'visits off') {
      visitsOn = id === 'visits on'
      await $.store.set('visits', visitsOn)
      $.ui.invalidate('ui.render')
      return { text: visitsOn ? 'The avatars visit each other again.' : 'No more visits.' }
    }
    if (id === 'events on' || id === 'events off') {
      eventsOn = id === 'events on'
      await $.store.set('events', eventsOn)
      $.ui.invalidate('ui.render')
      return { text: eventsOn ? 'The avatars live their own stories again.' : 'No more events of their own.' }
    }
    if (id === 'voices') {
      const all = [
        ...Object.entries(await read($, announcers)).map(([plugin, a]) => `${plugin} (toasts): ${a.mood}, ${a.event}`),
        ...[...saidHere].map(([plugin, a]) => `${plugin} (say): ${a.mood}, ${a.event}`),
      ]
      return { text: all.length === 0 ? 'No mod has asked for a voice in this session.' : all.join('\n') }
    }
    if (!AVATARS.includes(id)) return { text: `Unknown avatar. Choose one of: ${AVATARS.join(', ')}.` }

    pendingAvatar = id
    return { text: `${names[id] ?? id} takes over.` }
  })

  on('command.run', { command: 'avatar-talk' }, async () => {
    speakLater('talk')
    return { text: `${who?.name ?? 'avatar7'} reads the conversation.` }
  })

  on('command.run', { command: 'avatar-mute' }, async $ => {
    const muted = await update($, isMuted, was => !was)
    return { text: muted ? 'The avatar falls silent.' : 'The avatar speaks again.' }
  })

  // The user's prompt judges the calls of its own turn only; a toast or a
  // story an hour later is not measured against it.
  on('turn.complete', async ($, e, next) => {
    asked = ''
    return next(e)
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
  const heardHere = new Map<string, Announce>()
  on('state.set', async ($, e, next) => {
    const done = await next(e)
    const w = e as { plugin: string; key: string; value: unknown }
    const s = landed(done) ? heardSay(w) : undefined
    if (s !== undefined) {
      saidHere.set(w.plugin, s)
      if (who !== null) {
        if (heldId === null && askSince === null) {
          mood = s.mood
          moodUntil = frame + (s.mood === 'watch' ? 12 : 30)
        }
        speakLater({ mood: s.mood, event: s.event })
      }
    }
    const a = landed(done) ? heard(w) : undefined
    if (a !== undefined) {
      heardHere.set(w.plugin, a)
      try {
        await update($, announcers, was => ({ ...was, [w.plugin]: a }))
      } catch (err) {
        $.ui.log(`avatar7 could not keep ${w.plugin}.announce: ${String(err)}`, { to: 'debug' })
      }
    }
    return done
  })

  // Their toasts, announced in the avatar's own voice past the tool-call
  // rate limits; a warning in amber.
  on('ui.toast', async ($, e, next) => {
    const from = next.origin.plugin
    const bell = from === undefined || from === 'avatar7' ? undefined : (heardHere.get(from) ?? (await read($, announcers))[from])
    if (bell !== undefined && who !== null) {
      if (heldId === null && askSince === null) {
        mood = bell.mood
        moodUntil = frame + 30
      }
      speakLater({ mood: bell.mood, event: `${bell.event}: ${e.text}` })
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
      speakLater({ mood: 'wait', event: `call HELD for human approval: ${call}` })
      return ran
    }

    const isMeshDeny = isMesh && ran.deny === undefined && ran.isError === true && MESH_DENY.test(ran.text ?? '')
    const now: Mood = ran.deny !== undefined || isMeshDeny ? 'deny' : ran.isError === true ? 'error' : 'watch'

    // A held call keeps the waiting face; the others set theirs.
    if (heldId === null) {
      mood = now
      moodUntil = frame + (now === 'watch' ? 12 : 30)
    }

    // Counted on every call, spoken or not; a broken run of failures earns
    // the short wait a failure gets.
    const was = streak
    streak = nextStreak(was, now as Streak['mood'])
    const note = streakNote(was, streak)

    const quiet = now === 'watch' && note === '' ? 45_000 / FRAME_MS : 5_000 / FRAME_MS
    if (isSpeaking || queue.length > 0 || frame - lastSpoke < quiet) return ran
    speakLater({
      mood: now,
      event:
        (now === 'deny'
          ? `call DENIED: ${call} (${(ran.deny ?? ran.text ?? '').slice(0, 120)})`
          : now === 'error'
            ? `call FAILED: ${call}`
            : `call succeeded: ${call}`) + note,
    })

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

    const { Box, Text, Raster, Button, Input } = $.ui.resolve(e)
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
        {openQuestion !== null && (
          <Input
            key="answer"
            label="answer: "
            placeholder="ctrl+x tab, type, Enter"
            submitLabel="answer"
            autoFocus
            onSubmit={value => {
              const answer = value.replace(/\s+/g, ' ').trim().slice(0, ASKED_CHARS)
              const q = openQuestion
              if (answer === '' || q === null) return
              openQuestion = null
              speakLater({ question: q.text, answer })
              $.ui.invalidate('ui.render')
            }}
          />
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
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} backgroundColor="#000000">
          <Button key="talk" label="talk" hotkey="t" plain dimColor onPress={() => speakLater('talk')} />
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
          <Button
            key="events"
            label={eventsOn ? 'events: on' : 'events: off'}
            hotkey="e"
            plain
            dimColor
            onPress={async () => {
              eventsOn = !eventsOn
              await $.store.set('events', eventsOn)
              $.ui.invalidate('ui.render')
            }}
          />
          <Button
            key="visits"
            label={visitsOn ? 'visits: on' : 'visits: off'}
            hotkey="v"
            plain
            dimColor
            onPress={async () => {
              visitsOn = !visitsOn
              await $.store.set('visits', visitsOn)
              $.ui.invalidate('ui.render')
            }}
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
