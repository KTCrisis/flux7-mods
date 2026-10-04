// The remote voice: while tools/relay.py runs, the session that holds it sends
// its lines, its face and the page's presses through a spool, for a browser
// tab on another machine of the tailnet; every other session, and this one
// when it does not hold it, speaks on the host. Here: the protocol, the shell
// that touches the spool, the state and the decisions. The engine calls ($)
// stay in register.tsx, which the engine requires: $ is never followed across
// an import.

export const RELAY_SPOOL = '${XDG_CACHE_HOME:-$HOME/.cache}/avatar7/relay'

// The face as the relay's page draws it: who, in which mood, saying what, for
// how long; written whole to the spool when it changes, while the relay runs.
// The pane's controls ride along, so the page can draw them as they stand.
export type Mirror = {
  persona: string
  name: string
  color: string
  mood: string
  line: string
  seq: number
  speakMs: number
  isSpeaking: boolean
  question: string
  avatars: { id: string; name: string }[]
  isMuted: boolean
  eventsOn: boolean
  visitsOn: boolean
  volume: number
  // Which session holds the relay: short id, folder, last prompt typed.
  session: string
}

// What the page may ask: the pane's gestures, never mesh7's approvals. talk,
// ask and chat do reach the session: Haiku reads its last messages and the
// answer goes back to the page, which also shows 40 characters of the last
// prompt. The relay binds to the tailnet only, and takes presses only while a
// session holds it.
export type Remote =
  | { cmd: 'talk' | 'mute' | 'events' | 'visits' }
  | { cmd: 'ask' | 'answer' | 'chat'; text: string }
  | { cmd: 'avatar'; id: string }
  | { cmd: 'volume'; step: 1 | -1 }
export const parseRemote = (line: string): Remote | undefined => {
  let r: unknown
  try {
    r = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof r !== 'object' || r === null) return undefined
  const o = r as Record<string, unknown>
  if (o.cmd === 'talk' || o.cmd === 'mute' || o.cmd === 'events' || o.cmd === 'visits') return { cmd: o.cmd }
  if ((o.cmd === 'ask' || o.cmd === 'answer' || o.cmd === 'chat') && typeof o.text === 'string') return { cmd: o.cmd, text: o.text }
  if (o.cmd === 'avatar' && typeof o.id === 'string') return { cmd: 'avatar', id: o.id }
  if (o.cmd === 'volume' && (o.step === 1 || o.step === -1)) return { cmd: 'volume', step: o.step }
  return undefined
}

// How often, in frames, the clock looks for the relay's spool, mirrors, and
// reads the page.
export const CHECK_FRAMES = 30
export const MIRROR_FRAMES = 3
export const DRAIN_FRAMES = 8

// The relay belongs to the session that ran /avatar remote on, named in its
// spool's `owner`: every other session keeps its voice and face on this machine.
// A relay that died without cleaning up (killed, crashed at start) leaves its
// spool behind: the owner holds it only while the process in relay.pid lives.
const ownsRelay = `[ "$(cat "${RELAY_SPOOL}/owner" 2>/dev/null)" = "$2" ] && kill -0 "$(cat "${RELAY_SPOOL}/relay.pid" 2>/dev/null)" 2>/dev/null`
const owned = (name: string, script: string, session: string): string[] => ['sh', '-c', script, name, '', session]
// Prints `up` while this session holds a live relay.
export const heldArgv = (session: string): string[] => owned('avatar7-relay', `${ownsRelay} && echo up`, session)
// Prints `up` while a relay process lives, whoever holds it.
export const aliveArgv = (): string[] => ['sh', '-c', `p="${RELAY_SPOOL}/relay.pid"; [ -f "$p" ] && kill -0 "$(cat "$p")" 2>/dev/null && echo up`]
// No service runs the relay: started from the plugin, detached so a reload
// does not kill it, on a clean spool.
export const startArgv = (root: string): string[] => [
  'bash',
  '-c',
  `rm -rf "${RELAY_SPOOL}"; setsid python3 "$0/tools/relay.py" </dev/null >/dev/null 2>&1 &`,
  root,
]
// Take the relay (when it runs), or give it back (when this session has it).
export const takeArgv = (session: string): string[] =>
  owned('avatar7-take', `[ -d "${RELAY_SPOOL}" ] && printf %s "$2" > "${RELAY_SPOOL}/owner"`, session)
