import { expect, test } from 'claude-code/testing'

import { draw, isLit, locate, newlyStrong, parseCyclones, parseNature, parsePress, parseQuakes, plain, sayPoint, size, settle, sun, tape, ticker } from './register'

const near = (got: number, want: number, by: number): boolean => Math.abs(got - want) <= by

test('the sun stands over the tropic at the solstice, over the equator at the equinox, and over Greenwich at noon', () => {
  const june = sun(Date.UTC(2026, 5, 21, 12, 0))
  expect([near(june.lat, 23.44, 0.3), near(june.lon, 0, 1.5)]).toEqual([true, true])
  expect(near(sun(Date.UTC(2026, 2, 20, 14, 46)).lat, 0, 0.6)).toBe(true)
  expect(near(sun(Date.UTC(2026, 11, 21, 0, 0)).lat, -23.44, 0.3)).toBe(true)
  expect(near(Math.abs(sun(Date.UTC(2026, 11, 21, 0, 0)).lon), 180, 1.5)).toBe(true)   // midnight in Greenwich: noon on the date line
  expect(sayPoint({ lon: -168.2, lat: -12.4 })).toBe('12°S 168°W')
})

test('it is day under the sun, night on the other side, and the pole keeps its summer light', () => {
  const june = sun(Date.UTC(2026, 5, 21, 12, 0))
  expect([isLit(2.35, 48.85, june), isLit(174.8, -41.3, june), isLit(0, 89, june), isLit(0, -89, june)]).toEqual([true, false, true, false])
})

test('a quake and a natural event come with their place, an area and a broken entry are left out', () => {
  const q = parseQuakes(JSON.stringify({ features: [{ properties: { mag: 4.9, place: '207 km NW of Port-Olry, Vanuatu', time: 1794340458279 }, geometry: { coordinates: [165.5, -13.9, 11.7] } }, { properties: { mag: 5 } }] }))
  expect(q).toEqual([{ kind: 'quake', source: 'usgs', title: 'M 4.9 · 207 km NW of Port-Olry, Vanuatu', at: 1794340458279, lon: 165.5, lat: -13.9, placed: true, exact: true, mag: 4.9, alert: 0 }])
  const n = parseNature(JSON.stringify({ events: [
    { title: 'Typhoon Cempaka', categories: [{ id: 'severeStorms' }], geometry: [{ type: 'Point', date: '2026-11-09T12:00:00Z', coordinates: [140, 25] }, { type: 'Point', date: '2026-11-10T12:00:00Z', coordinates: [142.1, 26.1] }] },
    { title: 'A fire given as an area', categories: [{ id: 'wildfires' }], geometry: [{ type: 'Polygon', date: '2026-11-10T12:00:00Z', coordinates: [[[1, 2]]] }] },
  ] }))
  expect(n.map(e => [e.kind, e.title, e.lon, e.lat, e.at])).toEqual([['storm', 'Typhoon Cempaka', 142.1, 26.1, Date.UTC(2026, 10, 10, 12)]])
})

test('a cyclone still running comes with its name, wind and alert; NASA\'s storm for the same one is dropped', () => {
  const tc = (name: string, iscurrent: string, alertlevel: string, severity: number, coordinates: number[]) => ({ properties: { eventtype: 'TC', name, iscurrent, alertlevel, todate: '2026-11-11T06:00:00', severitydata: { severity } }, geometry: { type: 'Point', coordinates } })
  const got = parseCyclones(JSON.stringify({ features: [
    tc('Tropical Cyclone CEMPAKA-26', 'true', 'Green', 175.92, [150.2, 29.1]),
    tc('Tropical Cyclone MURASU-26', 'false', 'Red', 157.4, [80.2, 15.8]),          // ended: left out
    tc('Tropical Cyclone 02-20262027-27', 'true', 'Red', 63.3, [50.54, -11.8]),
    { properties: { eventtype: 'EQ', name: 'not a cyclone', iscurrent: 'true' }, geometry: { coordinates: [1, 2] } },
  ] }))
  expect(got.map(e => [e.kind, e.title, e.mag, e.alert, e.at])).toEqual([
    ['cyclone', 'Cempaka · winds to 176 km/h', 176, 0, Date.UTC(2026, 10, 11, 6)],
    ['cyclone', 'unnamed cyclone · winds to 63 km/h · red alert', 63, 2, Date.UTC(2026, 10, 11, 6)],
  ])
  const storm = (title: string, lon: number, lat: number) => ({ kind: 'storm' as const, source: 'eonet', title, at: 1, lon, lat, placed: true, exact: true, mag: 0, alert: 0 })
  expect(settle([...got, storm('Typhoon Cempaka', 146.7, 27.7), storm('Tropical Storm Pena', -165.6, 10.5)]).map(e => e.title)).toEqual(['Cempaka · winds to 176 km/h', 'unnamed cyclone · winds to 63 km/h · red alert', 'Tropical Storm Pena'])
  expect(settle([storm('Typhoon Cempaka', 146.7, 27.7)]).length).toBe(1)             // GDACS silent: the storm stays
})

test('each kind has its sign on the map, and a cyclone on red alert takes the quake\'s red', () => {
  const at = (kind: 'volcano' | 'cyclone', lon: number, alert: number) => ({ kind, source: 'x', title: kind, at: 1, lon, lat: 0, placed: true, exact: true, mag: 0, alert })
  const got = draw(80, 14, [at('volcano', -90, 0), at('cyclone', 60, 0), at('cyclone', 120, 2)], Date.UTC(2026, 2, 20, 12, 0))
  const cells = got.flatMap(row => row.flatMap(run => [...run.text].map(glyph => ({ glyph, tone: run.tone }))))
  expect(cells.filter(c => c.glyph === '▲').map(c => c.tone)).toEqual([7])
  expect(cells.filter(c => c.glyph === '@').map(c => c.tone)).toEqual([7, 8])
})

