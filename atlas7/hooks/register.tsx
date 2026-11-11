// atlas7: the world in a pane. A planisphere in braille dots, wireframe: the coastlines and a sparse graticule,
// bright where the sun is up and dim where it is night, the line between the two drawn across the oceans. On it,
// what five public feeds say happened: earthquakes (USGS) and natural events (NASA EONET) where they are,
// headlines (BBC, France 24, Al Jazeera) on the capital of the country they name. Above it, the same as a wire,
// the newest first. No service behind it and no key: the feeds are read every ten minutes while the pane is
// open, the sun is computed from the hour.
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Event, Kind, Say, Wire } from '../types'
import { COAST } from './coast'
import { PLACES } from './places'

const PANE = 'atlas7'
const WIRE_MS = 600_000
const EMPTY: Wire = { events: [], failed: [], at: 0 }
// Change the tag when the wire's fields change: it declines what an earlier version stored.
const wire = atom({ plugin: 'atlas7', key: 'wire' } as const, EMPTY, { shape: 'wire-1' })
let tick: { cancel: () => void } | undefined

const FEEDS = {
  usgs: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson',
  eonet: 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=7&limit=40',
  bbc: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  f24: 'https://www.france24.com/en/rss',
  alj: 'https://www.aljazeera.com/xml/rss/all.xml',
} as const
const PRESS = ['bbc', 'f24', 'alj'] as const
// How many headlines of each press feed are kept, and from what magnitude a quake is worth a word aloud.
const HEADLINES = 15
const STRONG = 6.5

// ---- the sun

const RAD = Math.PI / 180
// The point of the Earth the sun is straight above at that instant (NOAA's short series: the declination and the
// equation of time from the fraction of the year). Good to a fraction of a degree, which is less than a dot here.
export const sun = (ms: number): { lon: number; lat: number } => {
  const d = new Date(ms)
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600
  const day = Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000)
  const g = ((2 * Math.PI) / 365) * (day + (hours - 12) / 24)
  const minutes = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g))
  const lat = (0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g)) / RAD
  const lon = -15 * (hours - 12 + minutes / 60)
  return { lon: ((((lon + 180) % 360) + 360) % 360) - 180, lat }
}
// Is it day there: the sun above the horizon, its light not counted through the air.
export const isLit = (lon: number, lat: number, s: { lon: number; lat: number }): boolean =>
  Math.sin(lat * RAD) * Math.sin(s.lat * RAD) + Math.cos(lat * RAD) * Math.cos(s.lat * RAD) * Math.cos((lon - s.lon) * RAD) > 0
// "12°S 168°W", as on a chart.
export const sayPoint = (p: { lon: number; lat: number }): string =>
  `${Math.abs(Math.round(p.lat))}°${p.lat < 0 ? 'S' : 'N'} ${Math.abs(Math.round(p.lon))}°${p.lon < 0 ? 'W' : 'E'}`

// ---- the feeds

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const event = (kind: Kind, source: string, title: string, at: number, lon: number, lat: number, placed: boolean, exact: boolean, mag = 0): Event => ({ kind, source, title, at, lon, lat, placed, exact, mag })

// USGS: every quake of magnitude 4.5 and over in the last day, where it was.
export const parseQuakes = (text: string): Event[] => {
  const got = JSON.parse(text) as { features?: { properties?: { mag?: number; place?: string; time?: number }; geometry?: { coordinates?: number[] } }[] }
  return (got.features ?? []).flatMap(f => {
    const [lon, lat] = f.geometry?.coordinates ?? []
    if (typeof lon !== 'number' || typeof lat !== 'number') return []
    const mag = num(f.properties?.mag)
    return [event('quake', 'usgs', `M ${mag.toFixed(1)} · ${f.properties?.place ?? 'somewhere'}`, num(f.properties?.time), lon, lat, true, true, mag)]
  })
}
const NATURE: Record<string, Kind> = { severeStorms: 'storm', wildfires: 'fire', volcanoes: 'volcano', seaLakeIce: 'ice' }
// NASA EONET: the natural events still open, each at its last known point (the ones given as an area are left out).
export const parseNature = (text: string): Event[] => {
  const got = JSON.parse(text) as { events?: { title?: string; categories?: { id?: string }[]; geometry?: { type?: string; date?: string; coordinates?: unknown }[] }[] }
  return (got.events ?? []).flatMap(e => {
    const last = e.geometry?.at(-1)
    const [lon, lat] = last?.type === 'Point' && Array.isArray(last.coordinates) ? (last.coordinates as unknown[]) : []
    if (typeof lon !== 'number' || typeof lat !== 'number') return []
    return [event(NATURE[e.categories?.[0]?.id ?? ''] ?? 'other', 'eonet', e.title ?? '', Date.parse(last?.date ?? '') || 0, lon, lat, true, true)]
  })
}

