import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Found, ModelUse, Player, Say, Track } from '../types'
import { drainArgv, heldArgv, parseJukebox, pauseScript, REMOTE, statusArgv } from './remote'

// Cheap sieve before any model call: a prompt that fails it reaches the
// session untouched, with no added latency. A command to the jukebox is
// short; a longer message is talk to the assistant, even about music (one
// about ducking the music was once taken for a volume change). Common words
// (son, fort, mets, lance) only count inside a music phrase; a prompt that
// opens on joue or play names what to play.
const MAX_WORDS = 8
const MUSIC =
  /\b(musique|music|morceau|chanson|playlist|youtube|ambient|lofi|radio|volume|pause|stop|coupe|arr[eê]te|reprends|resume|suivant|next|skip|louder|quieter|similar|similaire|pareil)\b|\b(monte|baisse|coupe)[sz]?\s+(le\s+)?son\b|\b(plus|moins)\s+fort\b|\b(joue|jouer|mets|lance|play)\b.*\b(du|des|de\s+la|un\s+peu\s+de|some)\b|^\s*(joue|play)\b/i
export const isCandidate = (text: string): boolean => text.trim().split(/\s+/).length <= MAX_WORDS && MUSIC.test(text)

const INTENT = [
  'You read one message typed to a coding assistant and decide whether it asks to control music playback on the computer.',
  'Answer with one line of JSON and nothing else, one of:',
  '{"action":"play","query":"...","long":true}',
  '{"action":"toggle"}',
  '{"action":"next"}',
  '{"action":"similar"}',
  '{"action":"stop"}',
  '{"action":"volume","delta":10}',
  '{"action":"none"}',
  'play: the user wants music played now. query: YouTube search words, in English for a genre or mood, as given for a named artist or title.',
  'long: true for background or mood music (ambient, lofi, focus, a genre), false for one named track.',
  'toggle: pause or resume the music. next: skip to another one. similar: more songs like the one playing. stop: stop, cut or turn off the music.',
  'volume: louder (delta 10, or 20 for much louder) or quieter (delta -10, or -20).',
  'Only a direct, short command to the music player counts. A question, a remark, a request to change software or code, or a description of how music should behave is none, even when it names volume or music.',
  'none: anything else, including talk about music, code that plays audio, and requests aimed at Renoise, play7, keys7, a piano, a pattern or a melody.',
].join('\n')

type Intent =
  | { action: 'play'; query: string; long: boolean }
  | { action: 'toggle' }
  | { action: 'next' }
  | { action: 'similar' }
  | { action: 'stop' }
  | { action: 'volume'; delta: number }
  | { action: 'none' }

// A song lasts two to twenty minutes; above is an album or a mix. A mood
// asked in words prefers five minutes and more.
const MIN_SECONDS = 120
const LONG_SECONDS = 300
const MAX_SECONDS = 1200
const SEARCH_SIZE = 8
const PANE = 'jukebox7'
const POLL_MS = 5_000
// The phone's presses are read this often.
const REMOTE_MS = 1_000