test('a headline goes to the country it names first, as a whole word, and nowhere when it names none', () => {
  expect(locate('Russia expels Moldovan diplomat in tit-for-tat move')).toEqual({ lon: 37.6, lat: 55.75 })
  expect(locate('Fighting resumes in South Sudan')).toEqual({ lon: 31.6, lat: 4.85 })        // not Sudan
  expect(locate('Nigerian court frees journalist')).toEqual({ lon: 7.5, lat: 9.1 })          // not Niger
  expect(locate('U.S. charges three over plot')).toEqual({ lon: -77, lat: 38.9 })
  expect(locate('Trump ally Jim Jordan elected House Republican leader')).toBeUndefined()    // a person, not the kingdom
  expect(locate('Focus on the business of music')).toBeUndefined()                           // "us" inside a word, in small letters
})

test('a press feed gives its headlines in plain text, CDATA and entities undone', () => {
  const xml = `<rss><channel><title>The feed itself</title>
    <item><title><![CDATA[Japan's PM calls snap election]]></title><pubDate>Tue, 10 Nov 2026 23:10:00 GMT</pubDate></item>
    <item><title>Markets &amp; rates &#8211; a calm week</title><pubDate>Tue, 10 Nov 2026 22:00:00 GMT</pubDate></item>
    <item><title></title></item></channel></rss>`
  const got = parsePress('bbc', xml)
  expect(got.map(e => [e.title, e.placed, e.exact, e.lon])).toEqual([["Japan's PM calls snap election", true, false, 139.7], ['Markets & rates – a calm week', false, false, 0]])
  expect(got[0]?.at).toBe(Date.UTC(2026, 10, 10, 23, 10))
  expect(plain('  a &quot;b&quot;\n c ')).toBe('a "b" c')
})

test('only a strong quake that was not in the reading before gets a word', () => {
  const quake = (mag: number, where: string) => ({ kind: 'quake' as const, source: 'usgs', title: `M ${mag} · ${where}`, at: 1, lon: 0, lat: 0, placed: true, exact: true, mag, alert: 0 })
  const before = { events: [quake(7.1, 'Tonga')], failed: [], at: 5 }
  const now = { events: [quake(7.1, 'Tonga'), quake(6.8, 'Chile'), quake(5.2, 'Crete')], failed: [], at: 9 }
  expect(newlyStrong(before, now).map(e => e.title)).toEqual(['M 6.8 · Chile'])
  expect(newlyStrong({ events: [], failed: [], at: 0 }, now)).toEqual([])      // the first reading: nothing to compare with
})

test('the map keeps its proportions in the room it is given, and is bright by day, dim by night', () => {
  expect(size(53, 140)).toEqual({ wide: 138, tall: 24 })                       // a full screen: the whole width
  expect(size(20, 140)).toEqual({ wide: 80, tall: 14 })                        // a low pane: narrowed, not flattened
  const noon = Date.UTC(2026, 2, 20, 12, 0)                                    // the equinox, noon in Greenwich
  const got = draw(80, 14, [
    { kind: 'quake', source: 'usgs', title: 'M 6 · under the sun', at: 2, lon: 0, lat: 0, placed: true, exact: true, mag: 6, alert: 0 },
    { kind: 'news', source: 'bbc', title: 'Japan', at: 1, lon: 139.7, lat: 35.7, placed: true, exact: false, mag: 0, alert: 0 },
    { kind: 'news', source: 'bbc', title: 'nowhere', at: 3, lon: 0, lat: 0, placed: false, exact: false, mag: 0, alert: 0 },
  ], noon)
  expect([got.length, got[0]?.reduce((n, run) => n + run.text.length, 0)]).toEqual([14, 80])
  const cells = got.flatMap(row => row.flatMap(run => [...run.text].map(glyph => ({ glyph, tone: run.tone }))))
  expect(cells.filter(c => c.glyph === '◉').map(c => c.tone)).toEqual([8])     // the quake, where it was, under its sign
  expect(cells.filter(c => c.glyph === '○').map(c => c.tone)).toEqual([6])     // the headline, on its country; the unplaced one is not drawn
  const column = (x: number): number[] => got.map(row => { let seen = 0; for (const run of row) { if (x < seen + run.text.length) return run.tone; seen += run.text.length } return 0 })
  expect(column(40).every(tone => tone !== 1 && tone !== 4)).toBe(true)        // Greenwich at noon: nothing in the night's tones
  expect(column(2).every(tone => tone !== 2 && tone !== 5)).toBe(true)         // the date line: nothing in the day's
  expect(cells.some(c => c.tone === 3)).toBe(true)                             // the line between the two is drawn
})

test('the headlines run past from the right, one column a step, and come round again', () => {
  const news = (source: string, title: string, placed: boolean) => ({ kind: 'news' as const, source, title, at: 1, lon: 0, lat: 0, placed, exact: false, mag: 0, alert: 0 })
  const cells = tape([news('bbc', 'Ab', true), news('alj', 'Cd', false)])
  expect(cells.map(c => c.glyph).join('')).toBe('○ BBC Ab   ·   ALJ Cd   ·   ')
  const text = (steps: number): string => ticker(cells, 10, steps).map(run => run.text).join('')
  expect([text(0), text(3), text(10), text(cells.length + 10)]).toEqual(['          ', '       ○ B', '○ BBC Ab  ', '○ BBC Ab  '])
  expect(ticker(cells, 10, 10).map(run => run.tone)).toEqual([3, 1, 2, 0])      // the mark, the feed, the headline, the gap
  expect(ticker([], 10, 4)).toEqual([])                                        // no headline: no row
})
