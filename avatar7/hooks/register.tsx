import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Announce, Line, Say, Station } from '../types'
import { ambientCells, ambientPixel, QUAD, type AmbientLayer, type Field } from './ambient'
import {
  aliveArgv,
  CHECK_FRAMES,
  claimArgv,
  DRAIN_FRAMES,
  drainArgv,
  follows,
  forgetArgv,
  givesOnEnd,
  heldArgv,
  latestArgv,
  MIRROR_FRAMES,
  mirrorArgv,
  newRelay,
  parseRemote,
  playArgv,
  promptedArgv,
  releaseArgv,
  startArgv,
  takeArgv,
  type Mirror,
  type Relay,
  type RelayHost,
  wantedArgv,
  wantedMove,
} from './relay'
import {
  contextBody,
  EPISODE_TTL_S,
  episodeKey,
  episodeOf,
  journalFrom,
  journalKey,
  journalPrompt,
  memoryAt,
  memoryNote,
  parseContext,
  parseRecall,
  queryFor,
  recallBody,
  recalls,
  RECALL_EPISODES,
  RECALL_JOURNALS,
  RECALL_OLD_JOURNALS,
  journalsFor,
  rpcArgv,
  storeBody,
  unsummed,
  visitOf,
  CONSOLIDATE_MAX,
  type MemoryAt,
} from './memory'
import {
  CHAT_LINES,
  CONSULT_CHARS_ASKED,
  DUO_TURNS,
  EVENT_MIN_FRAMES,
  EVENT_QUIET_FRAMES,
  EVENT_SPAN_FRAMES,
  enqueue,
  fresh,
  isOpinion,
  lineFrom,
  personalize,
  pickEvent,
  pickGuest,
  promptFor,
  QUESTION_FRAMES,
  reads,
  RECENT_LINES,
  STYLE,
  type Ask,
  type Duo,
  type Persona,
  type Queued,
  type Story,
} from './speech'
import { ASKED_CHARS, commandEvent, heard, heardSay, landed, nextStreak, streakNote, type Streak } from './hearing'
import { detachedArgv, PLAY_START_MS, SAPI_PLAY, synthArgv } from './voice'
import { faceCells, H, noise, TINT, W, type Faces, type View } from './draw'
import { DEFAULT_GRAIN, GLITCH_STEPS, GRAINS, hdFrame, hdKey, hdSize, hdStamp, isSettled, pickHdFace, type Hd, type HdView, type Settle } from './hd'
import { begin, end, isHeard, restored, silent, start, typeOn, voiced, type Typing } from './line'
import { answered, ask as askFace, calm, hold, isWaiting, react, release, stage as stageFace, tick, type Face, type Mood } from './mood'

const PANE = 'avatar7'
const FACE = 'face'
const FRAME_MS = 66
// The weather around the face moves at a third of the face's pace.
const AMBIENT_FRAMES = 3
// The HD weather: a loop of HD_LOOP pictures, one per ambient step.
const HD_LOOP = 12
const HD_STEP_S = (AMBIENT_FRAMES * FRAME_MS) / 1000
const AMB_LEFT = 'amb-left'
const AMB_RIGHT = 'amb-right'
const AMB_BAND = 'amb-band'
// The scene rises behind the face to its middle and runs this many rows past
// the text.
const SCENE_OVERFLOW_ROWS = 6
const DEFAULT = 'shodan'
const AVATARS = ['shodan', 'hal', 'glados', 'ada', 'duck7', 'pod042', 'kaneda', 'commis', 'fox', 'adjutant', 'morte', 'pda', 'lain', 'tachikoma', 'nova']

const MIN_SIZE = 16
// A refusal acted in a scene shakes the portrait this much of a real one.
const SCENE_GLITCH = 0.4

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

// An ask the mode may settle alone (auto mode): the face waits at once, the
// avatar speaks only if the permission prompt is still up after ~2 s.
const ASK_FRAMES = 30
// The longest a wait keeps the face: 15 minutes.
const WAIT_CAP_FRAMES = Math.round((15 * 60_000) / FRAME_MS)

// How long a line about a call through mesh7 waits for mesh7-pane's verdict:
// its poll runs every 1.5 s.
const SAY_WAIT_FRAMES = 27


// The remote voice's engine calls (relay.ts holds the rest): declared here,
// in this file, as the engine follows $ into nothing imported.
async function relayOpen($: Engine, r: Relay): Promise<void> {
  r.session = await $.session.id()
  r.isSsh = (await $.process.run(['sh', '-c', 'printf %s "$SSH_CONNECTION"'])).stdout.trim() !== ''
}

async function relayGive($: Engine, r: Relay): Promise<void> {
  await $.process.run(releaseArgv(r.session))
  r.isHeld = false
  r.isByWanted = false
}

// Each frame: who holds the relay, now and then; the face, when held and
// changed; the page's presses.
function relayTick($: Engine, r: Relay, frame: number, host: RelayHost): void {
  if (r.session === '') return
  if (frame % CHECK_FRAMES === 0) {
    void (async () => {
      // After a /clear the process goes on under a new id, with no
      // session.start: a relay held by force follows it there.
      const id = await $.session.id()
      if (id !== r.session) {
        r.session = id
        if (r.isForced) await $.process.run(takeArgv(r.session))
      }
      r.isHeld = (await $.process.run(heldArgv(r.session))).stdout.trim() === 'up'
      const isWanted = (await $.process.run(wantedArgv())).stdout.trim() === 'up'
      const latest = isWanted && !r.isHeld ? (await $.process.run(latestArgv())).stdout.trim() : ''
      const move = wantedMove(r, isWanted, latest)
      if (move === 'claim') {
        await $.process.run(claimArgv(r.session))
        r.isHeld = (await $.process.run(heldArgv(r.session))).stdout.trim() === 'up'
        if (r.isHeld) r.isByWanted = true
      } else if (move === 'give') {
        await relayGive($, r)
      }
      if (!r.isHeld) r.mirrored = ''
    })().catch(err => $.ui.log(`avatar7: the relay check failed: ${String(err)}`, { to: 'debug' }))
  }
  if (r.isHeld && !r.isMirroring && frame % MIRROR_FRAMES === 0) {
    const face = host.face()
    if (face !== undefined) {
      r.isMirroring = true
      void (async () => {
        const json = JSON.stringify(await face)
        if (json !== r.mirrored) await $.process.run(mirrorArgv(r.session), { stdin: json })
        r.mirrored = json
      })()
        .catch(err => $.ui.log(`avatar7: the relay's mirror failed: ${String(err)}`, { to: 'debug' }))
        .finally(() => {
          r.isMirroring = false
        })
    }
  }
  if (r.isHeld && !r.isDraining && frame % DRAIN_FRAMES === 0) {
    r.isDraining = true
    void (async () => {
      const out = await $.process.run(drainArgv())
      for (const each of out.stdout.split('\n')) {
        const press = parseRemote(each)
        if (press !== undefined) await host.press(press)
      }
    })()
      .catch(err => $.ui.log(`avatar7: the page's commands failed: ${String(err)}`, { to: 'debug' }))
      .finally(() => {
        r.isDraining = false
      })
  }
}

// /avatar remote on: start the relay when no service runs it, and hold it.
async function relayOn($: Engine, r: Relay): Promise<string> {
  if ((await $.process.run(aliveArgv())).stdout.trim() !== 'up') {
    await $.process.run(startArgv($.plugin.root))
    await $.clock.sleep(1500)
  }
  r.isForced = true
  r.isByWanted = false
  await $.process.run(takeArgv(r.session))
  const ip = await $.process.run(['sh', '-c', 'tailscale ip -4 | head -1'])
  return `The voice leaves this machine: open http://${ip.stdout.trim()}:8797/ on the other one and click listen.`
}