// One click, a radio: a random artist of the genre, a random song of theirs;
// next and the end of the song roll again. Seeded from the author's own listening.
export const GENRES: { key: string; label: string; artists: string[]; discover?: string[] }[] = [
  {
    key: '1',
    label: 'ambient',
    artists: ['Boards of Canada', 'Loscil', 'Helios', 'Múm', 'Kenji Kawai Ghost in the Shell', 'Rafael Anton Irisarri', 'Ulver Perdition City', 'Brian Eno', 'bxnwxghxrn'], discover: ['Grouper', 'Tim Hecker', 'William Basinski', 'Stars of the Lid', 'Hiroshi Yoshimura', 'Chihei Hatakeyama', 'Biosphere', 'Huerco S.'],
  },
  { key: '2', label: 'alt 90s', artists: ['Radiohead', 'The Clash', 'Pulp', 'Smashing Pumpkins', 'Pixies Doolittle', 'Pavement', 'Supergrass', 'Tool', 'Nine Inch Nails', 'Rage Against the Machine', 'My Bloody Valentine', 'Queens of the Stone Age', 'Slint', 'Beck'], discover: ['Unwound', 'Polvo', 'Archers of Loaf', 'Sebadoh', 'Hum', 'Failure', 'Swirlies', 'Dinosaur Jr'] },
  {
    key: '3',
    label: 'metal',
    artists: ['Dissection', 'Cradle of Filth Dusk and Her Embrace', 'Emperor', 'Dimmu Borgir Enthrone Darkness Triumphant', 'Agalloch', 'Ulver Bergtatt', 'Arcturus', 'Blut Aus Nord', 'Wolves in the Throne Room', 'Opeth', 'Gojira', 'Children of Bodom', 'In Flames', 'Therion', 'Diabolical Masquerade', 'Anorexia Nervosa', 'Summoning', 'CLANN', 'Drabikowski Batushka', 'Limbonic Art', 'Obtained Enslavement', 'Peste Noire'], discover: ['Deathspell Omega', 'Mgła', 'Panopticon', 'Alcest', 'Oranssi Pazuzu', 'Wiegedood', 'Cult of Luna', 'Russian Circles', 'Igorrr', 'Sumac'],
  },
  { key: '4', label: 'synth & electro', artists: ['Fixions', 'Mega Drive', 'Danger 11h30', 'Perturbator', 'Carpenter Brut', 'Dan Terminus', 'Gost', 'Dance With the Dead', 'Master Boot Record', 'Crystal Castles', 'The Knife Silent Shout', 'Grimes Visions', 'Justice', 'Röyksopp', 'Atari Teenage Riot', 'Waveshaper', 'RWD', 'Lorn Ask the Dust'], discover: ['Volkor X', 'Daniel Deluxe', 'Magic Sword', 'Irving Force', 'Hollywood Burns', 'Lueur Verte', 'Gunship', 'Lazerhawk'] },
  { key: '5', label: 'idm', artists: ['Aphex Twin', 'Plaid', 'Boards of Canada', 'Squarepusher', 'Venetian Snares', 'Autechre', 'Clark', 'Wisp The Shimmering Hour', 'Arovane', 'Kettel', 'Jega', 'Bogdan Raczynski', 'Ceephax Acid Crew', 'The Future Sound of London', 'Tujiko Noriko', 'Plone', 'Ochre', 'The Tuss', 'Daed', 'EOD', 'Acrnym', 'Koolmorf Widesen', 'exandroid', 'James Shinra', 'Stazma', 'µ-Ziq'], discover: ['Richard Devine', 'Proem', 'Lusine', 'Funckarma', 'Sewerslvt', 'Machine Girl', 'Rival Consoles', 'Max Cooper'] },
  {
    key: '6',
    label: 'indie rock',
    artists: ['Pixies', 'Modest Mouse', 'Blonde Redhead', 'Eels', 'Sparklehorse', 'Elliott Smith', 'Grandaddy', 'Built to Spill', 'The Unicorns', 'Sufjan Stevens', 'MGMT', 'Ratatat', 'Perfume Genius', 'The Notwist', 'Beach House', 'Weezer', 'Les Savy Fav', 'Wolf Parade', 'The Shins', 'Animal Collective', 'Arcade Fire', 'Joanna Newsom', 'Broadcast', 'Syd Matters', 'The Walkmen', 'The Strokes', 'Metric', 'The Flaming Lips', 'Clues', 'Jason Lytle', 'Ugly Casanova', 'CocoRosie', 'Soap&Skin', 'Xiu Xiu', 'Lykke Li'], discover: ['Car Seat Headrest', 'Alex G', 'Duster Stratosphere', 'Pinegrove', 'Big Thief', 'Low Sparhawk slowcore', 'Sun Kil Moon', 'Unknown Mortal Orchestra'],
  },
  {
    key: '7',
    label: 'video games',
    artists: [
      'NieR Automata soundtrack Keiichi Okabe', 'Jeremy Soule Skyrim', 'Jeremy Soule Morrowind', 'Jeremy Soule Oblivion',
      'Akira Yamaoka Silent Hill', 'Deus Ex soundtrack', 'Christopher Larkin Hollow Knight', 'C418 Minecraft', 'Cyberpunk 2077 soundtrack',
      'Darren Korb Bastion', 'Darren Korb Transistor', 'Lena Raine Celeste', 'Mark Morgan Fallout', 'Mark Morgan Planescape Torment',
      'FlybyNo Endless Space', 'FlybyNo Endless Legend', 'Arnaud Roy Humankind', 'Andrew Prahlow Outer Wilds', 'Furi soundtrack',
    ], discover: ['Disasterpeace Fez', 'Darren Korb Hades', 'Austin Wintory Journey', 'Ben Prunty FTL', 'Toby Fox Undertale', 'Mick Gordon Doom', 'Hideki Naganuma'],
  },
  {
    key: '8',
    label: 'film & modern classical',
    artists: ['Joe Hisaishi', 'Philip Glass', 'Max Richter', 'Kenji Kawai Ghost in the Shell', 'Ryuichi Sakamoto', 'Jóhann Jóhannsson', 'Hans Zimmer The Thin Red Line', 'Clint Mansell The Fountain', 'Trevor Jones The Last of the Mohicans', 'Elliot Goldenthal Heat', 'Thomas Newman American Beauty', 'John Williams', 'Antonín Dvořák New World Symphony'],
    discover: ['Ólafur Arnalds', 'Nils Frahm', 'Arvo Pärt', 'Hildur Guðnadóttir', 'Steve Reich', 'Michael Nyman', 'Hania Rani', 'A Winged Victory for the Sullen'],
  },
  {
    key: '9',
    label: 'hip-hop & abstract',
    artists: ['Wu-Tang Clan', 'Jedi Mind Tricks', 'Kanye West', 'cLOUDDEAD', 'Sage Francis', 'Danger Mouse', 'Why?', 'Nujabes', 'Prefuse 73', 'DJ Shadow', 'Bonobo', 'Themselves', 'Odd Nosdam', 'Alias Anticon', 'Sole Anticon', 'Son Lux', 'Beastie Boys', 'Cypress Hill', 'Stupeflip', 'Wax Tailor', 'Outkast', 'Eminem', 'Dr. Dre', 'Passage Anticon', 'Death Grips'],
    discover: ['MF DOOM', 'Cannibal Ox', 'Aesop Rock', 'Company Flow', 'Armand Hammer', 'billy woods', 'clipping.', 'Deltron 3030', 'Madlib', 'J Dilla', 'Flying Lotus', 'Knxwledge'],
  },
  {
    key: '0',
    label: 'post-rock',
    artists: ['Godspeed You! Black Emperor', 'Explosions in the Sky', 'Mono', 'Isis', 'Red Sparowes', 'Mogwai', 'Anathema', 'Sigur Rós', 'This Will Destroy You', 'The Mars Volta'],
    discover: ['Caspian', 'If These Trees Could Talk', 'Pelican', 'Do Make Say Think', 'Tortoise', 'Hammock', 'Lost in Kiev', 'God Is an Astronaut'],
  },
]

// A genre's artists, or else the station of the avatar on duty, which
// avatar7 publishes from the persona's own persona.json.
async function poolOf($: Engine, label: string): Promise<{ name: string; artists: string[] }> {
  const genre = GENRES.find(g => g.label === label)
  if (genre !== undefined) return { name: label, artists: genre.artists }
  const { value } = await $.state.get(onStation)
  return { name: value?.name || label, artists: value?.artists ?? [] }
}
// Artists picked for a genre beyond the listener's own: one pick in three
// comes from there, and its title wears a ✦.
const discoveries = (label: string): string[] => GENRES.find(g => g.label === label)?.discover ?? []
const DISCOVER_ODDS = 1 / 3
export const DISCOVERED = '✦ '
const onDuty = { plugin: 'avatar7', key: 'avatar' } as const
const tint = { plugin: 'avatar7', key: 'color' } as const
const onStation = { plugin: 'avatar7', key: 'station' } as const
// Without an avatar on duty the pane keeps the terminal's phosphor green.
const PHOSPHOR = '#00ff9c'
const BLACK = '#000000'
const BAR = 12

const anyOf = <T,>(xs: T[]): T | undefined => xs[Math.floor(Math.random() * xs.length)]
export const isSong = (t: Track): boolean => t.seconds !== null && t.seconds >= MIN_SECONDS && t.seconds <= MAX_SECONDS

const IDLE: Player = { tracks: [], index: 0, pgid: null, isPlaying: false, genre: null, startedAt: null, pausedAt: null }
const player = atom({ plugin: 'jukebox7', key: 'player' } as const, IDLE)
// The last search asked for a pick (/music find, or the phone): what was
// asked and what YouTube found, in its order. Nothing plays until a pick.
const found = atom({ plugin: 'jukebox7', key: 'found' } as const, { query: '', tracks: [] } as Found)
let isFinding = false
// The pane's search: its field and the results, shown after `f` until `f`
// again. Each result answers a letter the pane leaves free (digits are the
// stations', the rest its controls').
const searching = atom({ plugin: 'jukebox7', key: 'searching' } as const, false)
export const PICK_KEYS = ['q', 'w', 'e', 't', 'y', 'i', 'o', 'l']
const PANE_ROWS = 6
// The pane grows by the search's rows (the field, a result each, or one
// line while it searches), so the rain is not all that gives way.
const paneRows = (isSearching: boolean, results: number): number => PANE_ROWS + (isSearching ? 1 + Math.max(1, results) : 0)
// Percent of VLC's 100 %, kept apart from the player so a stop keeps it.
const volume = atom({ plugin: 'jukebox7', key: 'volume' } as const, 70)
const VOLUME_STEP = 10
const VOLUME_MAX = 125
export const clampVolume = (v: number): number => Math.min(VOLUME_MAX, Math.max(0, Math.round(v)))