const LETTER = 'A-Za-zÀ-ÿ'
const NAMES = PLACES.flatMap(([names, lon, lat]) => names.split('|').map(name => ({ name, lon, lat })))
// One search for every name, the longest first so that "South Sudan" is not read as "Sudan"; a name counts only
// as a whole word, in the capitals it is written with.
const NAMED = new RegExp(`(?<![${LETTER}])(${NAMES.map(n => n.name).sort((a, b) => b.length - a.length).map(n => n.replace(/[.]/g, '\\.')).join('|')})(?![${LETTER}])`)
// The country a headline names first, as its capital; nothing when it names none this mod knows.
export const locate = (title: string): { lon: number; lat: number } | undefined => {
  const found = NAMED.exec(title)?.[1]
  const place = NAMES.find(n => n.name === found)
  return place === undefined ? undefined : { lon: place.lon, lat: place.lat }
}
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export const plain = (xml: string): string =>
  xml
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/g, (all, name: string) => ENTITIES[name] ?? all)
    .replace(/\s+/g, ' ')
    .trim()
// A press feed (RSS): its first headlines, each put on the country it names when it names one.
export const parsePress = (source: string, xml: string): Event[] =>
  xml
    .split(/<item[\s>]/)
    .slice(1, HEADLINES + 1)
    .flatMap(item => {
      const title = plain(/<title>([\s\S]*?)<\/title>/.exec(item)?.[1] ?? '')
      if (title === '') return []
      const where = locate(title)
      return [event('news', source, title, Date.parse(plain(/<pubDate>([\s\S]*?)<\/pubDate>/.exec(item)?.[1] ?? '')) || 0, where?.lon ?? 0, where?.lat ?? 0, where !== undefined, false)]
    })

// The quakes strong enough to be said that were not in the reading before. A first reading has nothing to compare
// with and says nothing.
export const newlyStrong = (before: Wire, now: Wire): Event[] =>
  before.at === 0 ? [] : now.events.filter(e => e.kind === 'quake' && e.mag >= STRONG && !before.events.some(o => o.kind === 'quake' && o.title === e.title))

// ---- the map

// How many times taller than wide a cell of the terminal is (measured for map7: JetBrains Mono in WezTerm).
const CELL = 2.3
// The frame: every longitude, from 84° N down to 60° S (below it there is only Antarctica, which this projection
// would smear across the whole width).
const NORTH = 84
const SOUTH = -60
// A degree east is as wide on the screen as a degree north is tall: the rows a map of that many columns takes.
const ROWS_PER_COLUMN = (NORTH - SOUTH) / (360 * CELL)
// The largest map the pane has room for, the wire keeping at least five rows above it.
export const size = (rows: number, columns: number): { wide: number; tall: number } => {
  const tall = Math.max(0, Math.min(Math.round((columns - 2) * ROWS_PER_COLUMN), rows - 5))
  return { wide: Math.max(0, Math.min(columns - 2, Math.round(tall / ROWS_PER_COLUMN))), tall }
}

const BLACK = '#000000'
const CYAN = '#2ee6e6'
const RED = '#ff4d5e'
const AMBER = '#ffb347'
const WHITE = '#e8fff4'
// What a cell of the map holds, the highest winning: nothing, the graticule by night and by day, the line between
// night and day, the coast by night and by day, a headline, a natural event, an earthquake.
const TONES = [BLACK, '#2b2152', '#12505c', '#ff3df0', '#6a4fc4', CYAN, WHITE, AMBER, RED] as const
const MARK: Record<Kind, number> = { news: 6, storm: 7, fire: 7, volcano: 7, ice: 7, other: 7, quake: 8 }

