import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { Player, Track } from '../types'

// Cheap sieve before any model call: a prompt without one of these words
// reaches the session untouched, with no added latency.
const CANDIDATE =
  /\b(musique|music|morceau|chanson|son|joue|jouer|mets|lance|play|pause|stop|coupe|arr[eê]te|reprends|resume|suivant|next|skip|ambient|lofi|playlist|youtube)\b/i

const INTENT = [
  'You read one message typed to a coding assistant and decide whether it asks to control music playback on the computer.',
  'Answer with one line of JSON and nothing else, one of:',
  '{"action":"play","query":"...","long":true}',
  '{"action":"toggle"}',
  '{"action":"next"}',
  '{"action":"stop"}',
  '{"action":"none"}',
  'play: the user wants music played now. query: YouTube search words, in English for a genre or mood, as given for a named artist or title.',
  'long: true for background or mood music (ambient, lofi, focus, a genre), false for one named track.',
  'toggle: pause or resume the music. next: skip to another one. stop: stop, cut or turn off the music.',
  'none: anything else, including talk about music, code that plays audio, and requests aimed at Renoise, play7, keys7, a piano, a pattern or a melody.',
].join('\n')

type Intent =
  | { action: 'play'; query: string; long: boolean }
  | { action: 'toggle' }
  | { action: 'next' }
  | { action: 'stop' }
  | { action: 'none' }

// A song lasts two to twenty minutes; above is an album or a mix. A mood
// asked in words prefers five minutes and more.
const MIN_SECONDS = 120
const LONG_SECONDS = 300
const MAX_SECONDS = 1200
const SEARCH_SIZE = 8
const PANE = 'jukebox7'
const POLL_MS = 5_000

// One click, a radio: a random artist of the genre, a random song of theirs;
// next and the end of the song roll again. Seeded from the author's own listening.
export const GENRES: { key: string; label: string; artists: string[] }[] = [
  {
    key: '1',
    label: 'ambient',
    artists: ['Boards of Canada', 'Loscil', 'Helios', 'Múm', 'Kenji Kawai Ghost in the Shell', 'Rafael Anton Irisarri', 'Ulver Perdition City', 'Brian Eno', 'bean3'],
  },
  { key: '2', label: 'lofi', artists: ['Nujabes', 'Prefuse 73', 'cLOUDDEAD', 'DJ Shadow', 'Bonobo', 'Tomppabeats', 'Why?'] },
  {
    key: '3',
    label: 'black metal',
    artists: ['Dissection', 'Cradle of Filth Dusk and Her Embrace', 'Emperor', 'Dimmu Borgir Enthrone Darkness Triumphant', 'Agalloch', 'Ulver Bergtatt', 'Arcturus', 'Blut Aus Nord', 'Wolves in the Throne Room'],
  },
  { key: '4', label: 'darksynth', artists: ['Fixions', 'Mega Drive', 'Danger', 'Perturbator', 'Carpenter Brut', 'Dan Terminus', 'Gost', 'Dance With the Dead'] },
  { key: '5', label: 'idm', artists: ['Aphex Twin', 'Plaid', 'Boards of Canada', 'Squarepusher', 'Venetian Snares', 'Autechre', 'Clark', 'Wisp The Shimmering Hour', 'Arovane', 'Kettel'] },
  {
    key: '6',
    label: 'indie rock',
    artists: ['Pixies', 'Modest Mouse', 'Blonde Redhead', 'Eels', 'Sparklehorse', 'Elliott Smith', 'Grandaddy', 'Built to Spill', 'The Unicorns', 'Sufjan Stevens', 'MGMT'],
  },
  {
    key: '7',
    label: 'video games',
    artists: [
      'NieR Automata soundtrack Keiichi Okabe', 'Jeremy Soule Skyrim', 'Jeremy Soule Morrowind', 'Jeremy Soule Oblivion',
      'Akira Yamaoka Silent Hill', 'Deus Ex soundtrack', 'Christopher Larkin Hollow Knight', 'C418 Minecraft', 'Cyberpunk 2077 soundtrack',
    ],
  },
]