export const parseIntent = (text: string): Intent => {
  const json = /\{[^}]*\}/.exec(text)?.[0]
  if (json === undefined) return { action: 'none' }
  try {
    const v = JSON.parse(json) as Record<string, unknown>
    if (v.action === 'play' && typeof v.query === 'string' && v.query.trim() !== '') {
      return { action: 'play', query: v.query.trim(), long: v.long === true }
    }
    if (v.action === 'toggle' || v.action === 'next' || v.action === 'similar' || v.action === 'stop') return { action: v.action }
    if (v.action === 'volume' && typeof v.delta === 'number' && v.delta !== 0) return { action: 'volume', delta: v.delta }
  } catch {
    // Not JSON after all: the prompt goes on to the session.
  }
  return { action: 'none' }
}

// yt-dlp prints one `id<TAB>title<TAB>duration` line per result; a live
// stream has no duration (NA), which suits a backdrop.
export const parseTracks = (stdout: string): Track[] =>
  stdout
    .split('\n')
    .map(l => l.split('\t'))
    .filter(([id]) => id !== undefined && /^[\w-]{11}$/.test(id))
    .map(([id, title, d]) => ({
      id: id as string,
      title: (title ?? '').trim(),
      seconds: d === undefined || !/^\d+(\.\d+)?$/.test(d.trim()) ? null : Math.round(Number(d)),
    }))

// The playlist starts on the first fitting result; next walks on from there.
export const pickTrack = (stdout: string, long: boolean): Track | undefined => {
  const tracks = parseTracks(stdout)
  if (!long) return tracks[0]
  const songs = tracks.filter(isSong)
  return songs.find(t => (t.seconds ?? 0) >= LONG_SECONDS) ?? songs[0] ?? tracks[0]
}

const search = (query: string): string[] => [
  'yt-dlp',
  '--flat-playlist',
  '--no-warnings',
  '--print',
  '%(id)s\t%(title)s\t%(duration)s',
  `ytsearch${SEARCH_SIZE}:${query}`,
]

// A station pick searches YouTube Music's songs tab: only tracks, never an
// interview, a gameplay video or a full OST, at the cost of the durations
// (the flat listing gives none). Plain YouTube, length-filtered, is the
// fallback when it finds nothing.
export const musicSearch = (query: string): string[] => [
  'yt-dlp',
  '--flat-playlist',
  '--no-warnings',
  '--playlist-end',
  String(SEARCH_SIZE),
  '--print',
  '%(id)s\t%(title)s\t%(duration)s',
  `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`,
]

// YouTube Music's search lists no duration (NA): the one playing is asked
// for its own, so the progress bar has something to fill.
export const durationArgv = (id: string): string[] => [
  'yt-dlp',
  '--no-warnings',
  '--skip-download',
  '--print',
  '%(duration)s',
  `https://www.youtube.com/watch?v=${id}`,
]

// YouTube Music's radio from a song: its first entry is the song itself.
// The radio lingers on the same artist, so other artists come first; covers,
// tributes and hour-long loops (the drift of a niche radio) are dropped.
export const radioArgv = (id: string): string[] => [
  'yt-dlp',
  '--flat-playlist',
  '--no-warnings',
  '--playlist-end',
  '25',
  '--print',
  '%(id)s\t%(title)s\t%(duration)s\t%(channel)s',
  `https://music.youtube.com/watch?v=${id}&list=RDAMVM${id}`,
]
const COVER = /\b(cover|tribute|relaxing|reimagined|orchestral version|piano version|8.?bit|lofi version|1 hour|hours?\b|extended|epic music|fantasy music|sleep|study)\b/i
export const parseRadio = (stdout: string): Track[] => {
  const rows = stdout
    .split('\n')
    .map(l => l.split('\t'))
    .filter(([id]) => id !== undefined && /^[\w-]{11}$/.test(id))
    .map(([id, title, d, channel]) => ({
      id: id as string,
      title: (title ?? '').trim(),
      seconds: d === undefined || !/^\d+(\.\d+)?$/.test(d.trim()) ? null : Math.round(Number(d)),
      artist: (channel ?? '').replace(/ - Topic$/, '').trim(),
    }))
  const [self, ...rest] = rows
  const kept = rest.filter(r => !COVER.test(r.title) && !COVER.test(r.artist) && (r.seconds === null || isSong(r)))
  const others = kept.filter(r => r.artist !== self?.artist)
  const same = kept.filter(r => r.artist === self?.artist)
  return [...others, ...same].map(r => ({ id: r.id, title: r.artist === '' || r.artist === 'NA' ? r.title : `${r.artist} - ${r.title}`, seconds: r.seconds }))
}

