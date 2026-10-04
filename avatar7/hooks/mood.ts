// The face's state: which mood it shows, until which frame, and the two waits
// that hold it (a call mesh7 holds for a human, a call at the permission
// prompt). Pure: every change is one of the transitions below, so the rule
// that a wait keeps the face lives here once instead of in each hook.

export type Mood = 'idle' | 'watch' | 'deny' | 'error' | 'wait'

export type Face = {
  mood: Mood
  // The frame after which the mood fades back to idle; Infinity while waiting.
  until: number
  // A call mesh7 holds for a human, as mesh7-pane said it; null when none.
  held: string | null
  heldSince: number
  // A call put to the permission prompt (a mesh7 hook's `ask`, a settings rule).
  askSince: number | null
  askCall: string
  // The mood comes from a moment of the persona's own story, not from a
  // call: the face shows it, softer (a smaller glitch on a staged refusal).
  isStaged: boolean
}

export const calm: Face = { mood: 'idle', until: 0, held: null, heldSince: 0, askSince: null, askCall: '', isStaged: false }

export const isWaiting = (f: Face): boolean => f.held !== null || f.askSince !== null

// How long a mood shows, in frames: a calm look passes faster than an alarm.
export const span = (m: Mood): number => (m === 'watch' ? 12 : 30)

// A mood for a while; a wait keeps the face as it is.
export const react = (f: Face, mood: Mood, now: number, frames = span(mood)): Face =>
  isWaiting(f) ? f : { ...f, mood, until: now + frames, isStaged: false }

// A scene of the persona's own: its mood, acted rather than suffered.
export const stage = (f: Face, mood: Mood, now: number, frames: number): Face =>
  isWaiting(f) ? f : { ...f, mood, until: now + frames, isStaged: true }

// mesh7 holds a call for a human: the face waits until the release.
export const hold = (f: Face, call: string, now: number): Face => ({ ...f, held: call, heldSince: now, mood: 'wait', until: Infinity, isStaged: false })

// The human decided: the verdict's mood, for a while.
export const release = (f: Face, mood: Mood, now: number): Face => ({ ...f, held: null, mood, until: now + 30, isStaged: false })

// A call goes to the permission prompt: the face waits until it ran.
export const ask = (f: Face, call: string, now: number): Face => ({ ...f, askSince: now, askCall: call, mood: 'wait', until: Infinity, isStaged: false })

// The call ran (or was interrupted): the prompt is gone. The mood stays until
// the call's own outcome sets it.
export const answered = (f: Face): Face => (f.askSince === null ? f : { ...f, askSince: null })

// Each frame: a wait whose end never came (mesh7-pane reloaded before its
// release, a prompt that vanished) lets go after `cap` frames; a mood past
// its time fades to idle.
export const tick = (f: Face, now: number, cap: number): Face => {
  let g = f
  if ((g.askSince !== null && now - g.askSince > cap) || (g.held !== null && now - g.heldSince > cap)) {
    g = { ...g, askSince: null, held: null, until: now }
  }
  if (now > g.until && g.mood !== 'idle') g = { ...g, mood: 'idle', isStaged: false }
  return g
}