// What each avatar7 face would put on, within the author's own styles.
export const STATIONS: Record<string, { name: string; artists: string[] }> = {
  shodan: { name: 'SHODAN', artists: ['System Shock soundtrack', 'Skinny Puppy', 'Autechre', 'Venetian Snares', 'Perturbator', 'Blut Aus Nord', 'Atari Teenage Riot', 'Deus Ex soundtrack'] },
  hal: { name: 'HAL 9000', artists: ['Boards of Canada', 'Brian Eno', 'Kenji Kawai Ghost in the Shell', 'Loscil', 'Aphex Twin Selected Ambient Works Volume II', 'Arovane', 'Ulver Perdition City'] },
  glados: { name: 'GLaDOS', artists: ['Aphex Twin', 'Plaid', 'Squarepusher', 'Portal 2 soundtrack', 'Kettel', 'Ceephax Acid Crew', 'The Unicorns', 'Danger'] },
  ada: { name: 'Ada', artists: ['Jeremy Soule Oblivion', 'Múm', 'Helios', 'Sufjan Stevens', 'Joanna Newsom Ys', 'Broadcast', 'Arcturus', 'Agalloch'] },
  commis: { name: 'The Commis', artists: ['Grandaddy', 'Sparklehorse', 'Elliott Smith', 'Neutral Milk Hotel', 'Agalloch', 'Jeremy Soule Skyrim', 'Jeremy Soule Morrowind', 'Modest Mouse'] },
  duck7: { name: 'duck7', artists: ['Venetian Snares', 'Pixies', 'Modest Mouse', 'The Unicorns', 'Sewerslvt', 'Machine Girl', 'Of Montreal', 'Eels'] },
  kaneda: { name: 'Kaneda', artists: ['Geinoh Yamashirogumi Akira', 'Carpenter Brut', 'Danger', 'Fixions', 'Pixies', 'Atari Teenage Riot', 'Perturbator', 'Mega Drive'] },
  pod042: { name: 'Pod 042', artists: ['NieR Automata soundtrack Keiichi Okabe', 'NieR Replicant soundtrack', 'Mega Drive', 'Dan Terminus', 'Plaid', 'Boards of Canada', 'Fixions'] },
}
// A genre's artists, or an avatar's station by its id.
const pool = (label: string): string[] => GENRES.find(g => g.label === label)?.artists ?? STATIONS[label]?.artists ?? []
const onDuty = { plugin: 'avatar7', key: 'avatar' } as const

const anyOf = <T,>(xs: T[]): T | undefined => xs[Math.floor(Math.random() * xs.length)]
export const isSong = (t: Track): boolean => t.seconds !== null && t.seconds >= MIN_SECONDS && t.seconds <= MAX_SECONDS

const IDLE: Player = { tracks: [], index: 0, pgid: null, isPlaying: false, genre: null }
const player = atom({ plugin: 'jukebox7', key: 'player' } as const, IDLE)