// Audio only, no window: yt-dlp streams the best audio into Windows' VLC
// with its dummy interface (WSLg's PulseAudio stalls after a sleep, VLC
// plays on the Windows side and takes no focus). setsid puts the WSL side in
// a process group of its own, which stop ends (pause asks VLC itself); vlc://quit
// ends it with the stream; the id arrives as $1, checked against
// /^[\w-]{11}$/ before.
const VLC = '/mnt/c/Program Files/VideoLAN/VLC/vlc.exe'
const TAG = '--meta-title=jukebox7'
// The volume goes through VLC's HTTP interface, bound to Windows' loopback:
// curl.exe runs there, where WSL's own localhost does not reach. The
// password only satisfies VLC, which refuses the interface without one.
const HTTP_PORT = 18797
const HTTP_PASSWORD = 'jukebox7'
const HTTP = `--extraintf http --http-host 127.0.0.1 --http-port ${HTTP_PORT} --http-password ${HTTP_PASSWORD}`
const PIPE = `${REMOTE}yt-dlp -q --no-warnings -f bestaudio -o - "https://www.youtube.com/watch?v=$1" | "${VLC}" --intf dummy --dummy-quiet --play-and-exit --no-video -q ${TAG} ${HTTP} - vlc://quit`
export const startArgv = (id: string): string[] => [
  'bash',
  '-c',
  `setsid bash -c '${PIPE}' _ "$1" </dev/null >/dev/null 2>&1 & echo $!`,
  '_',
  id,
]
// Killing the WSL side leaves vlc.exe running: it goes by its tag, so a VLC
// the user opened themselves is never touched. A VLC whose WSL side died
// with its window shows no command line any more, and still holds the port
// beside the next one (Windows lets both listen, the controls reach one of
// them). Windows refuses to end that one even to its own user, but it still
// obeys its interface: pl_stop ends it (--play-and-exit), once per listener,
// each request reaching one. The port's owner goes last, where allowed.
const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const BASIC = btoa(`:${HTTP_PASSWORD}`)
export const killVlcArgv = [
  POWERSHELL,
  '-NoProfile',
  '-Command',
  `1..3 | ForEach-Object { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Headers @{ Authorization = 'Basic ${BASIC}' } 'http://127.0.0.1:${HTTP_PORT}/requests/status.xml?command=pl_stop' | Out-Null } catch {} }; ` +
    `Get-CimInstance Win32_Process -Filter "Name='vlc.exe'" | Where-Object { $_.CommandLine -like '*${TAG}*' } | Invoke-CimMethod -MethodName Terminate | Out-Null; ` +
    `Get-NetTCPConnection -LocalPort ${HTTP_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } | Where-Object Name -eq 'vlc' | Stop-Process -Force -ErrorAction SilentlyContinue`,
]
// VLC counts 256 for 100 %. A fresh VLC starts at whatever Windows kept for
// it (--mmdevice-volume is ignored), so each start sets the level again,
// retrying while the interface is not up yet.
const CURL = '/mnt/c/Windows/System32/curl.exe'
export const volumeArgv = (percent: number, retry = false): string[] => [
  CURL,
  '-s',
  '-o',
  'NUL',
  '-u',
  `:${HTTP_PASSWORD}`,
  ...(retry ? ['--retry', '10', '--retry-connrefused', '--retry-delay', '1'] : ['--max-time', '2']),
  `http://127.0.0.1:${HTTP_PORT}/requests/status.xml?command=volume&val=${Math.round((clampVolume(percent) * 256) / 100)}`,
]
// Pause and resume through the same interface: instant, where stopping the
// WSL pipeline only starved VLC after its buffer ran out, seconds later or
// not at all. force* are idempotent, so a missed click cannot invert them.
// On the phone (music.json holds a song), pause flips its flag; here, VLC's.
export const pauseArgv = (isPaused: boolean): string[] => [
  'sh',
  '-c',
  pauseScript(isPaused),
  '_',
  CURL,
  '-sf',
  '-o',
  'NUL',
  '-u',
  `:${HTTP_PASSWORD}`,
  '--max-time',
  '2',
  `http://127.0.0.1:${HTTP_PORT}/requests/status.xml?command=${isPaused ? 'pl_forcepause' : 'pl_forceresume'}`,
]

// How many rows a wrapped line of plain Buttons takes: each draws as
// `k: label`, three columns past its label, with `gap` between them.
export const buttonRows = (labels: string[], columns: number, gap = 2): number => {
  let rows = 1
  let used = 0
  for (const label of labels) {
    const w = label.length + 3
    if (used > 0 && used + gap + w > columns) {
      rows += 1
      used = w
    } else {
      used += (used > 0 ? gap : 0) + w
    }
  }
  return rows
}

// While the avatar speaks, the music drops to this share of its level.
export const DUCK = 0.7
export const duckArgv = (level: number, isVoicing: boolean): string[] => volumeArgv(isVoicing ? level * DUCK : level)
const detached = (argv: string[]): string[] => ['bash', '-c', 'setsid "$0" "$@" </dev/null >/dev/null 2>&1 &', ...argv]
export const detachedKillVlcArgv = ['bash', '-c', 'setsid "$0" "$@" </dev/null >/dev/null 2>&1 &', ...killVlcArgv]
const signal = (sig: 'STOP' | 'CONT' | 'TERM', pgid: number): string[] => ['kill', `-${sig}`, '--', `-${pgid}`]

const show = (p: Player) => {
  const t = p.tracks[p.index]
  return t === undefined ? undefined : `music${p.isPlaying ? '' : ' (paused)'}: ${t.title}`
}

async function halt($: Engine, pgid: number | null) {
  // A stopped group ignores TERM until it runs again.
  if (pgid !== null) {
    await $.process.run(signal('CONT', pgid))
    await $.process.run(signal('TERM', pgid))
  }
  await $.process.run(killVlcArgv)
}

// Fills in the duration of the track playing, if it still plays when the
// answer comes; the play never waits on it.
async function fillDuration($: Engine, id: string): Promise<void> {
  try {
    const r = await $.process.run(durationArgv(id), { timeoutMs: 20_000 })
    const [found] = parseTracks(`${id}\t\t${r.stdout.trim()}`)
    if (r.exitCode !== 0 || found?.seconds == null) return
    const seconds = found.seconds
    await update($, player, p =>
      p.tracks[p.index]?.id === id ? { ...p, tracks: p.tracks.map((t, i) => (i === p.index ? { ...t, seconds } : t)) } : p,
    )
  } catch {
    // No duration (yt-dlp failed, the session ended): the bar stays a clock.
  }
}

// What the persona on duty hears when a song starts: the title, plain, and
// the cue to introduce it in its own manner.
export const introEvent = (title: string): string =>
  `the jukebox starts "${title.replace(DISCOVERED, '')}"; introduce it in your own manner, the way a radio host would`

async function playAt($: Engine, tracks: Track[], index: number, genre: string | null = null): Promise<Track | undefined> {
  // Halted even when nothing plays from here: an orphan VLC on the port
  // would take the controls of the new one. One jukebox per machine.
  await halt($, (await read($, player)).pgid)
  const track = tracks[index]
  if (track === undefined) {
    await update($, player, () => IDLE)
    $.ui.status(undefined)
    return undefined
  }
  const started = await $.process.run(startArgv(track.id))
  const pgid = Number(started.stdout.trim())
  const p: Player = {
    tracks,
    index,
    pgid: Number.isInteger(pgid) && pgid > 1 ? pgid : null,
    isPlaying: true,
    genre,
    startedAt: await $.clock.now(),
    pausedAt: null,
  }
  await update($, player, () => p)
  // Every start goes through here: asked, from a genre, or the next one when
  // a song ends; avatar7, if loaded, speaks over the intro.
  await $.state.set({ plugin: 'jukebox7', key: 'say' }, { mood: 'watch', event: introEvent(track.title), at: Date.now() } satisfies Say)
  if (p.pgid !== null) await $.process.run(detached(volumeArgv(await read($, volume), true)))
  if (track.seconds === null) void fillDuration($, track.id)
  $.ui.status(show(p))
  void $.ui.open({ id: PANE, title: 'jukebox7', rows: 6 })
  return track
}

// One change of song at a time: a search takes up to 40 s, and the poll, a
// button and a command would each start their own song meanwhile.
let isMoving = false
async function once($: Engine, change: () => Promise<Track | undefined>): Promise<Track | undefined> {
  if (isMoving) {
    $.ui.toast('music: a song is already on its way')
    return undefined
  }
  isMoving = true
  try {
    return await change()
  } finally {
    isMoving = false
  }
}