// /avatar remote off: give the relay back; the relay itself keeps running.
async function relayOff($: Engine, r: Relay): Promise<string> {
  r.isForced = false
  await relayGive($, r)
  return 'The voice comes back to this machine.'
}

async function relayFollow($: Engine, r: Relay, origin: string): Promise<void> {
  if (r.session !== '') await $.process.run(promptedArgv(r.session))
  const isWanted = r.session !== '' && (await $.process.run(wantedArgv())).stdout.trim() === 'up'
  const move = follows(r, origin, isWanted)
  if (move === 'take') {
    await $.process.run(takeArgv(r.session))
    // Typed here and taken only because the phone listens: it goes back when
    // the phone stops. Remote Control or ssh keep it as before.
    r.isByWanted = origin === 'composer' && !r.isSsh
  } else if (move === 'give') await relayGive($, r)
  // Written whole again at the next mirror: a release left `{}` behind.
  if (r.session !== '') r.mirrored = ''
}

async function relayEnd($: Engine, r: Relay, reason: string): Promise<void> {
  if (r.session !== '') await $.process.run(forgetArgv(r.session))
  if (givesOnEnd(r, reason)) await relayGive($, r)
}

// A persona's faces (draw.ts): the portrait, and the optional frames baked
// beside it (tools/bake.py --frame): mouth open for speaking, a frown for a
// refusal.
// Whether this terminal draws pictures for the Image element: kitty and
// Ghostty implement the Unicode placeholders it needs, WezTerm and Windows
// Terminal do not. AVATAR7_HD=0 keeps the half blocks anyway. Set at
// session start, before the faces load.
let isHdTerminal = false
export const drawsPictures = (env: string): boolean => {
  const [term = '', program = '', flag = ''] = env.split('|')
  if (flag === '0') return false
  return term === 'xterm-kitty' || term === 'xterm-ghostty' || program === 'ghostty'
}

// The faces and scene tools/bake_hd.py baked for this persona, null when
// they are not there (a fresh clone: they are derived, kept out of git).
async function loadHd($: Engine, dir: string): Promise<Hd | null> {
  const bytes = async (name: string): Promise<Uint8Array | null> => {
    try {
      return Uint8Array.fromBase64((await $.fs.read(`${dir}/${name}`, { as: 'bytes' })).base64)
    } catch {
      return null
    }
  }
  let meta: { size?: number; sceneWidth?: number; sceneHeight?: number }
  try {
    meta = JSON.parse(String(await $.fs.read(`${dir}/hd.json`))) as typeof meta
  } catch {
    return null
  }
  const side = meta.size ?? 0
  const base = await bytes('face-hd.rgb')
  if (base === null || side === 0 || base.length !== side * side * 3) return null
  const pixels = await bytes('scene-hd.rgb')
  const width = meta.sceneWidth ?? 0
  const height = meta.sceneHeight ?? 0
  const scene = pixels !== null && pixels.length === width * height * 3 ? { pixels, width, height } : null
  const talk = await bytes('face-talk-hd.rgb')
  const deny = await bytes('face-deny-hd.rgb')
  return { side, base, talk, deny, scene, stamp: hdStamp(base, talk, deny, pixels) }
}

// Where the HD pictures go, one file per picture key: kitty reads them
// itself, so a change of picture sends a path, not a megabyte through the
// terminal, and the face no longer blinks out while one arrives. Memory, on
// Linux; shared by sessions, a key always meaning the same pixels.
const HD_DIR = '/dev/shm/avatar7-hd'
const hdPath = (key: string): string => `${HD_DIR}/${key.replace(/[^A-Za-z0-9.-]/g, '_')}.rgba`

// $.fs.write takes text: the pixels go as base64, decoded beside.
async function writeHd($: Engine, key: string, rgba: Uint8Array): Promise<void> {
  const path = hdPath(key)
  await $.fs.write(`${path}.b64`, rgba.toBase64())
  const done = await $.process.run(['sh', '-c', 'base64 -d "$1.b64" > "$1.part" && mv "$1.part" "$1" && rm -f "$1.b64"', 'sh', path])
  if (done.exitCode !== 0) throw new Error(`${path}: ${done.stderr}`)
}

// The pictures already in HD_DIR, written by an earlier load or another
// session: ready, by path, so a reload makes none of them again.
async function hdOnDisk($: Engine, files: Map<string, 'pending' | 'ready'>): Promise<void> {
  const ls = await $.process.run(['sh', '-c', 'ls "$1" 2>/dev/null; true', 'sh', HD_DIR])
  for (const name of ls.stdout.split('\n')) if (name.endsWith('.rgba')) files.set(`${HD_DIR}/${name}`, 'ready')
}

// Starts writing a picture's file unless it is there or on its way; `files`,
// by path, marks it pending, then ready. `rgba`, when the render just made the
// picture, spares making it twice.
function hdEnsure($: Engine, files: Map<string, 'pending' | 'ready'>, hv: HdView, rgba?: Uint8Array): void {
  const key = hdKey(hv)
  const path = hdPath(key)
  if (files.has(path)) return
  files.set(path, 'pending')
  void writeHd($, key, rgba ?? hdFrame(hv)).then(
    () => files.set(path, 'ready'),
    err => {
      files.delete(path)
      $.ui.log(`avatar7: HD picture not written: ${String(err)}`)
    },
  )
}

async function loadFaces($: Engine, dir: string): Promise<Faces> {
  const read = async (name: string): Promise<Uint8Array | null> => {
    try {
      return Uint8Array.fromBase64((await $.fs.read(`${dir}/${name}`, { as: 'bytes' })).base64)
    } catch {
      return null
    }
  }
  const base = await read('face.rgb')
  if (base === null) throw new Error(`${dir}/face.rgb unreadable`)
  return { base, talk: await read('face-talk.rgb'), deny: await read('face-deny.rgb'), hd: isHdTerminal ? await loadHd($, dir) : null }
}


// A scene layer's backdrop, read from the persona's folder beside its faces.
async function loadScenes($: Engine, dir: string, persona: Persona): Promise<Persona> {
  for (const layer of persona.ambient ?? []) {
    if (layer.kind !== 'scene' || layer.file === undefined) continue
    try {
      layer.pixels = Uint8Array.fromBase64((await $.fs.read(`${dir}/${layer.file}`, { as: 'bytes' })).base64)
    } catch {
      $.ui.log(`avatar7: ${dir}/${layer.file} unreadable, run tools/bake_scene.py`)
    }
  }
  return persona
}

// A private complement, kept out of the repository: ~/.config/avatar7/personas/<id>.json
// adds scenes (events), extends the character (persona, asks), may rename the
// user (nobody). Read with cat, as the engine's reads stay in the plugin folder.
export type Private = { persona?: string; events?: Story[]; asks?: string; nobody?: string }
export const withPrivate = (pub: Persona, priv: Private | null): Persona => {
  if (priv === null) return pub
  return {
    ...pub,
    persona: priv.persona ? `${pub.persona} ${priv.persona}` : pub.persona,
    events: [...(pub.events ?? []), ...(priv.events ?? []).filter(e => typeof e.story === 'string')],
    asks: priv.asks ? (pub.asks ? `${pub.asks}; ${priv.asks}` : priv.asks) : pub.asks,
    nobody: priv.nobody ?? pub.nobody,
  }
}
const privateArgv = (id: string): string[] => ['sh', '-c', 'cat "$HOME/.config/avatar7/personas/$1.json" 2>/dev/null; true', 'avatar7-private', id]

