// What the avatar hears besides tool calls: the slash commands that change
// the session, the other mods' announce and say, and the run of like
// outcomes the calls make. Pure.

import type { Announce, Say } from '../types'
import type { Mood } from './mood'

// How much of the user's last prompt the avatar reads, so it judges a call
// against what was asked rather than the bare gesture.
export const ASKED_CHARS = 200

// The slash commands the avatar reacts to, each with what it means: those
// that change the session or mark a moment. Any other (a look at /context,
// /mcp, a mod's own pane) passes in silence. A manual /compact is heard here;
// an automatic one through session.compact.
export const COMMANDS: Record<string, { mood: Exclude<Mood, 'idle'>; means: string }> = {
  clear: { mood: 'watch', means: 'wipes the whole conversation and starts over; say farewell to what is gone' },
  compact: { mood: 'watch', means: 'compacts the conversation: the assistant keeps a summary and forgets the rest' },
  fast: { mood: 'watch', means: 'toggles fast mode for the assistant' },
  rewind: { mood: 'error', means: 'rewinds the conversation to undo what went wrong' },
  resume: { mood: 'watch', means: 'resumes an older session' },
  brief: { mood: 'watch', means: 'asks for the morning brief: weather, mail, news; the day starts' },
  veille: { mood: 'watch', means: 'publishes the AI and streaming watch to the team Discord' },
  document: { mood: 'watch', means: 'publishes a working document as a page' },
  galerie: { mood: 'watch', means: 'publishes the latest image renders as a gallery' },
  'mesh-approve': { mood: 'wait', means: 'decides the approvals mesh7 holds for a human' },
  'code-review': { mood: 'watch', means: 'puts the code under review' },
  'security-review': { mood: 'watch', means: 'puts the code under a security review' },
  code7: { mood: 'watch', means: 'takes the keyboard back: the user writes the code, the assistant only teaches' },
}

// The line a command earns, or undefined when it passes in silence.
export const commandEvent = (command: string, args: string): { mood: Exclude<Mood, 'idle'>; event: string } | undefined => {
  const known = COMMANDS[command]
  if (known === undefined) return undefined
  const typed = args.replace(/\s+/g, ' ').trim().slice(0, ASKED_CHARS)
  return { mood: known.mood, event: `the user runs /${command}${typed === '' ? '' : ` ${typed}`}, which ${known.means}` }
}

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
    ? {
        mood: a.mood,
        event: a.event,
        at: a.at,
        ...(typeof a.tool === 'string' ? { tool: a.tool } : {}),
        ...(a.hold === true ? { hold: true } : {}),
        ...(a.release === true ? { release: true } : {}),
      }
    : undefined
}

// The run of like outcomes the last calls made: a third denial in a row, or
// a success after a string of failures, is news the line should carry.
export type Streak = { mood: 'watch' | 'deny' | 'error'; count: number }

export const nextStreak = (s: Streak, now: Streak['mood']): Streak =>
  s.mood === now ? { mood: now, count: s.count + 1 } : { mood: now, count: 1 }

export const ordinal = (n: number): string =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`

export const streakNote = (before: Streak, after: Streak): string => {
  const what = (m: Streak['mood'], n: number) => (m === 'deny' ? 'denial' : 'failure') + (n > 1 ? 's' : '')
  if (after.mood !== 'watch' && after.count >= 2) return ` (${ordinal(after.count)} ${what(after.mood, 1)} in a row)`
  if (after.mood === 'watch' && before.mood !== 'watch' && before.count >= 3) {
    return ` (first success after ${before.count} ${what(before.mood, before.count)} in a row)`
  }
  return ''
}