// Past the last result the list ends (playAt goes idle): no wrapping back to
// the first, which would loop for ever over tracks that cannot play.
async function skip($: Engine, by: number): Promise<Track | undefined> {
  const p = await read($, player)
  if (typeof p.genre === 'string') return playGenre($, p.genre)
  return playAt($, p.tracks, p.index + by)
}

async function toggle($: Engine): Promise<Player | undefined> {
  const p = await read($, player)
  if (p.pgid === null) return p
  // VLC not listening (still starting, gone): the state stays as it is, so
  // the poll keeps watching a song that still plays.
  const sent = await $.process.run(pauseArgv(p.isPlaying))
  if (sent.exitCode !== 0) {
    $.ui.toast('music: VLC did not answer, try again')
    return undefined
  }
  const now = await $.clock.now()
  const q: Player = p.isPlaying
    ? { ...p, isPlaying: false, pausedAt: now }
    : { ...p, isPlaying: true, pausedAt: null, startedAt: (p.startedAt ?? now) + (now - (p.pausedAt ?? now)) }
  await update($, player, () => q)
  // A voice that started or ended while paused: the level follows it again.
  if (q.isPlaying) await $.process.run(detached(duckArgv(await read($, volume), await isAvatarVoicing($))))
  $.ui.status(show(q))
  return q
}

async function isAvatarVoicing($: Engine): Promise<boolean> {
  return (await $.state.get({ plugin: 'avatar7', key: 'isVoicing' })).value === true
}

async function louder($: Engine, delta: number): Promise<number> {
  const v = clampVolume((await read($, volume)) + delta)
  await update($, volume, () => v)
  if ((await read($, player)).pgid !== null) await $.process.run(duckArgv(v, await isAvatarVoicing($)))
  return v
}

async function stop($: Engine) {
  const p = await read($, player)
  await halt($, p.pgid)
  await update($, player, () => IDLE)
  $.ui.status(undefined)
  await $.ui.close({ id: PANE })
}

async function play($: Engine, query: string, long: boolean): Promise<Track | undefined> {
  const found = await $.process.run(search(query), { timeoutMs: 20_000 })
  if (found.exitCode !== 0) return undefined
  const first = pickTrack(found.stdout, long)
  if (first === undefined) return undefined
  // The track asked for plays whatever its length; next walks songs only
  // (no hour-long mix, no live stream that never ends).
  const rest = parseTracks(found.stdout).filter(t => t.id !== first.id && isSong(t))
  return playAt($, [first, ...rest], 0)
}

// Lists what YouTube finds for a search, and keeps it for a pick; undefined
// when yt-dlp failed. One search at a time.
async function find($: Engine, query: string): Promise<Track[] | undefined> {
  isFinding = true
  try {
    const r = await $.process.run(search(query), { timeoutMs: 20_000 })
    if (r.exitCode !== 0) return undefined
    const tracks = parseTracks(r.stdout)
    await update($, found, () => ({ query, tracks }))
    return tracks
  } finally {
    isFinding = false
  }
}

// The result at `index` (from 0) plays whatever its length; next walks on
// through the rest of the search, as after /music <search>.
async function pick($: Engine, index: number): Promise<Track | undefined> {
  const f = await read($, found)
  if (f.tracks[index] === undefined) return undefined
  return playAt($, f.tracks, index)
}

// The results as /music find prints them: numbered from 1, with a length
// when YouTube gave one.
export const listing = (tracks: Track[]): string =>
  tracks.map((t, i) => `${i + 1}. ${t.title}${t.seconds === null ? '' : ` (${clock(t.seconds)})`}`).join('\n')

async function playGenre($: Engine, label: string): Promise<Track | undefined> {
  const fresh = discoveries(label)
  const isNew = fresh.length > 0 && Math.random() < DISCOVER_ODDS
  const pool = await poolOf($, label)
  const artist = anyOf(isNew ? fresh : pool.artists)
  if (artist === undefined) return undefined
  $.ui.status(`music: looking for ${pool.name}, ${artist}…`)
  const was = (await read($, player)).tracks
  const music = await $.process.run(musicSearch(artist), { timeoutMs: 20_000 })
  let songs = music.exitCode === 0 ? parseTracks(music.stdout).filter(t => t.seconds === null || isSong(t)) : []
  // Its titles carry no artist; the query names it.
  songs = songs.map(t => ({ ...t, title: `${isNew ? DISCOVERED : ''}${artist} - ${t.title}` }))
  if (songs.length === 0) {
    const found = await $.process.run(search(artist), { timeoutMs: 20_000 })
    songs = found.exitCode === 0 ? parseTracks(found.stdout).filter(isSong) : []
    if (isNew) songs = songs.map(t => ({ ...t, title: `${DISCOVERED}${t.title}` }))
  }
  const unheard = songs.filter(t => !was.some(w => w.id === t.id))
  const track = anyOf(unheard.length > 0 ? unheard : songs)
  if (track === undefined) {
    $.ui.status(undefined)
    $.ui.toast(`music: nothing found for ${artist}`)
    await $.state.set({ plugin: 'jukebox7', key: 'say' }, { mood: 'error', event: `the jukebox found nothing to play for ${artist}`, at: Date.now() } satisfies Say)
    return undefined
  }
  $.ui.toast(`music now playing: ${track.title}`)
  return playAt($, [track], 0, label)
}

// More like the song playing: its YouTube Music radio, as a list next walks.
async function playSimilar($: Engine): Promise<Track | undefined> {
  const p = await read($, player)
  const now = p.tracks[p.index]
  if (now === undefined) return undefined
  $.ui.status(`music: looking for songs like ${now.title}…`)
  const found = await $.process.run(radioArgv(now.id), { timeoutMs: 20_000 })
  const tracks = found.exitCode === 0 ? parseRadio(found.stdout) : []
  if (tracks.length === 0) {
    $.ui.status(show(p))
    $.ui.toast('music: no radio for this one')
    return undefined
  }
  $.ui.toast(`music, like ${now.title}: ${tracks[0]?.title}`)
  return playAt($, tracks, 0, null)
}

const clock = (s: number): string => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

// `▰▰▰▱▱▱ 03:12 / 07:00`, or the elapsed time alone when YouTube gave no length.
export const progress = (p: Player, now: number, seconds: number | null): { done: string; left: string; time: string } => {
  const elapsed = p.startedAt === null ? 0 : Math.max(0, ((p.pausedAt ?? now) - p.startedAt) / 1000)
  if (seconds === null || seconds <= 0) return { done: '', left: '', time: clock(elapsed) }
  const filled = Math.min(BAR, Math.round((elapsed / seconds) * BAR))
  return { done: '▰'.repeat(filled), left: '▱'.repeat(BAR - filled), time: `${clock(Math.min(elapsed, seconds))} / ${clock(seconds)}` }
}