// Given back, the page hears that nobody holds the relay rather than keeping
// the last face it saw.
export const releaseArgv = (session: string): string[] =>
  owned(
    'avatar7-release',
    `${ownsRelay} && rm -f "${RELAY_SPOOL}/owner" && printf '{}' > "${RELAY_SPOOL}/state.part" && mv "${RELAY_SPOOL}/state.part" "${RELAY_SPOOL}/state.json"; true`,
    session,
  )
export const mirrorArgv = (session: string): string[] =>
  owned('avatar7-mirror', `d="${RELAY_SPOOL}"; ${ownsRelay} && cat > "$d/state.part" && mv "$d/state.part" "$d/state.json"`, session)
// The page's buttons, queued by the relay as one JSON file each under cmd/:
// read in order and removed, one per line.
export const drainArgv = (): string[] => [
  'sh',
  '-c',
  `for f in "${RELAY_SPOOL}"/cmd/*.json; do [ -f "$f" ] && cat "$f" && echo && rm -f "$f"; done; true`,
]

// A line's WAV: to the spool when this session holds the relay (Opus for the
// trip, renamed in place so never served half written), otherwise played on
// the host by `local`, a shell command reading the WAV as $1. The WAV goes
// either way.
export const playArgv = (wav: string, session: string, local: string): string[] => [
  'bash',
  '-c',
  `d="${RELAY_SPOOL}"; if ${ownsRelay}; then n="$d/$(date +%s%N)"; ` +
    // A 16 s line: 732 KB of WAV, 67 KB of Opus, 0.3 s to encode.
    `if ffmpeg -loglevel error -nostdin -i "$1" -c:a libopus -b:a 32k -f ogg "$n.part"; then mv "$n.part" "$n.ogg"; ` +
    `else cp "$1" "$n.part" && mv "$n.part" "$n.wav"; fi; ` +
    `else ${local}; fi; rm -f "$1"`,
  'avatar7-play',
  wav,
  session,
]

// The relay as one session sees it. `session` is this session's id, '' for a
// background session, which never holds the relay.
export type Relay = {
  session: string
  isHeld: boolean
  // /avatar remote on: held whatever the next prompt's origin, until off.
  isForced: boolean
  // A session typed into over ssh: its user is elsewhere, like Remote Control's.
  isSsh: boolean
  isMirroring: boolean
  isDraining: boolean
  mirrored: string
}
export const newRelay = (): Relay => ({ session: '', isHeld: false, isForced: false, isSsh: false, isMirroring: false, isDraining: false, mirrored: '' })

// What the relay asks of avatar7: the face to show (undefined while there is
// none), and what to do with a press from the page.
export type RelayHost = {
  face: () => Promise<Mirror> | undefined
  press: (r: Remote) => Promise<void>
}

// Where a prompt sends the voice: away through the relay for one sent by
// Remote Control or typed over ssh, back here for one typed at this terminal
// (unless held by force).
export const follows = (r: Relay, origin: string): 'take' | 'give' | 'stay' =>
  r.session === '' ? 'stay' : origin === 'bridge' || (origin === 'composer' && r.isSsh) ? 'take' : origin === 'composer' && !r.isForced ? 'give' : 'stay'

// A session that ends gives the relay back: an owner gone for good would hold
// the page on its last face, and keep the others' voices off it. A /clear goes
// on in this process: a relay held by force stays held, and the next check
// hands it to the new session id.
export const givesOnEnd = (r: Relay, reason: string): boolean => r.session !== '' && !(reason === 'clear' && r.isForced)
