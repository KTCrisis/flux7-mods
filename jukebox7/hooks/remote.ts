// jukebox7's remote branch: pure strings, run for real by
// tools/test_remote_shell.ts (the plugin tests mock every process).
//
// While avatar7's relay is held (the voice is on the phone), the music goes
// there too: the song is written for the relay (music.json), the phone streams
// it through the relay, and this process waits for the phone to say it ended
// (or skipped it): then it ends, and the poll moves on as when VLC ends a song.
// Given back meanwhile, it ends too, and the next song plays here. Its exit
// clears music.json unless a newer song took it already. No single quote: it
// runs inside one.
export const RELAY = '"\${XDG_CACHE_HOME:-$HOME/.cache}/avatar7/relay"'
export const REMOTE =
  `R=${RELAY}; if [ -f "$R/owner" ]; then rm -f "$R/ended-$1"; ` +
  `printf "{\\"id\\": \\"%s\\", \\"paused\\": false}" "$1" > "$R/music.part" && mv "$R/music.part" "$R/music.json"; ` +
  `trap "grep -q $1 $R/music.json 2>/dev/null && printf {} > $R/music.part && mv $R/music.part $R/music.json" EXIT; trap exit TERM; ` +
  `while [ ! -f "$R/ended-$1" ] && [ -f "$R/owner" ]; do sleep 1; done; rm -f "$R/ended-$1"; exit; fi; `

// Prints `up` while a session holds the relay: the poll watches it change,
// so a song already playing here moves to the phone when the voice does.
export const heldArgv = (): string[] => ['sh', '-c', `R=${RELAY}; [ -f "$R/owner" ] && echo up; true`, 'jukebox7-held']

// Pause on the phone flips the flag of the song music.json holds; otherwise
// the arguments after the script (VLC's curl) run as they are.
export const pauseScript = (isPaused: boolean): string =>
  `R=${RELAY}; if [ -f "$R/owner" ] && grep -q '"id"' "$R/music.json" 2>/dev/null; then ` +
  `sed 's/"paused": [a-z]*/"paused": ${isPaused}/' "$R/music.json" > "$R/music.part" && mv "$R/music.part" "$R/music.json"; else exec "$@"; fi`

// The phone's presses for the jukebox, queued by the relay one JSON file each
// under jukebox/: read and removed in one go, a line each.
export const drainArgv = (): string[] => [
  'sh',
  '-c',
  `R=${RELAY}; for f in "$R"/jukebox/*.json; do [ -f "$f" ] && cat "$f" && echo && rm -f "$f"; done; true`,
]

// What the jukebox shows the phone (title, playing, genre, the genres), from
// stdin, while a session holds the relay.
export const statusArgv = (): string[] => [
  'sh',
  '-c',
  `R=${RELAY}; [ -f "$R/owner" ] && cat > "$R/jukebox.part" && mv "$R/jukebox.part" "$R/jukebox.json"; true`,
]

export type JukeboxPress =
  | { do: 'pause' | 'next' | 'similar' | 'stop' }
  | { do: 'genre'; genre: string }
  | { do: 'find'; query: string }
  | { do: 'pick'; index: number }

// A search asked from the phone, cut as the relay cuts it.
export const QUERY_MAX = 120

// A press as the relay queued it, or undefined for anything else: a genre
// must be one of the given labels.
export const parseJukebox = (line: string, genres: string[]): JukeboxPress | undefined => {
  let r: unknown
  try {
    r = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof r !== 'object' || r === null) return undefined
  const o = r as Record<string, unknown>
  if (o.do === 'pause' || o.do === 'next' || o.do === 'similar' || o.do === 'stop') return { do: o.do }
  if (o.do === 'genre' && typeof o.genre === 'string' && genres.includes(o.genre)) return { do: 'genre', genre: o.genre }
  if (o.do === 'find' && typeof o.query === 'string' && o.query.trim() !== '') return { do: 'find', query: o.query.trim().slice(0, QUERY_MAX) }
  // Which result of the last search, from 0; checked against the list when it plays.
  if (o.do === 'pick' && typeof o.index === 'number' && Number.isInteger(o.index) && o.index >= 0) return { do: 'pick', index: o.index }
  return undefined
}