// Ghost in the Shell's green code rain under the player: half-width katakana
// and digits falling per column, moving only while a song plays.
const GLYPHS = 'ｦｧｨｩｪｫｬｭｮｯｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789'
const TRAIL = 6
const RAIN_MS = 200
let frame = 0
const hash = (n: number): number => {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

// One row is a list of runs: 0 blank, 1 trail (dim), 2 head (bright).
export const rain = (columns: number, rows: number, tick: number): { level: 0 | 1 | 2; text: string }[][] =>
  Array.from({ length: rows }, (_, r) => {
    const runs: { level: 0 | 1 | 2; text: string }[] = []
    for (let c = 0; c < columns; c++) {
      const span = rows + TRAIL + (hash(c * 7 + 1) % rows || 1)
      const speed = 1 + (hash(c * 13 + 5) % 2)
      const head = (Math.floor((tick * speed) / 2) + hash(c * 29 + 3)) % span
      const behind = head - r
      const level: 0 | 1 | 2 = c % 2 === 1 || behind < 0 || behind > TRAIL ? 0 : behind === 0 ? 2 : 1
      const ch = level === 0 ? ' ' : (GLYPHS[hash(c * 131 + r * 17 + Math.floor(tick / 3)) % GLYPHS.length] ?? ' ')
      const last = runs[runs.length - 1]
      if (last !== undefined && last.level === level) last.text += ch
      else runs.push({ level, text: ch })
    }
    return runs
  })

export const register: Register = on => {
  // A daemon's background session (a spare kept warm, a `claude --bg`)
  // inherits the plugin dirs but nobody listens to it: no /music, no poll,
  // no prompt turned into a song.
  let isBackground = false

  // avatar7 speaking: the music steps back, then returns to its level. The
  // curl is detached, so the voice never waits on VLC.
  on('state.set', { plugin: 'avatar7', key: 'isVoicing' }, async ($, e, next) => {
    const done = await next(e)
    const p = await read($, player)
    if (p.pgid !== null && p.isPlaying) await $.process.run(detached(duckArgv(await read($, volume), e.value === true)))
    return done
  })

  on('session.start', async ($, e, next) => {
    const kind = await $.process.run(['sh', '-c', 'printf %s "$CLAUDE_CODE_SESSION_KIND"'])
    isBackground = kind.stdout === 'bg'
    if (isBackground) return next(e)

    await $.command.register({
      name: 'music',
      description: 'Play music from YouTube: /music <search>, /music find <search> then /music pick <n>, /music pause, /music next, /music similar, /music stop, /music vol [+|-]<n>, /music alone for what plays',
    })

    // A pipeline that ended by itself (the track is over) moves on to the
    // next result; one that cannot be found any more is forgotten.
    $.clock.every(POLL_MS, () => {
      void (async () => {
        const p = await read($, player)
        if (p.pgid === null || !p.isPlaying || isMoving) return
        const alive = await $.process.run(['kill', '-0', '--', `-${p.pgid}`])
        if (alive.exitCode === 0) {
          $.ui.invalidate('ui.render')
          return
        }
        // Nothing to follow (the list ended, no network, no station): the
        // jukebox goes idle rather than retry every tick.
        if ((await once($, () => skip($, 1))) === undefined) {
          await update($, player, () => IDLE)
          $.ui.status(undefined)
        }
      })()
    })

    // The phone, through avatar7's relay: its presses for the jukebox, and
    // what the jukebox shows it, written again only when it changed.
    let shown = ''
    // Where the voice was at the last tick: undefined until first seen.
    let wasHeld: boolean | undefined
    $.clock.every(REMOTE_MS, () => {
      void (async () => {
        // The relay just taken: a song playing here starts again from its
        // beginning, and its start takes the remote branch (no seek through
        // the relay yet). Given back, the phone's song ends by itself and the
        // next one plays here.
        const isHeld = (await $.process.run(heldArgv())).stdout.trim() === 'up'
        const was = wasHeld
        wasHeld = isHeld
        if (isHeld && was === false && !isMoving) {
          const p = await read($, player)
          if (p.pgid !== null && p.isPlaying) await once($, () => playAt($, p.tracks, p.index, p.genre))
        }
        const out = (await $.process.run(drainArgv())).stdout
        for (const line of out.split('\n')) {
          const press = parseJukebox(line, GENRES.map(g => g.label))
          if (press === undefined) continue
          if (press.do === 'pause') await toggle($)
          else if (press.do === 'stop') await stop($)
          else if (press.do === 'next') await once($, () => skip($, 1))
          else if (press.do === 'similar') await once($, () => playSimilar($))
          else if (press.do === 'find') {
            if (!isFinding) await find($, press.query)
          } else if (press.do === 'pick') await once($, () => pick($, press.index))
          else await once($, () => playGenre($, press.genre))
          $.ui.invalidate('ui.render')
        }
        const p = await read($, player)
        const now = p.pgid === null ? undefined : p.tracks[p.index]
        const f = await read($, found)
        const status = JSON.stringify({
          title: now?.title ?? '', isPlaying: now !== undefined && p.isPlaying, genre: p.genre ?? '',
          genres: GENRES.map(g => g.label), isMoving,
          // The last search, for the phone to list and pick from.
          query: f.query, found: f.tracks.map(t => ({ title: t.title, seconds: t.seconds })), isFinding,
        })
        if (status !== shown) {
          await $.process.run(statusArgv(), { stdin: status })
          shown = status
        }
      })()
    })

    $.clock.every(RAIN_MS, () => {
      void (async () => {
        if (!(await read($, player)).isPlaying) return
        frame += 1
        $.ui.invalidate('ui.render')
      })()
    })

    // Unasked, the pane seats from 144 columns, under the avatar's; /music
    // opens it at any width.
    void $.ui.open({ id: PANE, title: 'jukebox7', rows: 6 })

    return next(e)
  })

  // Quitting (or /clear, which loses $.state's pgid) must not orphan the
  // detached pipeline. The end chain runs under one short bound and
  // PowerShell starts slower than that: the group goes at once, the VLC
  // kill is detached so it outlives the exit.
  // A session that never played (another window, a background spare) leaves
  // the VLC alone: it may be another session's song.
  on('session.end', async ($, e, next) => {
    const p = await read($, player)
    if (p.pgid !== null) {
      await $.process.run(signal('CONT', p.pgid))
      await $.process.run(signal('TERM', p.pgid))
      await $.process.run(detachedKillVlcArgv)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (isBackground || (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') || !isCandidate(e.text)) return next(e)

    const r = await $.model.complete({
      model: 'haiku',
      system: INTENT,
      prompt: e.text.slice(0, 500),
      maxTokens: 60,
      effort: 'low',
      timeoutMs: 8_000,
    })
    if (r.usage !== undefined) {
      await $.state.set({ plugin: 'jukebox7', key: 'modelUse' }, {
        model: 'haiku', input: r.usage.input_tokens, output: r.usage.output_tokens, cacheRead: r.usage.cache_read_input_tokens ?? 0, at: Date.now(),
      } satisfies ModelUse)
    }
    const intent = r.isAnswered ? parseIntent(r.text) : ({ action: 'none' } as const)

    if (intent.action === 'none') return next(e)
    // A song already on its way: no second search, and no false "nothing found".
    const changes = intent.action === 'play' || intent.action === 'next' || intent.action === 'similar'
    if (changes && isMoving) return { drop: 'jukebox7: a song is already on its way' }

    if (intent.action !== 'play') {
      // Nothing plays: a bare stop, pause or next was meant for the assistant.
      if ((await read($, player)).pgid === null) return next(e)
      if (intent.action === 'stop') {
        await stop($)
        $.ui.toast('music stopped')
        return { drop: 'jukebox7: stopped' }
      }
      if (intent.action === 'volume') {
        const v = await louder($, intent.delta)
        $.ui.toast(`music volume ${v}%`)
        return { drop: `jukebox7: volume ${v}%` }
      }
      if (intent.action === 'similar') {
        const t = await once($, () => playSimilar($))
        return { drop: `jukebox7: ${t === undefined ? 'no radio for this one' : `like it, ${t.title}`}` }
      }
      if (intent.action === 'next') {
        const t = await once($, () => skip($, 1))
        $.ui.toast(t === undefined ? 'music: end of the list' : `music now playing: ${t.title}`)
        return { drop: `jukebox7: ${t === undefined ? 'end of the list' : `next, ${t.title}`}` }
      }
      const q = await toggle($)
      if (q === undefined) return { drop: 'jukebox7: VLC did not answer' }
      const said = q.isPlaying ? `resumed: ${q.tracks[q.index]?.title ?? ''}` : 'paused'
      $.ui.toast(`music ${said}`)
      return { drop: `jukebox7: ${said}` }
    }

    const track = await once($, () => play($, intent.query, intent.long))
    if (track === undefined) return { drop: `jukebox7: nothing found on YouTube for "${intent.query}".` }
    $.ui.toast(`music now playing: ${track.title}`)
    return { drop: `jukebox7: playing "${track.title}" (https://youtu.be/${track.id})` }
  })

  on('command.run', { command: 'music' }, async ($, e) => {
    const args = e.args.trim()
    const isControl = args === '' || args === 'pause' || args === 'stop' || /^vol(?:ume)?\b/.test(args) || /^find\b/.test(args)
    if (!isControl && isMoving) return { text: 'A song is already on its way.' }
    const p = await read($, player)
    const now = p.tracks[p.index]
    if (args === '') {
      void $.ui.open({ id: PANE, title: 'jukebox7', rows: 6 })
      if (p.pgid === null || now === undefined) return { text: 'Nothing played from here yet: pick a genre in the pane.' }
      return { text: `${p.isPlaying ? 'Playing' : 'Paused'}: ${now.title}` }
    }

    const vol = /^vol(?:ume)?(?:\s+([+-]?)(\d+))?$/.exec(args)
    if (vol !== null) {
      const [, sign, n] = vol
      if (n === undefined) return { text: `Volume ${await read($, volume)}%.` }
      const v = await louder($, sign === '' ? Number(n) - (await read($, volume)) : Number(`${sign}${n}`))
      return { text: `Volume ${v}%.` }
    }

    if (args === 'similar' || args === 'like') {
      const t = await once($, () => playSimilar($))
      return { text: t === undefined ? 'No radio for this one.' : `Like it: ${t.title}` }
    }

    if (args === 'pause' || args === 'next' || args === 'stop') {
      if (p.pgid === null) return { text: 'Nothing is playing from here.' }
      if (args === 'stop') {
        await stop($)
        return { text: 'Stopped.' }
      }
      if (args === 'next') {
        const t = await once($, () => skip($, 1))
        return { text: t === undefined ? 'End of the list.' : `Next: ${t.title}` }
      }
      const q = await toggle($)
      if (q === undefined) return { text: 'VLC did not answer; nothing changed.' }
      return { text: q.isPlaying ? 'Resumed.' : 'Paused.' }
    }

    // /music find <search>: the results, numbered, nothing played; /music
    // pick <n> plays one of them.
    const asked = /^find\s+(.+)$/.exec(args)
    if (asked !== null) {
      if (isFinding) return { text: 'A search is already running.' }
      const query = (asked[1] ?? '').trim()
      const tracks = await find($, query)
      if (tracks === undefined) return { text: `The search for "${query}" failed.` }
      if (tracks.length === 0) return { text: `Nothing found on YouTube for "${query}".` }
      return { text: `${listing(tracks)}\n\n/music pick <n> plays one.` }
    }
    const picked = /^pick\s+(\d+)$/.exec(args)
    if (picked !== null) {
      const f = await read($, found)
      const n = Number(picked[1]) - 1
      if (f.tracks.length === 0) return { text: 'Nothing found yet: /music find <search> first.' }
      if (f.tracks[n] === undefined) return { text: `Pick 1 to ${f.tracks.length}.` }
      const t = await once($, () => pick($, n))
      return { text: t === undefined ? 'That one did not start.' : `Playing "${t.title}" (https://youtu.be/${t.id})` }
    }

    const track = await once($, () => play($, args, false))
    if (track === undefined) return { text: `Nothing found on YouTube for "${args}".` }
    return { text: `Playing "${track.title}" (https://youtu.be/${track.id})` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const p = await read($, player)
    const level = await read($, volume)
    const now = p.tracks[p.index]
    const { value: avatar } = await $.state.get(onDuty)
    const { value: onAir } = await $.state.get(onStation)
    const station = onAir !== undefined && onAir.artists.length > 0 ? onAir : undefined
    const isTerminal = e.surface === 'terminal'
    // The border and the play glyph take three columns on the terminal.
    const width = Math.max(10, (e.props.bodyColumns ?? 40) - (isTerminal ? 5 : 2))
    const title = now === undefined ? 'Nothing plays.' : now.title.length > width ? `${now.title.slice(0, width - 1)}…` : now.title
    const where = p.genre === null || p.genre === undefined ? `${p.index + 1}/${p.tracks.length}` : (GENRES.some(g => g.label === p.genre) ? p.genre : (onAir?.name || p.genre))

    // A list, not a fragment: the terminal lays a fragment out as a column of
    // its own, which stacked the controls one per row and cut off `u: vol+`.
    const controls = [
      <Button key="toggle" label={p.isPlaying ? 'pause' : 'play'} hotkey="p" plain onPress={() => void toggle($)} />,
      <Button key="next" label="next" hotkey="n" plain onPress={() => void once($, () => skip($, 1))} />,
      <Button key="similar" label="similar" hotkey="r" plain onPress={() => void once($, () => playSimilar($))} />,
      <Button key="stop" label="stop" hotkey="s" plain dimColor onPress={() => void stop($)} />,
      <Button key="quieter" label="vol−" hotkey="d" plain dimColor onPress={() => void louder($, -VOLUME_STEP)} />,
      <Button key="louder" label="vol+" hotkey="u" plain dimColor onPress={() => void louder($, VOLUME_STEP)} />,
    ]
    const f = await read($, found)
    const isSearching = await read($, searching)
    const fit = (t: string, room: number): string => (t.length > room ? `${t.slice(0, room - 1)}…` : t)
    const reopen = (open: boolean, results: number) => void $.ui.open({ id: PANE, title: 'jukebox7', rows: paneRows(open, results) })
    const finder = (
      <Button
        key="find"
        label={isSearching ? 'close search' : 'find'}
        hotkey="f"
        plain
        dimColor={!isSearching}
        onPress={() => {
          void (async () => {
            await update($, searching, () => !isSearching)
            reopen(!isSearching, f.tracks.length)
          })()
        }}
      />
    )
    const search = isSearching ? (
      <Box flexDirection="column" backgroundColor={isTerminal ? BLACK : undefined}>
        <Input
          key="query"
          label="find: "
          placeholder={f.query === '' ? 'ctrl+x tab, a search, Enter' : f.query}
          submitLabel="find"
          autoFocus
          onSubmit={value => {
            const query = value.replace(/\s+/g, ' ').trim()
            if (query === '' || isFinding) return
            void (async () => {
              const pending = find($, query)
              $.ui.invalidate('ui.render')
              const tracks = await pending
              reopen(true, tracks?.length ?? 1)
              $.ui.invalidate('ui.render')
            })()
          }}
        />
        {isFinding ? (
          <Text dimColor>searching…</Text>
        ) : f.query !== '' && f.tracks.length === 0 ? (
          <Text dimColor>{`nothing found for "${f.query}"`}</Text>
        ) : (
          f.tracks.slice(0, PICK_KEYS.length).map((t, i) => (
            <Button
              key={`pick-${t.id}`}
              label={fit(`${t.title}${t.seconds === null ? '' : ` (${clock(t.seconds)})`}`, width - 3)}
              hotkey={PICK_KEYS[i]}
              plain
              dimColor={now?.id !== t.id}
              onPress={() => void once($, () => pick($, i))}
            />
          ))
        )}
      </Box>
    ) : null

    const stations = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} backgroundColor={isTerminal ? BLACK : undefined}>
        {GENRES.map(g => (
          <Button key={g.label} label={g.label} hotkey={g.key} plain dimColor onPress={() => void once($, () => playGenre($, g.label))} />
        ))}
        {station !== undefined && avatar !== undefined && (
          <Button key="avatar" label={`${station.name}'s pick`} hotkey="a" plain onPress={() => void once($, () => playGenre($, avatar))} />
        )}
        {isTerminal && finder}
      </Box>
    )

    if (!isTerminal) {
      return (
        <Box flexDirection="column">
          <Text dimColor={now === undefined || !p.isPlaying}>{title}</Text>
          {now !== undefined && (
            <Box flexDirection="row" gap={2}>
              <Text dimColor>
                {p.isPlaying ? 'playing' : 'paused'} {where} · vol {level}%
              </Text>
              {controls}
            </Box>
          )}
          {stations}
          {finder}
          {search}
        </Box>
      )
    }

    // The terminal: black, framed and lit in the color of the avatar on duty.
    const { value: color } = await $.state.get(tint)
    const accent = typeof color === 'string' && color !== '' ? color : PHOSPHOR
    const bar = progress(p, await $.clock.now(), now?.seconds ?? null)
    const rows = e.props.scroll?.bodyRows ?? 0
    // The frame, the title, the bar, the controls and the stations; the rain
    // takes what is left of the pane's height.
    // The controls and the stations wrap inside the frame (border and padding:
    // four columns); each row they take comes out of the rain.
    const inner = Math.max(10, (e.props.bodyColumns ?? 40) - 4)
    const controlRows = now === undefined ? 0 : buttonRows([p.isPlaying ? 'pause' : 'play', 'next', 'similar', 'stop', 'vol−', 'vol+'], inner)
    const stationRows = buttonRows(
      [...GENRES.map(g => g.label), ...(station !== undefined ? [`${station.name}'s pick`] : []), isSearching ? 'close search' : 'find'],
      inner,
    )
    // The field, then a result a row (or the one line saying why there are none).
    const searchRows = isSearching ? 1 + (isFinding || f.tracks.length === 0 ? (f.query === '' && !isFinding ? 0 : 1) : Math.min(f.tracks.length, PICK_KEYS.length)) : 0
    // The frame's two borders, the title, the bar when something plays.
    const rainRows = Math.max(0, rows - 3 - (now === undefined ? 0 : 1) - controlRows - stationRows - searchRows)
    const rainColumns = Math.max(0, (e.props.bodyColumns ?? 40) - 2)
    return (
      <Box flexDirection="column" width="100%" height={rows > 0 ? rows : undefined} backgroundColor={BLACK}>
        <Box flexDirection="column" borderStyle="round" borderColor={accent} backgroundColor={BLACK} paddingX={1}>
          <Text color={accent} backgroundColor={BLACK} dimColor={now === undefined || !p.isPlaying}>
            {now === undefined ? '■ ' : p.isPlaying ? '▶ ' : '❚❚ '}
            {title}
          </Text>
          {now !== undefined && (
            <Text backgroundColor={BLACK}>
              <Text color={accent}>{bar.done}</Text>
              <Text dimColor>{bar.left}</Text>
              <Text dimColor>{` ${bar.time}  ${where}  vol ${level}%`}</Text>
            </Text>
          )}
          {now !== undefined && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={2} backgroundColor={BLACK}>
              {controls}
            </Box>
          )}
          {stations}
          {search}
        </Box>
        <Box flexDirection="column" flexGrow={1} paddingX={1} backgroundColor={BLACK}>
          {rain(rainColumns, rainRows, frame).map((runs, r) => (
            <Text key={String(r)} backgroundColor={BLACK}>
              {runs.map((run, i) => (
                <Text key={String(i)} color={run.level === 2 ? '#e8fff4' : accent} dimColor={run.level === 1}>
                  {run.text}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