export const parseIntent = (text: string): Intent => {
  const json = /\{[^}]*\}/.exec(text)?.[0]
  if (json === undefined) return { action: 'none' }
  try {
    const v = JSON.parse(json) as Record<string, unknown>
    if (v.action === 'play' && typeof v.query === 'string' && v.query.trim() !== '') {
      return { action: 'play', query: v.query.trim(), long: v.long === true }
    }
    if (v.action === 'toggle' || v.action === 'next' || v.action === 'stop') return { action: v.action }
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

// Audio only, no window: yt-dlp streams the best audio into Windows' VLC
// with its dummy interface (WSLg's PulseAudio stalls after a sleep, VLC
// plays on the Windows side and takes no focus). setsid puts the WSL side in
// a process group of its own, so STOP and CONT starve or feed VLC; vlc://quit
// ends it with the stream; the id arrives as $1, checked against
// /^[\w-]{11}$/ before.
const VLC = '/mnt/c/Program Files/VideoLAN/VLC/vlc.exe'
const TAG = '--meta-title=jukebox7'
const PIPE = `yt-dlp -q --no-warnings -f bestaudio -o - "https://www.youtube.com/watch?v=$1" | "${VLC}" --intf dummy --dummy-quiet --play-and-exit --no-video -q ${TAG} - vlc://quit`
export const startArgv = (id: string): string[] => [
  'bash',
  '-c',
  `setsid bash -c '${PIPE}' _ "$1" </dev/null >/dev/null 2>&1 & echo $!`,
  '_',
  id,
]
// Killing the WSL side leaves vlc.exe running: it goes by its tag, so a VLC
// the user opened themselves is never touched.
const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
export const killVlcArgv = [
  POWERSHELL,
  '-NoProfile',
  '-Command',
  `Get-CimInstance Win32_Process -Filter "Name='vlc.exe'" | Where-Object { $_.CommandLine -like '*${TAG}*' } | Invoke-CimMethod -MethodName Terminate | Out-Null`,
]
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

async function playAt($: Engine, tracks: Track[], index: number, genre: string | null = null): Promise<Track | undefined> {
  const before = await read($, player)
  if (before.pgid !== null) await halt($, before.pgid)
  const track = tracks[index]
  if (track === undefined) {
    await update($, player, () => IDLE)
    $.ui.status(undefined)
    return undefined
  }
  const started = await $.process.run(startArgv(track.id))
  const pgid = Number(started.stdout.trim())
  const p: Player = { tracks, index, pgid: Number.isInteger(pgid) && pgid > 1 ? pgid : null, isPlaying: true, genre }
  await update($, player, () => p)
  $.ui.status(show(p))
  void $.ui.open({ id: PANE, title: 'jukebox7', rows: 5 })
  return track
}

async function skip($: Engine, by: number): Promise<Track | undefined> {
  const p = await read($, player)
  if (typeof p.genre === 'string') return playGenre($, p.genre)
  return playAt($, p.tracks, (p.index + by) % Math.max(1, p.tracks.length))
}

async function toggle($: Engine): Promise<Player> {
  const p = await read($, player)
  if (p.pgid === null) return p
  await $.process.run(signal(p.isPlaying ? 'STOP' : 'CONT', p.pgid))
  const q = { ...p, isPlaying: !p.isPlaying }
  await update($, player, () => q)
  $.ui.status(show(q))
  return q
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
  const tracks = parseTracks(found.stdout)
  const first = pickTrack(found.stdout, long)
  if (first === undefined) return undefined
  return playAt($, tracks, tracks.findIndex(t => t.id === first.id))
}

async function playGenre($: Engine, label: string): Promise<Track | undefined> {
  const artist = anyOf(pool(label))
  if (artist === undefined) return undefined
  $.ui.status(`music: looking for ${STATIONS[label]?.name ?? label}, ${artist}…`)
  const was = (await read($, player)).tracks
  const found = await $.process.run(search(artist), { timeoutMs: 20_000 })
  const songs = found.exitCode === 0 ? parseTracks(found.stdout).filter(isSong) : []
  const fresh = songs.filter(t => !was.some(w => w.id === t.id))
  const track = anyOf(fresh.length > 0 ? fresh : songs)
  if (track === undefined) {
    $.ui.status(undefined)
    $.ui.toast(`music: nothing found for ${artist}`)
    return undefined
  }
  $.ui.toast(`music now playing: ${track.title}`)
  return playAt($, [track], 0, label)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'music',
      description: 'Play music from YouTube: /music <search>, /music pause, /music next, /music stop, /music alone for what plays',
    })

    // A pipeline that ended by itself (the track is over) moves on to the
    // next result; one that cannot be found any more is forgotten.
    $.clock.every(POLL_MS, () => {
      void (async () => {
        const p = await read($, player)
        if (p.pgid === null || !p.isPlaying) return
        const alive = await $.process.run(['kill', '-0', '--', `-${p.pgid}`])
        if (alive.exitCode === 0) return
        await skip($, 1)
      })()
    })

    // Unasked, the pane seats from 144 columns, under the avatar's; /music
    // opens it at any width.
    void $.ui.open({ id: PANE, title: 'jukebox7', rows: 5 })

    return next(e)
  })

  // Quitting (or /clear, which loses $.state's pgid) must not orphan the
  // detached pipeline. The end chain runs under one short bound and
  // PowerShell starts slower than that: the group goes at once, the VLC
  // kill is detached so it outlives the exit.
  on('session.end', async ($, e, next) => {
    const p = await read($, player)
    if (p.pgid !== null) {
      await $.process.run(signal('CONT', p.pgid))
      await $.process.run(signal('TERM', p.pgid))
    }
    await $.process.run(detachedKillVlcArgv)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if ((e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') || !CANDIDATE.test(e.text)) return next(e)

    const r = await $.model.complete({
      model: 'haiku',
      system: INTENT,
      prompt: e.text.slice(0, 500),
      maxTokens: 60,
      effort: 'low',
      timeoutMs: 8_000,
    })
    const intent = r.isAnswered ? parseIntent(r.text) : ({ action: 'none' } as const)

    if (intent.action === 'none') return next(e)

    if (intent.action !== 'play') {
      if ((await read($, player)).pgid === null) return { drop: 'jukebox7: nothing is playing from here.' }
      if (intent.action === 'stop') {
        await stop($)
        $.ui.toast('music stopped')
        return { drop: 'jukebox7: stopped' }
      }
      if (intent.action === 'next') {
        const t = await skip($, 1)
        $.ui.toast(t === undefined ? 'music: end of the list' : `music now playing: ${t.title}`)
        return { drop: `jukebox7: ${t === undefined ? 'end of the list' : `next, ${t.title}`}` }
      }
      const q = await toggle($)
      const said = q.isPlaying ? `resumed: ${q.tracks[q.index]?.title ?? ''}` : 'paused'
      $.ui.toast(`music ${said}`)
      return { drop: `jukebox7: ${said}` }
    }

    const track = await play($, intent.query, intent.long)
    if (track === undefined) return { drop: `jukebox7: nothing found on YouTube for "${intent.query}".` }
    $.ui.toast(`music now playing: ${track.title}`)
    return { drop: `jukebox7: playing "${track.title}" (https://youtu.be/${track.id})` }
  })

  on('command.run', { command: 'music' }, async ($, e) => {
    const args = e.args.trim()
    const p = await read($, player)
    const now = p.tracks[p.index]
    if (args === '') {
      void $.ui.open({ id: PANE, title: 'jukebox7', rows: 5 })
      if (p.pgid === null || now === undefined) return { text: 'Nothing played from here yet: pick a genre in the pane.' }
      return { text: `${p.isPlaying ? 'Playing' : 'Paused'}: ${now.title}` }
    }

    if (args === 'pause' || args === 'next' || args === 'stop') {
      if (p.pgid === null) return { text: 'Nothing is playing from here.' }
      if (args === 'stop') {
        await stop($)
        return { text: 'Stopped.' }
      }
      if (args === 'next') {
        const t = await skip($, 1)
        return { text: t === undefined ? 'End of the list.' : `Next: ${t.title}` }
      }
      const q = await toggle($)
      return { text: q.isPlaying ? 'Resumed.' : 'Paused.' }
    }

    const track = await play($, args, false)
    if (track === undefined) return { text: `Nothing found on YouTube for "${args}".` }
    return { text: `Playing "${track.title}" (https://youtu.be/${track.id})` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const p = await read($, player)
    const now = p.tracks[p.index]
    const { value: avatar } = await $.state.get(onDuty)
    const station = avatar === undefined ? undefined : STATIONS[avatar]
    const width = Math.max(10, (e.props.bodyColumns ?? 40) - 2)
    const title = now === undefined ? 'Nothing plays.' : now.title.length > width ? `${now.title.slice(0, width - 1)}…` : now.title

    return (
      <Box flexDirection="column">
        <Text dimColor={now === undefined || !p.isPlaying}>{title}</Text>
        {now !== undefined && (
          <Box flexDirection="row" gap={2}>
            <Text dimColor>
              {p.isPlaying ? 'playing' : 'paused'} {p.genre === null || p.genre === undefined ? `${p.index + 1}/${p.tracks.length}` : (STATIONS[p.genre]?.name ?? p.genre)}
            </Text>
            <Button key="toggle" label={p.isPlaying ? 'pause' : 'play'} hotkey="p" plain onPress={() => void toggle($)} />
            <Button key="next" label="next" hotkey="n" plain onPress={() => void skip($, 1)} />
            <Button key="stop" label="stop" hotkey="s" plain dimColor onPress={() => void stop($)} />
          </Box>
        )}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {GENRES.map(g => (
            <Button key={g.label} label={g.label} hotkey={g.key} plain dimColor onPress={() => void playGenre($, g.label)} />
          ))}
          {station !== undefined && avatar !== undefined && (
            <Button key="avatar" label={`${station.name}'s pick`} hotkey="a" plain onPress={() => void playGenre($, avatar)} />
          )}
        </Box>
      </Box>
    )
  })
}