// The persona as written in the repository, completed by the private file if any.
async function readPersona($: Engine, id: string): Promise<Persona> {
  const dir = `${$.plugin.root}/personas/${id}`
  const pub = JSON.parse(String(await $.fs.read(`${dir}/persona.json`))) as Persona
  let priv: Private | null = null
  const out = (await $.process.run(privateArgv(id))).stdout.trim()
  if (out !== '') {
    try {
      priv = JSON.parse(out) as Private
    } catch {
      $.ui.log(`avatar7: ~/.config/avatar7/personas/${id}.json is not valid JSON, ignored`)
    }
  }
  return loadScenes($, dir, withPrivate(pub, priv))
}

type Guest = { id: string; persona: Persona; faces: Faces }

// What speaking changes, in one object so speak() (a file-level function, as
// the engine requires for $) can: the line under the face, the queue, a
// visiting persona and whether its face shows, the question put to the user,
// each persona's chat with the user, and the avatar's last lines.
type Stage = {
  typing: Typing
  queue: Queued[]
  guest: Guest | null
  isGuestShown: boolean
  openQuestion: { text: string; at: number } | null
  chats: Map<string, string[]>
  recent: string[]
}

async function loadGuest($: Engine, id: string): Promise<Guest | null> {
  try {
    const dir = `${$.plugin.root}/personas/${id}`
    const persona = await readPersona($, id)
    return { id, persona, faces: await loadFaces($, dir) }
  } catch {
    return null
  }
}



// One JSON-RPC call to the personas' mem7; '' when it does not answer.
async function mem7($: Engine, at: MemoryAt, body: string): Promise<string> {
  try {
    return (await $.process.run(rpcArgv(at), { stdin: body, timeoutMs: 6_000 })).stdout
  } catch {
    return ''
  }
}

// What the persona remembers for a line: its last journals, and the
// exchanges that match what was said.
async function remembered($: Engine, at: MemoryAt, agent: string, query: string): Promise<string> {
  const latest = parseRecall(await mem7($, at, recallBody(agent, ['journal'], RECALL_JOURNALS)))
  if (query.trim() === '') return memoryNote(latest, [])
  const matched = parseContext(await mem7($, at, contextBody(agent, query, ['journal'], RECALL_JOURNALS + RECALL_OLD_JOURNALS)))
  const episodes = parseContext(await mem7($, at, contextBody(agent, query, ['episode'], RECALL_EPISODES)))
  return memoryNote(journalsFor(latest, matched), episodes)
}

async function keep($: Engine, at: MemoryAt, agent: string, value: string, tags: string[]): Promise<void> {
  await mem7($, at, storeBody(agent, episodeKey(agent, new Date()), value, ['episode', ...tags], EPISODE_TTL_S))
}

// The persona sums up, in its own voice, the exchanges since its last journal.
async function summarize($: Engine, at: MemoryAt, agent: string, voice: Persona, userName: string): Promise<void> {
  const journals = parseRecall(await mem7($, at, recallBody(agent, ['journal'], 1)))
  const episodes = unsummed(parseRecall(await mem7($, at, recallBody(agent, ['episode'], CONSOLIDATE_MAX))), journals)
  if (episodes.length === 0) return
  const r = await $.model.complete({
    model: 'haiku',
    system: personalize(voice.persona, userName, voice.nobody) + STYLE,
    prompt: journalPrompt(episodes, userName !== '' ? userName : 'the user'),
    maxTokens: 200,
    timeoutMs: 30_000,
  })
  const journal = journalFrom(r)
  // Nothing worth keeping is a journal too: the same exchanges are not read again.
  await mem7($, at, storeBody(agent, journalKey(agent, new Date()), journal ?? 'Nothing worth keeping.', ['journal']))
}

// What a line needs from the session around it, read when the line is picked.
type Speaking = {
  voice: Persona
  voiceId: string
  isGuestTurn: boolean
  // The other in a dialogue, by id: the visit goes to both memories.
  otherId: string
  memory: MemoryAt | null
  // The persona on duty, by name: whom a guest's turn speaks to.
  host: string
  asked: string
  userName: string
  relay: Relay
  // The frame now: it moves on while the line is written and voiced.
  now: () => number
  say: (ask: Ask) => void
}

// One line, from the model (or as written) to the voice: written, typed under
// the face, synthesized and played; the speaking slot is given back at the end.
async function speak($: Engine, stage: Stage, ask: Ask, c: Speaking): Promise<void> {
  try {
    // The line: a greeting as written, anything else from the model.
    // A consultation and a chat keep all their sentences.
    const isConsult = isOpinion(ask)
    const isChat = typeof ask === 'object' && 'chat' in ask
    const write = async (): Promise<string> => {
      const need = reads(ask)
      const conversation =
        need === null
          ? ''
          : (await $.session.messages())
              .filter(m => m.text.trim() !== '')
              .slice(-need.count)
              .map(m => `${m.role}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, need.chars)}`)
              .join('\n')
      const other = c.isGuestTurn ? c.host : (stage.guest?.persona.name ?? 'a visitor')
      const prompt = promptFor(ask, { voice: c.voice, other, conversation, chatPast: stage.chats.get(c.voiceId) ?? [], asked: c.asked, recent: stage.recent })
      if (prompt === null) return typeof ask === 'object' && 'greet' in ask ? ask.greet : ''
      const past = c.memory !== null && recalls(ask) ? await remembered($, c.memory, c.voiceId, queryFor(ask, c.asked, other)) : ''
      const r = await $.model.complete({
        model: 'haiku',
        system: personalize(c.voice.persona, c.userName, c.voice.nobody) + STYLE,
        prompt: prompt + past,
        maxTokens: isOpinion(ask) ? 160 : 80,
        timeoutMs: 15_000,
      })
      return lineFrom(r, ask, c.voice, c.now(), c.userName)
    }
    const text = typeof ask === 'object' && 'greet' in ask ? ask.greet : await write()
    if (text === '') return
    // An opinion that ends on a question opens the answer field too.
    // A chat's question is answered by the next chat.
    if (typeof ask === 'object' && 'chat' in ask) {
      const past = [...(stage.chats.get(c.voiceId) ?? []), `User: ${ask.chat}`, `${c.voice.name}: ${text}`]
      stage.chats.set(c.voiceId, past.slice(-CHAT_LINES))
    }
    if (ask === 'question' || (isConsult && !isChat && text.endsWith('?'))) {
      stage.openQuestion = { text, at: c.now() }
      $.ui.invalidate('ui.render')
    }
    stage.recent.push(text)
    if (stage.recent.length > RECENT_LINES) stage.recent.shift()
    if (c.memory !== null) {
      const at = c.memory
      const episode = episodeOf(ask, c.voice.name, text)
      if (episode !== null) void keep($, at, c.voiceId, episode.value, [episode.kind])
      if (typeof ask === 'object' && 'duo' in ask && ask.turn === DUO_TURNS - 1 && c.otherId !== '') {
        const last = `${c.voice.name}: ${text}`
        const otherName = c.isGuestTurn ? c.host : (stage.guest?.persona.name ?? c.otherId)
        void keep($, at, c.voiceId, visitOf(ask.history, last, otherName), ['visit'])
        void keep($, at, c.otherId, visitOf(ask.history, last, c.voice.name), ['visit'])
      }
    }
    const isDuo = typeof ask === 'object' && 'duo' in ask
    const shown = isDuo ? `${c.voice.name}: ${text}` : text
    const isQuiet = await read($, isMuted)
    stage.typing = start(stage.typing, shown, isQuiet, c.now())
    const seq = stage.typing.seq
    await update($, line, () => ({ text: shown, at: c.now() }) satisfies Line)
    if (!isQuiet) {
      const made = await $.process.run(synthArgv(c.voiceId, c.voice, await read($, volume)), {
        stdin: text,
        timeoutMs: 30_000,
      })
      const heard = voiced(stage.typing, seq, made.stdout, c.now(), FRAME_MS)
      stage.typing = heard.t
      const { wav, ms } = heard
      if (wav !== '') {
        // Detached, so a reload of this module no longer cuts the line;
        // the voice is held for the WAV's length plus PowerShell's start.
        await update($, isVoicing, () => true)
        await $.process.run(detachedArgv(playArgv(wav, c.relay.session, SAPI_PLAY, seq)))
        await $.clock.sleep(ms + PLAY_START_MS)
      }
    }
    if (typeof ask === 'object' && 'duo' in ask && ask.turn < DUO_TURNS - 1) {
      c.say({ ...ask, turn: ask.turn + 1, history: [...ask.history, `${c.voice.name}: ${text}`] })
    }
  } catch (err) {
    // A synthesis past its timeout, a model call that failed: the line
    // is lost, the reason kept.
    $.ui.log(`avatar7: a line was lost: ${String(err)}`, { to: 'debug' })
  } finally {
    // A dialogue ends on its last turn, or on a turn that said nothing.
    if (typeof ask === 'object' && 'duo' in ask && !stage.queue.some(q => typeof q.ask === 'object' && 'duo' in q.ask)) {
      stage.isGuestShown = false
      stage.guest = null
    }
    stage.typing = end(stage.typing)
    if (await read($, isVoicing)) await update($, isVoicing, () => false)
  }
}