// The planisphere in braille dots (two by four in a cell), at that instant. Each row comes back as runs of one color.
export const draw = (columns: number, rows: number, events: readonly Event[], ms: number): { tone: number; text: string }[][] => {
  const w = columns * 2, h = rows * 4
  const s = sun(ms)
  const bits = Array.from({ length: rows }, () => new Array<number>(columns).fill(0))
  const tones = Array.from({ length: rows }, () => new Array<number>(columns).fill(0))
  const marks = Array.from({ length: rows }, () => new Array<string>(columns).fill(''))
  const at = (lon: number, lat: number): [number, number] => [((lon + 180) / 360) * (w - 1), ((NORTH - lat) / (NORTH - SOUTH)) * (h - 1)]
  // Day or night at each dot, from what its row and its column each bring: computed once, read many times.
  const up = Array.from({ length: h }, (_, y) => { const lat = (NORTH - (y / (h - 1)) * (NORTH - SOUTH)) * RAD; return Math.sin(lat) * Math.sin(s.lat * RAD) })
  const across = Array.from({ length: h }, (_, y) => { const lat = (NORTH - (y / (h - 1)) * (NORTH - SOUTH)) * RAD; return Math.cos(lat) * Math.cos(s.lat * RAD) })
  const turn = Array.from({ length: w }, (_, x) => Math.cos(((x / (w - 1)) * 360 - 180 - s.lon) * RAD))
  const lit = (x: number, y: number): boolean => (up[y] ?? 0) + (across[y] ?? 0) * (turn[x] ?? 0) > 0
  const dot = (x: number, y: number, tone: number): void => {
    const cx = Math.round(x), cy = Math.round(y)
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return
    const row = bits[cy >> 2], shade = tones[cy >> 2]
    if (row === undefined || shade === undefined) return
    // braille numbers its dots down the left column, then down the right; the fourth row came later (0x40, 0x80)
    row[cx >> 1] = (row[cx >> 1] ?? 0) | ([[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]][cy & 3]?.[cx & 1] ?? 0)
    shade[cx >> 1] = Math.max(shade[cx >> 1] ?? 0, tone)
  }
  // The dot takes the darker tone by night, the brighter by day.
  const shaded = (x: number, y: number, night: number): void => dot(x, y, lit(Math.round(x), Math.round(y)) ? night + 1 : night)
  // The graticule, every thirty degrees, one dot in four: the wireframe.
  for (let lon = -180; lon <= 180; lon += 30) for (let y = 0; y < h; y += 4) shaded(at(lon, 0)[0], y, 1)
  for (let lat = 60; lat >= SOUTH; lat -= 30) for (let x = 0; x < w; x += 4) shaded(x, at(0, lat)[1], 1)
  // The line between night and day: every dot whose neighbour to the right or below is on the other side.
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) if (lit(x, y) !== lit(x + 1, y) || lit(x, y) !== lit(x, y + 1)) dot(x, y, 3)
  for (const path of COAST) {
    for (let i = 2; i + 1 < path.length; i += 2) {
      const lonA = path[i - 2] ?? 0, lonB = path[i] ?? 0
      if (Math.abs(lonB - lonA) > 180) continue          // a stretch across the date line would cross the whole map
      const [ax, ay] = at(lonA, path[i - 1] ?? 0)
      const [bx, by] = at(lonB, path[i + 1] ?? 0)
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))))
      for (let k = 0; k <= steps; k++) shaded(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps, 4)
    }
  }
  // The marks, the oldest first so that the newest is the one seen where two fall in a cell: full for a place the
  // source gave, hollow for a headline put on its country.
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (!e.placed) continue
    const [x, y] = at(e.lon, e.lat)
    const r = Math.round(y) >> 2, c = Math.round(x) >> 1, tone = MARK[e.kind]
    const row = marks[r], shade = tones[r]
    if (row === undefined || shade === undefined || c < 0 || c >= columns || ((shade[c] ?? 0) > tone && row[c] !== '')) continue
    row[c] = e.exact ? '●' : '○'
    shade[c] = tone
  }
  return bits.map((row, y) => {
    const runs: { tone: number; text: string }[] = []
    row.forEach((v, x) => {
      const tone = tones[y]?.[x] ?? 0
      const glyph = marks[y]?.[x] || String.fromCharCode(0x2800 + v)
      const last = runs[runs.length - 1]
      if (last !== undefined && last.tone === tone) last.text += glyph
      else runs.push({ tone, text: glyph })
    })
    return runs
  })
}

// ---- the pane

const HELP = 'opens with the session · /atlas: open the planisphere (the lit half of the Earth, quakes, natural events, headlines) · /atlas off: close it · /atlas now: read the feeds again'
const TAG: Record<Kind, string> = { quake: 'quake', storm: 'storm', fire: 'fire', volcano: 'volc.', ice: 'ice', other: 'event', news: '' }
// Read only: avatar7 owns it and says which face is on duty; the frame takes its color, as jukebox7's does.
const tint = { plugin: 'avatar7', key: 'color' } as const

