// What the avatar says and when: the kinds of line (Ask), the queue that
// orders them, the persona's text, and how a line is asked of the model and
// kept. Pure: register.tsx reads the session, calls the model and plays the
// voice, since the engine follows $ into nothing imported.

import type { AmbientLayer } from './ambient'
import type { Mood } from './mood'

// Rules every persona keeps, whatever its character: added to each prompt.
export const STYLE = ' The user may write in French; you always answer in English. Never flattering. No quotes, no emoji, no em dash.'

// When poked, the avatar reads the last messages of the conversation, each cut
// to this many characters.
export const TALK_MESSAGES = 6
export const TALK_CHARS = 300
// Asked for an opinion, it reads further back and may say more.
export const CONSULT_MESSAGES = 12
export const CONSULT_CHARS = 600
export const CONSULT_CHARS_ASKED = 400
// A chat remembers its last six exchanges, per persona.
export const CHAT_LINES = 12

// The avatar's last lines, given back to the model so it does not repeat
// its own wording over a long session.
export const RECENT_LINES = 3

export const recentNote = (lines: string[]): string =>
  lines.length === 0 ? '' : `\nYour last lines, do not reuse their wording or openings:\n${lines.map(l => `- ${l}`).join('\n')}`

// A line to speak: an event in a mood, or the user's poke, which reads the
// conversation first; or, now and then, a moment of the persona's own story,
// a question it puts to the user, and its reaction to the user's answer.
export type Ask =
  | { mood: Mood; event: string; tool?: string; after?: number }
  | 'talk'
  | { story: string; mood: Mood }
  | 'question'
  | { question: string; answer: string }
  | { consult: string }
  | { chat: string }
  | Duo
  | { greet: string }

// One turn of a dialogue with a visiting persona: even turns are the host's,
// odd ones the guest's; `history` holds the lines said so far, by name.
export type Duo = { duo: string; turn: number; topic: 'session' | 'stories'; history: string[] }
export const DUO_TURNS = 6

// A guest for the persona on duty: any other avatar, its `friends` three
// times as likely as the rest, picked by `roll` in [0, 1).
export const FRIEND_WEIGHT = 3

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

// The persona's own lines for when the model gives none. A question or a
// dialogue turn has none: it is simply not said. The string asks are tested
// first, since `in` on a string throws (it once silenced every poke).
export const fallbackPool = (ask: Ask, fallback: Persona['fallback']): string[] => {
  if (ask === 'talk') return fallback.idle
  if (ask === 'question') return []
  if ('duo' in ask) return []
  if ('story' in ask || 'answer' in ask || 'greet' in ask) return fallback.idle
  // A stock line is no answer to a question: better silent.
  if ('consult' in ask || 'chat' in ask) return []
  return ask.mood === 'wait' ? (fallback.wait ?? fallback.watch) : fallback[ask.mood as Exclude<Mood, 'idle' | 'wait'>]
}

// One of the persona's own events, or undefined when it has none: a story
// or a question, even odds when it has both. `roll` and `pick` are in [0, 1).
export const pickEvent = (stories: Story[], canAsk: boolean, roll: number, pick: number): Ask | undefined => {
  const story = stories[Math.floor(pick * stories.length)]
  if (story !== undefined && (!canAsk || roll < 0.5)) return { story: story.story, mood: story.mood }
  return canAsk ? 'question' : undefined
}

// Rare: one event every 20 to 40 minutes, and only after a minute of quiet.
export const EVENT_MIN_FRAMES = (20 * 60_000) / 66
export const EVENT_SPAN_FRAMES = (20 * 60_000) / 66
export const EVENT_QUIET_FRAMES = 60_000 / 66
// A question unanswered for five minutes goes away.
export const QUESTION_FRAMES = (5 * 60_000) / 66

// The lines waiting for the voice, most urgent first: the user's poke, a
// refusal, a failure or a wait, then calm news; among equals the oldest. Full,
// the least urgent goes; a line that waited too long is dropped unspoken.
export type Queued = { ask: Ask; rank: number; at: number }
export const QUEUE_MAX = 4
// ~20 s of frames: past that, a line speaks of something already gone.
export const STALE_FRAMES = 300

// The persona's own events come last; the user's poke and answer first.
export const rankOf = (ask: Ask): number => {
  if (ask === 'talk') return 4
  if (ask === 'question') return 0
  if ('duo' in ask) return 0
  if ('answer' in ask || 'greet' in ask || 'consult' in ask || 'chat' in ask) return 4
  if ('story' in ask) return 0
  return ask.mood === 'deny' ? 3 : ask.mood === 'error' || ask.mood === 'wait' ? 2 : 1
}

export const enqueue = (queue: Queued[], ask: Ask, at: number): Queued[] =>
  [...queue, { ask, rank: rankOf(ask), at }].sort((a, b) => b.rank - a.rank || a.at - b.at).slice(0, QUEUE_MAX)

// A dialogue's turn never goes stale either: dropped while it waited (behind
// the user's chats, which rank higher), it left the guest on stage for good,
// since only a turn said ends the visit, and no duo could start again.
export const fresh = (queue: Queued[], now: number): Queued[] =>
  queue.filter(
    q =>
      q.ask === 'talk' ||
      (typeof q.ask === 'object' && ('answer' in q.ask || 'greet' in q.ask || 'consult' in q.ask || 'chat' in q.ask || 'duo' in q.ask)) ||
      now - q.at <= STALE_FRAMES,
  )