export const register: Register = (on, options) => {
  const userName = typeof options.user_name === 'string' ? options.user_name.trim() : ''
  // The personas' own mem7, or null: then they forget between sessions.
  const memory = memoryAt(options)
  let frame = 0
  // The face: its mood and the waits that hold it (mood.ts).
  let face: Face = calm
  // What speaking changes: the line, the queue, the guest, the open question,
  // the chats and the last lines (Stage); speak() takes it whole.
  const stage: Stage = { typing: silent, queue: [], guest: null, isGuestShown: false, openQuestion: null, chats: new Map(), recent: [] }
  // The remote voice, its own state (relay.ts); relay.session is '' in a
  // background session.
  const relay = newRelay()
  let sessionDir = ''
  let lastPrompt = ''
  let streak: Streak = { mood: 'watch', count: 0 }
  // The persona's own events: on unless /avatar events off; the next one's frame.
  let eventsOn = true
  // Visits from other personas, a share of the events, switched apart.
  let visitsOn = true
  let nextEventAt = Infinity
  const nextGap = (): number => EVENT_MIN_FRAMES + Math.random() * EVENT_SPAN_FRAMES
  // A visit: the guest read (loadGuest), then the host opens.
  const startDuo = (g: Guest, topic: Duo['topic']): boolean => {
    // One visit at a time: a second would take over the first's turns.
    if (stage.guest !== null) return false
    stage.guest = g
    face = react(face, 'watch', frame, 30)
    speakLater({ duo: g.id, turn: 0, topic, history: [] })
    return true
  }
  const startEvent = (ask: Ask): void => {
    if (typeof ask === 'object' && 'story' in ask) {
      face = stageFace(face, ask.mood, frame, 60)
    }
    speakLater(ask)
  }
  let faces: Faces | null = null
  let who: Persona | null = null
  // The avatar `who` was read from, so a line keeps its voice through a switch.
  let whoId = ''
  let size = W
  // The ambient's geometry, set at each render: the margins either side of
  // the face, the band under the text, in cells; and its own clock, which
  // runs faster on a refusal or an error and slower while a human decides.
  let ambLeft = 0
  let ambRight = 0
  let ambBand = 0
  let ambField: Field = { width: 0, height: 0, sceneTop: 0, sceneBottom: 0 }
  let ambT = 0
  let asked = ''
  const speakLater = (ask: Ask): void => {
    stage.queue = enqueue(stage.queue, ask, frame)
  }
  // The last `say` of each mod, for /avatar voices.
  const saidHere = new Map<string, Say>()
  // An avatar picked in the pane or by /avatar; the clock swaps it in.
  let pendingAvatar: string | null = null
  let avatarPick = 0
  let isPicking = false
  // The field where the user asks the avatar's opinion, open or not.
  let isConsulting = false
  // The field where the user talks to the avatar personally.
  let isChatting = false
  // Display names for the picker, read from each persona.json.
  const names: Record<string, string> = {}
  let lastModel = ''

  // The face's frame, as draw.ts takes it: whoever is shown (the guest
  // during a visit), its mood and weather, read once per frame.
  const view = (): View => {
    const isGuest = stage.isGuestShown && stage.guest !== null
    return {
      frame,
      frameMs: FRAME_MS,
      mood: face.mood,
      faces: isGuest && stage.guest !== null ? stage.guest.faces : faces,
      persona: isGuest && stage.guest !== null ? stage.guest.persona : who,
      isHeard: isHeard(stage.typing, frame),
      glitch: face.isStaged ? SCENE_GLITCH : 1,
      size,
      layers: ambientLayers(),
      field: ambField,
      ambLeft,
      ambT,
    }
  }
  const cells = (): string => faceCells(view())
  // The face last blitted, to skip the frames that change nothing.
  let lastFace = ''

  // The face as a real image (hd.ts), where the terminal draws pictures and
  // the persona has its HD bake: the band's width in columns, set at each
  // render; whether the last render mounted the Image; the key of the
  // picture it shows, so the clock blits only when the picture changes; and
  // the last pictures made, since the same few come back (moods, mouth).
  let hdColumns = 0
  // The art pixel's side (hd.ts GRAINS): /avatar pixel <n>, kept in $.store.
  let grain: number = DEFAULT_GRAIN
  type HdSource = { file: string; format: 'rgba'; width: number; height: number } | { rgba: string; width: number; height: number }
  type HdBand = HdView['band']
  // The picture files written, or being written, by path.
  const hdFiles = new Map<string, 'pending' | 'ready'>()
  // Each band's source as shown, kept as one object, so a redraw that
  // changes nothing hands the engine the very same source and nothing is
  // sent; and its key.
  const hdShown: Record<HdBand, { source: HdSource; key: string } | null> = { face: null, under: null }
  const isHdShown = (): boolean => hdShown.face !== null
  // The pane's size and the frame it last changed (hd.ts isSettled).
  const hdResize: Settle = { size: '', since: 0 }
  let isHdSettled = false
  // The scene layers with their HD bake in place of the 512 px one, made
  // once per layer list so the fitted scene's cache holds.
  const hdLayersOf = new WeakMap<AmbientLayer[], AmbientLayer[]>()
  const hdLayers = (layers: AmbientLayer[], hd: Hd | null | undefined): AmbientLayer[] => {
    const scene = hd?.scene
    if (scene === null || scene === undefined) return layers
    let swapped = hdLayersOf.get(layers)
    if (swapped === undefined) {
      swapped = layers.map(l => (l.kind === 'scene' ? { ...l, pixels: scene.pixels, width: scene.width, height: scene.height } : l))
      hdLayersOf.set(layers, swapped)
    }
    return swapped
  }
  const hdView = (band: HdBand): HdView | null => {
    const v = view()
    const hd = v.faces?.hd
    if (!isHdTerminal || hd === undefined || hd === null || v.persona === null || hdColumns === 0) return null
    if (band === 'under' && ambBand === 0) return null
    const isGuest = stage.isGuestShown && stage.guest !== null
    // The weather loops over HD_LOOP pictures, each made once.
    const step = Math.floor(ambT / HD_STEP_S) % HD_LOOP
    const isFace = band === 'face'
    return {
      who: isGuest && stage.guest !== null ? stage.guest.id : whoId,
      band,
      hd: isFace ? hd : null,
      mood: isFace ? v.mood : v.mood === 'deny' ? 'deny' : 'idle',
      face: pickHdFace(hd, v.mood, v.isHeard, noise(v.frame >> 2, 7)),
      glitchStep: isFace && v.mood === 'deny' ? 1 + ((v.frame >> 2) % GLITCH_STEPS) : 0,
      glitch: v.glitch,
      grain,
      color: v.persona.color ?? '#00ff9c',
      cutout: v.persona.cutout ?? 12,
      columns: hdColumns,
      rows: isFace ? size / 2 : ambBand,
      size: isFace ? size : 0,
      layers: hdLayers(v.layers, hd),
      field: v.field,
      top: isFace ? 0 : size + TEXT_ROWS * 2,
      t: step * HD_STEP_S,
      step,
      isStorm: v.mood === 'deny',
      stamp: hd.stamp,
    }
  }
  const fileSource = (hv: HdView): HdSource => ({ file: hdPath(hdKey(hv)), format: 'rgba', ...hdSize(hv.columns, hv.rows) })
  // The source a band shows at a render: its picture if written, else the
  // last one until the clock swaps the new one in, else (the first) bytes;
  // and the view whose file is still to write.
  // The engine takes at most 2 MiB of Image source a tree: a band whose
  // bytes would pass what is left waits for its file, and the clock renders
  // again once it is written.
  const HD_INLINE_MAX = 2_000_000
  const hdRender = (band: HdBand, budget: { left: number }): { source: HdSource | null; toWrite: HdView | null; rgba?: Uint8Array } => {
    const hv = hdView(band)
    if (hv === null) {
      hdShown[band] = null
      return { source: null, toWrite: null }
    }
    const key = hdKey(hv)
    const was = hdShown[band]
    const isReady = hdFiles.get(hdPath(key)) === 'ready'
    let rgba: Uint8Array | undefined
    if (isReady) {
      if (was?.key !== key) hdShown[band] = { source: fileSource(hv), key }
    } else {
      const { width, height } = hdSize(hv.columns, hv.rows)
      if (was === null || was.source.width !== width || was.source.height !== height) {
        // Mid-resize: the last picture, stretched, and nothing made.
        if (was !== null && !isHdSettled) return { source: was.source, toWrite: null }
        const inline = Math.ceil((width * height * 4) / 3) * 4
        if (inline > budget.left) return { source: was?.source ?? null, toWrite: hv }
        budget.left -= inline
        rgba = hdFrame(hv)
        hdShown[band] = { source: { rgba: rgba.toBase64(), width, height }, key }
      }
    }
    return { source: hdShown[band]?.source ?? null, toWrite: isReady ? null : hv, rgba }
  }
  // At a frame: the band's new picture to swap in once written, or the view
  // whose file is still to write.
  const hdTick = (band: HdBand): { swap: HdSource | null; toWrite: HdView | null; isRefit: boolean } => {
    const hv = hdView(band)
    const shown = hdShown[band]
    if (hv === null) return { swap: null, toWrite: null, isRefit: false }
    const key = hdKey(hv)
    // Not shown yet: its file, once written, mounts it at a render.
    if (shown === null) return { swap: null, toWrite: null, isRefit: hdFiles.get(hdPath(key)) === 'ready' }
    if (key === shown.key) return { swap: null, toWrite: null, isRefit: false }
    // A new size: once it holds, a render makes its picture.
    const { width, height } = hdSize(hv.columns, hv.rows)
    if (shown.source.width !== width || shown.source.height !== height) return { swap: null, toWrite: null, isRefit: isSettled(hdResize, hdResize.size, frame) }
    if (hdFiles.get(hdPath(key)) !== 'ready') return { swap: null, toWrite: hv, isRefit: false }
    const source = fileSource(hv)
    hdShown[band] = { source, key }
    return { swap: source, toWrite: null, isRefit: false }
  }

  // The weather of whoever is shown: the guest's during a visit.
  const ambientLayers = (): AmbientLayer[] =>
    (stage.isGuestShown && stage.guest !== null ? stage.guest.persona.ambient : who?.ambient) ?? []

  // The repaints of the ambient's Rasters, the ones the last render mounted.
  const ambientBlits = (): { requestId: string; key: string; columns: number; rows: number; cells: string }[] => {
    const layers = ambientLayers()
    if (layers.length === 0) return []
    const isStorm = face.mood === 'deny'
    const rows = size / 2
    const paint = (key: string, x0: number, y0: number, columns: number, height: number) => ({
      requestId: PANE,
      key,
      columns,
      rows: height,
      cells: ambientCells(layers, ambField, x0, y0, columns, height, ambT, isStorm),
    })
    return [
      // Beside the face only in half blocks: the HD picture holds its own scene.
      ...(ambLeft > 0 && !isHdShown() ? [paint(AMB_LEFT, 0, 0, ambLeft, rows)] : []),
      ...(ambRight > 0 && !isHdShown() ? [paint(AMB_RIGHT, ambLeft + size, 0, ambRight, rows)] : []),
      ...(ambBand > 0 && hdShown.under === null ? [paint(AMB_BAND, 0, size + TEXT_ROWS * 2, ambField.width / QUAD, ambBand)] : []),
    ]
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
    const env = await $.process.run(['sh', '-c', 'printf %s "$TERM|$TERM_PROGRAM|$AVATAR7_HD"'])
    isHdTerminal = drawsPictures(env.stdout)
    // Pictures a day old belong to panes long gone.
    if (isHdTerminal) await $.process.run(['sh', '-c', `mkdir -p ${HD_DIR} && find ${HD_DIR} -type f -mmin +1440 -delete`])
    // A reload mid-line kills the timer that would lower it: jukebox7 would
    // stay ducked.
    if (await read($, isVoicing)) await update($, isVoicing, () => false)
    await relayOpen($, relay)
    sessionDir = e.cwd.split('/').filter(Boolean).at(-1) ?? '/'

    await $.command.register({
      name: 'avatar',
      description: `Open the avatar pane, or switch: /avatar ${AVATARS.join('|')}; /avatar event, /avatar duo [id], /avatar events on|off, /avatar visits on|off, /avatar remote on|off, /avatar pixel ${GRAINS.join('|')}`,
    })
    await $.command.register({ name: 'avatar-mute', description: 'Toggle the avatar voice' })
    await $.command.register({ name: 'avatar-talk', description: 'Ask the avatar what it thinks of the conversation' })
    await $.command.register({
      name: 'avatar-chat',
      description: 'Talk to the avatar personally, not about the session: /avatar-chat <what you say>',
    })
    await $.command.register({
      name: 'avatar-ask',
      description: 'Ask the avatar its opinion on the session: /avatar-ask <question>',
    })

    const storedVolume = await $.store.get('volume')
    if (typeof storedVolume === 'number') await update($, volume, () => storedVolume)

    const stored = await $.store.get('avatar')
    const id = typeof stored === 'string' && AVATARS.includes(stored) ? stored : DEFAULT
    await update($, onDuty, () => id)
    try {
      const dir = `${$.plugin.root}/personas/${id}`
      who = await readPersona($, id)
      whoId = id
      await update($, tint, () => who?.color ?? '')
      await update($, station, () => ({ name: who?.name ?? '', artists: who?.station ?? [] }))
      faces = await loadFaces($, dir)
    } catch {
      $.ui.log(`avatar7: personas/${id} unreadable, run tools/bake.py ${id}`)
    }
    if (isHdTerminal) await hdOnDisk($, hdFiles)
    if (memory !== null && who !== null) {
      const voice = who
      void summarize($, memory, id, voice, userName).catch(err => $.ui.log(`avatar7: no journal for ${id}: ${String(err)}`, { to: 'debug' }))
    }
    for (const each of AVATARS) {
      try {
        names[each] = (JSON.parse(String(await $.fs.read(`${$.plugin.root}/personas/${each}/persona.json`))) as Persona).name
      } catch {
        names[each] = each
      }
    }

    const last = await read($, line)
    stage.typing = restored(stage.typing, last.text)
    eventsOn = (await $.store.get('events')) !== false
    const storedGrain = await $.store.get('pixel')
    if (typeof storedGrain === 'number' && (GRAINS as readonly number[]).includes(storedGrain)) grain = storedGrain
    visitsOn = (await $.store.get('visits')) !== false
    nextEventAt = frame + nextGap()

    $.clock.every(FRAME_MS, () => {
      frame += 1
      if (pendingAvatar !== null) {
        const id = pendingAvatar
        pendingAvatar = null
        const pick = ++avatarPick
        void (async () => {
          const dir = `${$.plugin.root}/personas/${id}`
          // Loaded whole before anything switches: a persona that cannot be
          // read leaves the one on duty, and of two quick picks the last wins.
          const chosen = await readPersona($, id)
          const chosenFaces = await loadFaces($, dir)
          if (pick !== avatarPick) return
          who = chosen
          whoId = id
          faces = chosenFaces
          await update($, tint, () => who?.color ?? '')
          await update($, station, () => ({ name: who?.name ?? '', artists: who?.station ?? [] }))
          await $.store.set('avatar', id)
          await update($, onDuty, () => id)
          await $.ui.open({ id: PANE, title: who.name })
  
          // Through the queue like any line: never over another voice, and
          // jukebox7 hears isVoicing for it too.
          speakLater({ greet: personalize(who.greeting, userName, who.nobody) })
          if (memory !== null) await summarize($, memory, id, chosen, userName)
        })().catch(err => $.ui.log(`avatar7: personas/${id} could not take over: ${String(err)}`))
      }
      face = tick(face, frame, WAIT_CAP_FRAMES)
      relayTick($, relay, frame, {
        face: () => {
          if (who === null) return undefined
          const shownWho = stage.isGuestShown && stage.guest !== null ? stage.guest.persona : who
          const base = {
            persona: stage.isGuestShown && stage.guest !== null ? stage.guest.id : whoId,
            name: shownWho.name,
            color: shownWho.color ?? '',
            mood: face.mood,
            line: stage.typing.text,
            seq: stage.typing.seq,
            speakMs: Math.max(0, stage.typing.speakUntil - stage.typing.from) * FRAME_MS,
            isSpeaking: isHeard(stage.typing, frame),
            question: stage.openQuestion?.text ?? '',
            avatars: AVATARS.map(id => ({ id, name: names[id] ?? id })),
            eventsOn,
            visitsOn,
            session: [relay.session.slice(0, 8), sessionDir, lastPrompt === '' ? '' : `"${lastPrompt.slice(0, 40)}"`].filter(Boolean).join(' / '),
          }
          return (async (): Promise<Mirror> => ({ ...base, isMuted: await read($, isMuted), volume: await read($, volume) }))()
        },
        press: async r => {
          if (r.cmd === 'talk') speakLater('talk')
          else if (r.cmd === 'ask') {
            const question = r.text.replace(/\s+/g, ' ').trim().slice(0, CONSULT_CHARS_ASKED)
            if (question !== '') speakLater({ consult: question })
          } else if (r.cmd === 'chat') {
            const said = r.text.replace(/\s+/g, ' ').trim().slice(0, CONSULT_CHARS_ASKED)
            if (said !== '') speakLater({ chat: said })
          } else if (r.cmd === 'answer') {
            const answer = r.text.replace(/\s+/g, ' ').trim().slice(0, ASKED_CHARS)
            const q = stage.openQuestion
            if (answer !== '' && q !== null) {
              stage.openQuestion = null
              speakLater({ question: q.text, answer })
            }
          } else if (r.cmd === 'avatar') {
            if (AVATARS.includes(r.id) && r.id !== whoId) pendingAvatar = r.id
          } else if (r.cmd === 'duo') {
            // A visit now, as /avatar duo with no name: a guest picked at random among the friends.
            const gid = pickGuest(AVATARS, whoId, Math.random(), who?.friends)
            const g = gid === undefined || gid === whoId ? null : await loadGuest($, gid)
            if (g !== null) startDuo(g, Math.random() < 0.5 ? 'session' : 'stories')
          } else if (r.cmd === 'mute') await update($, isMuted, was => !was)
          else if (r.cmd === 'events') {
            eventsOn = !eventsOn
            await $.store.set('events', eventsOn)
          } else if (r.cmd === 'visits') {
            visitsOn = !visitsOn
            await $.store.set('visits', visitsOn)
          } else if (r.cmd === 'volume') {
            const step = r.step * VOLUME_STEP
            const v = await update($, volume, was => Math.min(100, Math.max(0, was + step)))
            await $.store.set('volume', v)
          }
          $.ui.invalidate('ui.render')
        },
      })
      let isRefit = false
      for (const [band, key] of [['face', FACE], ['under', AMB_BAND]] as const) {
        const tick = hdTick(band)
        if (tick.toWrite !== null) hdEnsure($, hdFiles, tick.toWrite)
        if (tick.swap !== null) void $.ui.blit({ requestId: PANE, key, source: tick.swap })
        isRefit ||= tick.isRefit
      }
      if (isRefit) $.ui.invalidate('ui.render')
      // Sent only when it changed: each blit redraws the screen, and in a
      // terminal without synchronized output (WezTerm) the cursor jumped at
      // 15 i/s. A full render draws the face afresh, so a skip never leaves
      // a stale one.
      if (!isHdShown()) {
        const drawn = cells()
        if (drawn !== lastFace) {
          lastFace = drawn
          void $.ui.blit({ requestId: PANE, key: FACE, columns: size, rows: size / 2, cells: drawn })
        }
      }
      if (frame % AMBIENT_FRAMES === 0) {
        ambT += ((AMBIENT_FRAMES * FRAME_MS) / 1000) * (face.mood === 'deny' || face.mood === 'error' ? 2 : face.mood === 'wait' ? 0.5 : 1)
        for (const each of ambientBlits()) void $.ui.blit(each)
      }
      const typedOn = typeOn(stage.typing, frame)
      if (typedOn !== stage.typing) {
        stage.typing = typedOn
        $.ui.invalidate('ui.render')
      } else if (frame % REFIT_FRAMES === 0) {
        $.ui.invalidate('ui.render')
      }

      if (face.askSince !== null && frame - face.askSince === ASK_FRAMES) {
        speakLater({ mood: 'wait', event: `call waiting for the user's permission: ${face.askCall}` })
      }

      // Now and then, when nothing else happens, a moment of the persona's own.
      if (
        eventsOn &&
        who !== null &&
        frame >= nextEventAt &&
        stage.queue.length === 0 &&
        !stage.typing.isSpeaking &&
        !isWaiting(face) &&
        stage.openQuestion === null &&
        frame - stage.typing.lastSpoke > EVENT_QUIET_FRAMES
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
      if (stage.openQuestion !== null && frame - stage.openQuestion.at > QUESTION_FRAMES) {
        stage.openQuestion = null
        $.ui.invalidate('ui.render')
      }

      stage.queue = fresh(stage.queue, frame)
      // A line may wait a moment for a mod to say better (a mesh7 verdict).
      const ready = stage.queue.findIndex(q => typeof q.ask !== 'object' || !('after' in q.ask) || (q.ask.after ?? 0) <= frame)
      const first = stage.queue[ready]
      if (first === undefined || stage.typing.isSpeaking || who === null) return
      stage.queue = stage.queue.filter((_, i) => i !== ready)
      const ask = first.ask
      stage.typing = begin(stage.typing, frame)
      // In a dialogue the guest speaks the odd turns, with its own voice and face.
      const isGuestTurn = typeof ask === 'object' && 'duo' in ask && ask.turn % 2 === 1 && stage.guest !== null
      const voice = isGuestTurn && stage.guest !== null ? stage.guest.persona : who
      const voiceId = isGuestTurn && stage.guest !== null ? stage.guest.id : whoId
      const otherId = isGuestTurn ? whoId : (stage.guest?.id ?? '')
      stage.isGuestShown = isGuestTurn
      const host = who.name
      $.clock.after(1, () =>
        speak($, stage, ask, { voice, voiceId, isGuestTurn, otherId, memory, host, asked, userName, relay, now: () => frame, say: speakLater }),
      )
    })

    // Opened after the plugins beneath have started: the pane opened last is
    // the one shown, and mesh7-pane or jukebox7 would take that place. Once
    // more a moment later, should one of them open late.
    const started = await next(e)
    void $.ui.open({ id: PANE, title: who?.name ?? 'avatar7' })
    $.clock.after(1500, () => void $.ui.open({ id: PANE, title: who?.name ?? 'avatar7' }))
    return started
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
      if (!startDuo(g, Math.random() < 0.5 ? 'session' : 'stories')) return { text: `${stage.guest?.persona.name ?? 'A guest'} is visiting already.` }
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
    if (id.startsWith('pixel')) {
      const n = Number(id.slice('pixel'.length).trim())
      if (!(GRAINS as readonly number[]).includes(n)) return { text: `The pixel's size, in kitty or Ghostty: /avatar pixel ${GRAINS.join('|')} (1 smooth, 6 the half blocks' grid); now ${grain}.` }
      grain = n
      await $.store.set('pixel', n)
      $.ui.invalidate('ui.render')
      return { text: isHdTerminal ? `Pixels of ${n}.` : `Pixels of ${n}, seen in kitty or Ghostty; this terminal keeps the half blocks.` }
    }
    if (id === 'remote on') return { text: await relayOn($, relay) }
    if (id === 'remote off') return { text: await relayOff($, relay) }
    if (!AVATARS.includes(id)) return { text: `Unknown avatar. Choose one of: ${AVATARS.join(', ')}.` }

    pendingAvatar = id
    return { text: `${names[id] ?? id} takes over.` }
  })

  on('command.run', { command: 'avatar-talk' }, async () => {
    speakLater('talk')
    return { text: `${who?.name ?? 'avatar7'} reads the conversation.` }
  })

  on('command.run', { command: 'avatar-chat' }, async ($, e) => {
    const said = e.args.replace(/\s+/g, ' ').trim().slice(0, CONSULT_CHARS_ASKED)
    if (said === '') return { text: 'Usage: /avatar-chat <what you say>' }
    speakLater({ chat: said })
    return { text: `${who?.name ?? 'avatar7'} listens.` }
  })

  on('command.run', { command: 'avatar-ask' }, async ($, e) => {
    const question = e.args.replace(/\s+/g, ' ').trim().slice(0, CONSULT_CHARS_ASKED)
    if (question === '') return { text: 'Usage: /avatar-ask <question>' }
    speakLater({ consult: question })
    return { text: `${who?.name ?? 'avatar7'} reads the session and thinks it over.` }
  })

  // Every other slash command, native or custom: the listed ones earn a line,
  // the rest run untouched.
  on('command.run', async ($, e, next) => {
    const heard = commandEvent(e.command, e.args)
    if (heard !== undefined) speakLater(heard)
    return next(e)
  })

  // An automatic compaction, the main conversation's only: the manual one
  // came through /compact.
  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'auto' && e.agentId === undefined) {
      speakLater({ mood: 'error', event: 'the context window filled up and the conversation was compacted on its own' })
    }
    return next(e)
  })

  on('command.run', { command: 'avatar-mute' }, async $ => {
    const muted = await update($, isMuted, was => !was)
    return { text: muted ? 'The avatar falls silent.' : 'The avatar speaks again.' }
  })

  // A session that ends gives the relay back; a /clear keeps a forced one.
  on('session.end', async ($, e, next) => {
    await relayEnd($, relay, e.reason)
    return next(e)
  })

  // A model switch is no command the mod sees (the /model picker settles it
  // after the command has run, and Remote Control or /config switch without
  // one): the model in use is compared at each turn's end.
  on('turn.complete', async ($, e, next) => {
    asked = ''
    if (relay.session !== '') {
      const model = await $.session.model()
      if (lastModel !== '' && model !== lastModel && who !== null) {
        speakLater({ mood: 'watch', event: `the assistant now runs on ${model}, no longer on ${lastModel}` })
      }
      lastModel = model
    }
    return next(e)
  })

  // Only what the user typed, at the terminal or through Remote Control.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      asked = e.text.replace(/\s+/g, ' ').trim().slice(0, ASKED_CHARS)
      lastPrompt = asked
    }
    await relayFollow($, relay, e.origin.kind)
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
      // A mod that speaks by say no longer has its toasts read out: one line
      // per event (jukebox7 moved from announce to say; a session that heard
      // its announce before would say each song twice).
      if (heardHere.delete(w.plugin) || (await read($, announcers))[w.plugin] !== undefined) {
        await update($, announcers, was => Object.fromEntries(Object.entries(was).filter(([k]) => k !== w.plugin)))
      }
      // The mod's line replaces the avatar's own waiting line on that call.
      if (s.tool !== undefined) stage.queue = stage.queue.filter(q => !(typeof q.ask === 'object' && 'tool' in q.ask && q.ask.tool === s.tool))
      face = s.hold === true ? hold(face, s.tool ?? 'a call', frame) : s.release === true ? release(face, s.mood, frame) : react(face, s.mood, frame)
      if (who !== null) speakLater({ mood: s.mood, event: s.event })
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
      face = react(face, bell.mood, frame, 30)
      speakLater({ mood: bell.mood, event: `${bell.event}: ${e.text}` })
    }
    return next(e)
  })

  // The verdict before the mode settles it: an ask may put up the prompt.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id !== undefined) {
      face = askFace(face, describe({ ...(e.input as Record<string, unknown>), tool: e.tool }), frame)
    }
    return verdict
  })

  on('tool.call', async ($, e, next) => {
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } finally {
      // An interrupt at the permission prompt still ends the wait.
      face = answered(face)
    }

    const call = describe(e as unknown as Record<string, unknown>)
    const now: Mood = ran.deny !== undefined ? 'deny' : ran.isError === true ? 'error' : 'watch'

    // A held call keeps the waiting face; the others set theirs.
    face = react(face, now, frame)

    // Counted on every call, spoken or not; a broken run of failures earns
    // the short wait a failure gets.
    const was = streak
    streak = nextStreak(was, now as Streak['mood'])
    const note = streakNote(was, streak)

    const quiet = now === 'watch' && note === '' ? 45_000 / FRAME_MS : 5_000 / FRAME_MS
    // A plain success waits for silence; a refusal or a failure takes its
    // place in the queue, ahead of the calmer lines.
    if (frame - stage.typing.lastSpoke < quiet || (now === 'watch' && (stage.typing.isSpeaking || stage.queue.length > 0))) return ran
    // A refusal, a failure, or any call through mesh7 waits ~1.8 s: mesh7-pane,
    // when loaded, may say what mesh7 decided and replace this line.
    const mayBeSaid = now !== 'watch' || e.tool.startsWith('mcp__mesh7__')
    speakLater({
      ...(mayBeSaid ? { tool: e.tool, after: frame + SAY_WAIT_FRAMES } : {}),
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
    const shown = last.text.slice(0, Math.floor(stage.typing.typed))
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

    const { Box, Text, Raster, Button, Input, Image } = $.ui.resolve(e)
    const muted = await read($, isMuted)
    const vol = await read($, volume)
    const current = await read($, onDuty)
    size = fit(e.props.bodyColumns, e.props.scroll.bodyRows)
    // Rules in the persona's color between the face, the line and the
    // controls, drawn as a terminal's: a label, a status on the right, a
    // cursor that blinks at each redraw, dashes that glitch on a denial.
    const cols = Math.max(8, e.props.bodyColumns)
    // The weather fills the margins beside the face and the band under the
    // text. The band is drawn as tall as it could be and sits in the room the
    // text leaves, anchored to its bottom: when the line wraps or a field
    // opens, its faded top is clipped instead of the face being squeezed.
    const layers = ambientLayers()
    const isAmbient = layers.length > 0
    ambLeft = isAmbient ? Math.floor((cols - size) / 2) : 0
    ambRight = isAmbient ? cols - size - ambLeft : 0
    ambBand = isAmbient ? Math.max(0, e.props.scroll.bodyRows - size / 2 - 4) : 0
    ambField = { width: cols * QUAD, height: size + TEXT_ROWS * 2 + ambBand * 2, sceneTop: size / 2, sceneBottom: size + TEXT_ROWS * 2 + Math.min(ambBand, SCENE_OVERFLOW_ROWS) * 2 }
    const ambient = (key: string, x0: number, y0: number, columns: number, rows: number) => (
      <Raster key={key} columns={columns} rows={rows} cells={ambientCells(layers, ambField, x0, y0, columns, rows, ambT, face.mood === 'deny')} />
    )
    hdColumns = cols
    isHdSettled = isSettled(hdResize, `${cols}|${ambBand}`, frame)
    const budget = { left: HD_INLINE_MAX }
    const faceHd = hdRender('face', budget)
    const underHd = faceHd.source === null ? { source: null, toWrite: null } : hdRender('under', budget)
    for (const { toWrite, rgba } of [faceHd, underHd]) if (toWrite !== null) hdEnsure($, hdFiles, toWrite, rgba)
    const hdFace = faceHd.source
    const hdUnder = underHd.source
    const isBlink = Math.floor(frame / REFIT_FRAMES) % 2 === 0
    const moodColor = face.mood === 'idle' ? color : `#${TINT[face.mood].toString(16).padStart(6, '0')}`
    const seconds = Math.floor((frame * FRAME_MS) / 1000)
    const clock = [seconds / 3600, (seconds / 60) % 60, seconds % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':')
    const dashes = (n: number, salt: number): string =>
      Array.from({ length: Math.max(0, n) }, (_, i) =>
        face.mood === 'deny' && noise(frame + salt, i) < 0.12 ? '╳▚░'[i % 3] : '─',
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
        <Box flexDirection="row" justifyContent="center" width="100%" flexShrink={0} backgroundColor="#000000">
          {hdFace !== null && <Image key={FACE} source={hdFace} columns={cols} rows={size / 2} alt=" " />}
          {hdFace === null && ambLeft > 0 && ambient(AMB_LEFT, 0, 0, ambLeft, size / 2)}
          {hdFace === null && <Raster key={FACE} columns={size} rows={size / 2} cells={cells()} />}
          {hdFace === null && ambRight > 0 && ambient(AMB_RIGHT, ambLeft + size, 0, ambRight, size / 2)}
        </Box>
        {rule('rule-face', (who?.name ?? 'avatar7').toUpperCase(), `[${face.mood.toUpperCase()}]`, moodColor, 0)}
        <Text color={color} backgroundColor="#000000">
          {shown.length > 0 ? `> ${shown}` : '> ...'}
          {stage.typing.typed < last.text.length ? '█' : ''}
        </Text>
        {face.held !== null && (
          <Text color="#7a5cff" backgroundColor="#000000" wrap="truncate-end">
            {`waiting for a human: ${face.held}`}
          </Text>
        )}
        {stage.openQuestion !== null && (
          <Input
            key="answer"
            label="answer: "
            placeholder="ctrl+x tab, type, Enter"
            submitLabel="answer"
            autoFocus
            onSubmit={value => {
              const answer = value.replace(/\s+/g, ' ').trim().slice(0, ASKED_CHARS)
              const q = stage.openQuestion
              if (answer === '' || q === null) return
              stage.openQuestion = null
              speakLater({ question: q.text, answer })
              $.ui.invalidate('ui.render')
            }}
          />
        )}
        {isChatting && (
          <Input
            key="chat"
            label="chat: "
            placeholder="ctrl+x tab, say anything, Enter"
            submitLabel="say"
            autoFocus
            onSubmit={value => {
              const said = value.replace(/\s+/g, ' ').trim().slice(0, CONSULT_CHARS_ASKED)
              if (said === '') return
              speakLater({ chat: said })
              $.ui.invalidate('ui.render')
            }}
          />
        )}
        {isConsulting && (
          <Input
            key="consult"
            label="ask: "
            placeholder="ctrl+x tab, your question, Enter"
            submitLabel="ask"
            autoFocus
            onSubmit={value => {
              const question = value.replace(/\s+/g, ' ').trim().slice(0, CONSULT_CHARS_ASKED)
              if (question === '') return
              isConsulting = false
              speakLater({ consult: question })
              $.ui.invalidate('ui.render')
            }}
          />
        )}
        <Box flexGrow={1} height={0} overflow="hidden" flexDirection="column" justifyContent="flex-end" backgroundColor="#000000">
          {ambBand > 0 && hdUnder !== null && <Image key={AMB_BAND} source={hdUnder} columns={cols} rows={ambBand} alt=" " />}
          {ambBand > 0 && hdUnder === null && ambient(AMB_BAND, 0, size + TEXT_ROWS * 2, cols, ambBand)}
        </Box>
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
            key="ask"
            label={isConsulting ? 'close ask' : 'ask'}
            hotkey="q"
            plain
            dimColor
            onPress={() => {
              isConsulting = !isConsulting
              $.ui.invalidate('ui.render')
            }}
          />
          <Button
            key="chat"
            label={isChatting ? 'close chat' : 'chat'}
            hotkey="h"
            plain
            dimColor
            onPress={() => {
              isChatting = !isChatting
              $.ui.invalidate('ui.render')
            }}
          />
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
