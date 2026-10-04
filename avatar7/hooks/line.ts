// The line under the face: its text, how far it is typed, at what pace, and
// the voice that carries it. Pure: the frame clock and the speaking timer in
// register.tsx move it only through the transitions below.

export type Typing = {
  text: string
  // Characters shown, fractional: the pace adds a share of one per frame.
  typed: number
  // Characters per frame, and the frame typing starts at.
  rate: number
  from: number
  // Which line this is: a voice that comes back late types only its own.
  seq: number
  // Until when the voice is heard, in frames: the mouth moves meanwhile.
  speakUntil: number
  // One line at a time: set while a line is written, voiced and heard.
  isSpeaking: boolean
  lastSpoke: number
}

export const silent: Typing = { text: '', typed: 0, rate: 2, from: 0, seq: 0, speakUntil: 0, isSpeaking: false, lastSpoke: -Infinity }

// The line waits for its voice: typed from when SAPI starts the WAV (PowerShell
// takes ~0.3 s to get there), over the audio's length. Without a WAV within
// HOLD_FRAMES (Piper missing, SAPI speaking itself) it is typed anyway.
export const PLAY_LEAD_FRAMES = 5
export const HOLD_FRAMES = 75

// A line kept from before a reload: shown whole, nothing to type.
export const restored = (t: Typing, text: string): Typing => ({ ...t, text, typed: text.length })

// The speaking slot: taken when a line is picked from the queue, given back
// when it was heard.
export const begin = (t: Typing, now: number): Typing => ({ ...t, isSpeaking: true, lastSpoke: now })
export const end = (t: Typing): Typing => ({ ...t, isSpeaking: false })

// A new line: held until its voice is ready, unless muted.
export const start = (t: Typing, text: string, isQuiet: boolean, now: number): Typing => ({
  ...t,
  text,
  typed: 0,
  rate: 2,
  from: isQuiet ? now : now + HOLD_FRAMES,
  seq: t.seq + 1,
})

// The WAV synthArgv made (its path, then its length in seconds); the line is
// typed over the audio's length while it plays, if it is still the line on
// screen. wav is '' when SAPI already spoke it.
export const voiced = (t: Typing, seq: number, stdout: string, now: number, frameMs: number): { t: Typing; wav: string; ms: number } => {
  const [wav = '', seconds = ''] = stdout.trim().split('\n')
  const ms = Number(seconds) * 1000
  const frames = Math.round(ms / frameMs)
  if (wav === '' || !(frames > 0)) return { t, wav: '', ms: 0 }
  if (seq !== t.seq) return { t, wav, ms }
  const from = now + PLAY_LEAD_FRAMES
  return { t: { ...t, rate: Math.max(t.text.length / frames, 0.2), from, speakUntil: from + frames }, wav, ms }
}

// One frame of typing: the same object when nothing moved, so the clock
// redraws only on a change.
export const typeOn = (t: Typing, now: number): Typing =>
  t.typed < t.text.length && now >= t.from ? { ...t, typed: Math.min(t.text.length, t.typed + t.rate) } : t

export const isHeard = (t: Typing, now: number): boolean => now < t.speakUntil