export type Persona = {
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
  // Pixel weather in the black around the face (hooks/ambient.ts).
  ambient?: AmbientLayer[]
  // The portrait's luminance (0-255) under which the scene shows through it;
  // lower for a face with dark hair, which would otherwise turn see-through.
  cutout?: number
}

// `{, user}` in a persona's text becomes ", <name>": the user_name option,
// else the persona's `nobody`, else nothing (the braces and their text drop).
export const personalize = (text: string, name: string, nobody: string | undefined): string =>
  text.replace(/\{([^{}]*)user([^{}]*)\}/g, (_, before: string, after: string) => {
    const who = name !== '' ? name : (nobody ?? '')
    return who === '' ? '' : `${before}${who}${after}`
  })


// What a line reads before it is written: how many of the session's last
// messages, each cut to how many characters; null when it reads none.
export const reads = (ask: Ask): { count: number; chars: number } | null => {
  if (ask === 'talk' || ask === 'question') return { count: TALK_MESSAGES, chars: TALK_CHARS }
  if ('consult' in ask) return { count: CONSULT_MESSAGES, chars: CONSULT_CHARS }
  if ('duo' in ask && ask.turn === 0 && ask.topic === 'session') return { count: TALK_MESSAGES, chars: TALK_CHARS }
  return null
}

// An opinion (a consult, a chat) keeps all its sentences and gets more tokens.
export const isOpinion = (ask: Ask): boolean => typeof ask === 'object' && ('consult' in ask || 'chat' in ask)

export type Asking = {
  voice: Persona
  // In a dialogue, the one spoken to.
  other: string
  // The session's last messages, as reads() asked; '' when none.
  conversation: string
  // This persona's chat with the user so far, for a chat.
  chatPast: string[]
  // What the user asked in this turn, judged against.
  asked: string
  // The avatar's own last lines, not to repeat.
  recent: string[]
}

// The prompt for a line, or null for a greeting, spoken as written.
export const promptFor = (ask: Ask, c: Asking): string | null => {
  let prompt: string
  if (ask === 'talk') {
    prompt = `The user pokes you and wants your take on where the conversation stands.\nLast messages, oldest first:\n${c.conversation}`
  } else if (ask === 'question') {
    prompt =
      `Ask the user ONE short question, then stop: philosophical, from your own story, or technical, ` +
      `about the work in the conversation below. Your bent: ${c.voice.asks ?? 'what your character would wonder'}.\n` +
      `Last messages, oldest first:\n${c.conversation}`
  } else if ('story' in ask) {
    prompt = `A moment of your own story happens now, unrelated to the tool calls: ${ask.story}. Say what you live or feel in it.`
  } else if ('duo' in ask) {
    const about =
      ask.topic === 'session' ? `the work going on in this terminal session. Last messages, oldest first:\n${c.conversation}` : 'where your two stories cross'
    prompt =
      ask.turn === 0
        ? `${c.other} visits your terminal. Open a short exchange with them, speaking to them directly, about ${about}`
        : `You are talking with ${c.other}. The exchange so far:\n${ask.history.join('\n')}\n` +
          (ask.turn === DUO_TURNS - 1 ? 'Close the exchange in one sentence, to them.' : 'Answer them in one sentence.')
  } else if ('consult' in ask) {
    prompt =
      `The user is working with an AI assistant in this terminal session and asks your opinion on it.\n` +
      `Last messages, oldest first:\n${c.conversation}\n` +
      `The user asks you: ${ask.consult}\n` +
      `Answer in character, in two or three sentences: take a position, name what you would change or keep. ` +
      `You may end on one question back.`
  } else if ('chat' in ask) {
    prompt =
      `The user talks to you personally, about whatever they like, not about the terminal session. ` +
      `This time you may use two or three sentences instead of one.\n` +
      (c.chatPast.length > 0 ? `Your conversation so far, oldest first:\n${c.chatPast.join('\n')}\n` : '') +
      `The user says: ${ask.chat}\n` +
      `Answer in character, from your own world and what you know of the user; you may ask one question back.`
  } else if ('answer' in ask) {
    prompt = `You asked the user: ${ask.question}\nThe user answered: ${ask.answer}\nReact in character: challenge it, approve it your way, or ask one follow-up.`
  } else if ('greet' in ask) {
    return null
  } else {
    prompt = c.asked === '' ? `Event: ${ask.event}` : `The user asked: ${c.asked}\nEvent: ${ask.event}`
  }
  return prompt + recentNote(c.recent)
}

// The line kept from the model's answer: an opinion whole, any other line its
// first; with no answer, one of the persona's stock lines (`roll` picks it),
// or '' where none fits.
export const lineFrom = (r: { isAnswered: true; text: string } | { isAnswered: false }, ask: Ask, voice: Persona, roll: number, userName: string): string => {
  if (r.isAnswered) return isOpinion(ask) ? r.text.replace(/\s+/g, ' ').trim() : (r.text.trim().split('\n')[0] ?? '')
  const pool = fallbackPool(ask, voice.fallback)
  return personalize(pool[roll % pool.length] ?? '', userName, voice.nobody)
}