const say = async ($: Engine, mood: Say['mood'], text: string): Promise<void> => {
  await $.state.set({ plugin: 'atlas7', key: 'say' } as const, { mood, event: text, at: Date.now() } satisfies Say)
}
// Every feed asked at once; one that fails or answers something else is named, and what it gave before is kept.
const load = async ($: Engine): Promise<void> => {
  const before = await read($, wire)
  const parsers: Record<keyof typeof FEEDS, (text: string) => Event[]> = {
    usgs: parseQuakes,
    eonet: parseNature,
    bbc: t => parsePress('bbc', t),
    f24: t => parsePress('f24', t),
    alj: t => parsePress('alj', t),
  }
  const failed: string[] = []
  const got = await Promise.all(
    (Object.keys(FEEDS) as (keyof typeof FEEDS)[]).map(async name => {
      try {
        const answer = await $.http.fetch(FEEDS[name])
        if (!answer.ok) throw new Error(String(answer.status))
        return parsers[name](answer.text)
      } catch {
        failed.push(name)
        return before.events.filter(e => e.source === name)
      }
    }),
  )
  const now: Wire = { events: got.flat().sort((a, b) => b.at - a.at), failed, at: Date.now() }
  await update($, wire, () => now)
  for (const q of newlyStrong(before, now)) await say($, 'watch', `a strong earthquake was just reported: ${q.title}`)
}
const watch = ($: Engine): void => {
  if (tick === undefined) tick = $.clock.every(WIRE_MS, () => void load($))
}
// The pane opened, the timer set, the feeds read once.
const show = async ($: Engine): Promise<void> => {
  await $.ui.open({ id: PANE, title: 'atlas7', rows: 32 })
  watch($)
  await load($)
}
const hour = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const register: Register = on => {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    watch($)            // after a reload the pane is still open and the timer is gone
    const b = await read($, wire)
    const { value: color } = await $.state.get(tint)
    const accent = typeof color === 'string' && color !== '' ? color : CYAN
    const rows = e.props.scroll?.bodyRows ?? 32
    const columns = e.props.bodyColumns ?? 80
    const now = Date.now()
    const spot = size(rows, columns)
    const chart = spot.wide < 40 ? [] : draw(spot.wide, spot.tall, b.events, now)
    // The wire has what the map leaves: its two borders and its last row come out of it.
    const room = Math.max(1, rows - chart.length - 3)
    const shown = b.events.slice(0, room)
    const inner = Math.max(30, columns - 4)
    const counts = `${b.events.filter(x => x.kind === 'quake').length} quakes · ${b.events.filter(x => x.kind !== 'quake' && x.kind !== 'news').length} natural events · ${b.events.filter(x => x.kind === 'news').length} headlines`
    return (
      <Box flexDirection="column" width="100%" height={rows > 0 ? rows : undefined} backgroundColor={BLACK}>
        <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} backgroundColor={BLACK}>
          {shown.map((x, i) => (
            <Text key={String(i)} backgroundColor={BLACK}>
              <Text dimColor>{`${x.at === 0 ? '  ·  ' : hour(x.at)} `}</Text>
              <Text color={TONES[MARK[x.kind]] ?? WHITE} dimColor={!x.placed}>{`${x.placed ? (x.exact ? '●' : '○') : '·'} ${(x.kind === 'news' ? x.source : TAG[x.kind]).padEnd(6)}`}</Text>
              <Text>{x.title.slice(0, inner - 14)}</Text>
            </Text>
          ))}
          {b.events.length === 0 && <Text backgroundColor={BLACK} dimColor>{b.at === 0 ? 'reading the feeds…' : 'no feed answered'}</Text>}
          <Text backgroundColor={BLACK} dimColor>
            <Text color={CYAN}>{b.at === 0 ? '--:--' : hour(b.at)}</Text>
            {` · ${counts} · sun over ${sayPoint(sun(now))}`}
            {b.failed.length > 0 && <Text color={AMBER}>{` · silent: ${b.failed.join(', ')}`}</Text>}
          </Text>
        </Box>
        {chart.length > 0 && (
          <Box flexDirection="column" width={spot.wide + 2} alignSelf="center" paddingX={1} backgroundColor={BLACK}>
            {chart.map((runs, y) => (
              <Text key={String(y)} backgroundColor={BLACK}>
                {runs.map((run, i) => (
                  <Text key={String(i)} color={TONES[run.tone] ?? CYAN}>
                    {run.text}
                  </Text>
                ))}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) { tick?.cancel(); tick = undefined }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'atlas', description: 'atlas7: the planisphere of what is happening (/atlas, /atlas off, /atlas now, /atlas help)' })
    void show($)        // not awaited: a feed that is slow or silent must not hold the session's start
    return next(e)
  })

  on('command.run', { command: 'atlas' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'help') return { text: `atlas7: ${HELP}` }
    if (args === 'off') {
      tick?.cancel(); tick = undefined
      await $.ui.close({ id: PANE })
      return { text: 'atlas7: the planisphere is closed (/atlas opens it again).' }
    }
    if (args !== '' && args !== 'now') return { text: `atlas7: ${HELP}` }
    await show($)
    const b = await read($, wire)
    return { text: `atlas7: ${b.events.length} events read${b.failed.length > 0 ? ` (silent: ${b.failed.join(', ')})` : ''}, read again every ten minutes while the pane is open (/atlas off closes it).` }
  })
}
