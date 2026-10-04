import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'
import { pauseArgv, parseIntent, pickTrack, startArgv, killVlcArgv, detachedKillVlcArgv, progress, isSong, GENRES, volumeArgv, duckArgv, DUCK, buttonRows, isCandidate, durationArgv, clampVolume, rain, musicSearch, parseTracks, parseRadio, introEvent } from './register'

const RESULTS = [
  'DRFHklnN-SM\tTranquility - Deep Healing Ambient\t420',
  'A8ChCZExAsw\tThe Aero Skyway - Aero Ambient\t12000',
].join('\n')

// The engine beneath: Haiku answers `intent`, yt-dlp the results above, the
// detached pipeline its process group 4242, the shell `kind` as
// CLAUDE_CODE_SESSION_KIND, and every command line is kept.
const engine = (on: On, intent: string, kind = ''): { argv: string[][]; toasts: string[]; say: (next: string) => void } => {
  const said = { intent }
  const argv: string[][] = []
  const toasts: string[] = []
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: said.intent, usage: {} } }) as never)
  on('process.run', ($, e) => {
    const a = [...(e as { argv: string[] }).argv]
    argv.push(a)
    const stdout = a[0] === 'yt-dlp' ? RESULTS : a[0] === 'bash' ? '4242\n' : a[0] === 'sh' ? kind : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('clock.now', () => ({ value: 1_000_000 }) as never)
  on('ui.status', () => undefined)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  return { argv, toasts, say: next => (said.intent = next) }
}

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never

test('a prompt without a music word reaches the session untouched', async ($, on) => {
  const { argv } = engine(on, '{"action":"play","query":"x","long":true}')
  const r = await $.prompt.submit(typed('refactor the mesh7 pane'))
  expect(r.text).toBe('refactor the mesh7 pane')
  expect(argv).toEqual([])
})

test('asking for ambient plays the first song of five to twenty minutes through a hidden VLC, no browser', async ($, on) => {
  const { argv, toasts } = engine(on, '{"action":"play","query":"ambient music","long":true}')
  const r = await $.prompt.submit(typed('joue moi un peu de musique ambient'))
  expect(r.drop).toContain('Tranquility')
  expect(argv[0]?.at(-1)).toBe('ytsearch8:ambient music')
  expect(argv[1]).toEqual(startArgv('DRFHklnN-SM'))
  expect(argv[1]?.[2]).toContain('vlc.exe')
  expect(toasts).toEqual(['music now playing: Tranquility - Deep Healing Ambient'])
})

test('a second request stops the first pipeline and its VLC before starting', async ($, on) => {
  const { argv } = engine(on, '{"action":"play","query":"ambient music","long":true}')
  await $.prompt.submit(typed('joue moi un peu de musique ambient'))
  await $.prompt.submit(typed('mets de la musique ambient'))
  expect(argv).toContainEqual(['kill', '-TERM', '--', '-4242'])
  expect(argv).toContainEqual(killVlcArgv)
})

test('pause asks VLC to pause, stop ends the group and its VLC', async ($, on) => {
  const { argv, say } = engine(on, '{"action":"play","query":"ambient music","long":true}')
  await $.prompt.submit(typed('joue moi un peu de musique ambient'))
  say('{"action":"toggle"}')
  const paused = await $.prompt.submit(typed('pause la musique'))
  expect(paused.drop).toContain('paused')
  expect(argv).toContainEqual(pauseArgv(true))
  say('{"action":"stop"}')
  await $.prompt.submit(typed('coupe la musique'))
  expect(argv.slice(-3)).toEqual([['kill', '-CONT', '--', '-4242'], ['kill', '-TERM', '--', '-4242'], killVlcArgv])
})

test('Haiku saying none lets the prompt through', async ($, on) => {
  const { argv } = engine(on, '{"action":"none"}')
  const r = await $.prompt.submit(typed('joue ce motif dans Renoise'))
  expect(r.text).toBe('joue ce motif dans Renoise')
  expect(argv).toEqual([])
})

test('a control word with nothing playing sends no signal and reaches the assistant', async ($, on) => {
  const { argv } = engine(on, '{"action":"stop"}')
  const r = await $.prompt.submit(typed('stop'))
  expect(r.drop).toBeUndefined()
  expect(r.text).toBe('stop')
  expect(argv).toEqual([])
})

test('parseIntent, pickTrack and the genre hotkeys', () => {
  expect(parseIntent('sure: {"action":"next"}')).toEqual({ action: 'next' })
  expect(parseIntent('{"action":"stop"}')).toEqual({ action: 'stop' })
  expect(parseIntent('{"action":"play","query":" "}')).toEqual({ action: 'none' })
  expect(pickTrack(RESULTS, false)?.id).toBe('DRFHklnN-SM')
  expect(pickTrack('abc\tbad id\t3', true)).toBe(undefined)
  expect(pickTrack(RESULTS, true)?.id).toBe('DRFHklnN-SM')
  expect(isSong({ id: 'x', title: 'mix', seconds: 12000 })).toBe(false)
  expect(new Set(GENRES.map(g => g.key)).size).toBe(GENRES.length)
})

test('leaving the session ends the pipeline and detaches the VLC kill', async ($, on) => {
  const { argv } = engine(on, '{"action":"play","query":"ambient music","long":true}')
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  await $.prompt.submit(typed('joue moi un peu de musique ambient'))
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's', resume: { id: 's' } } as never)
  expect(argv).toContainEqual(['kill', '-TERM', '--', '-4242'])
  expect(argv.at(-1)).toEqual(detachedKillVlcArgv)
})

test('the progress bar fills with the elapsed time and holds still while paused', () => {
  const p = { tracks: [], index: 0, pgid: 1, isPlaying: true, genre: null, startedAt: 0, pausedAt: null }
  expect(progress(p, 210_000, 420)).toEqual({ done: '▰'.repeat(6), left: '▱'.repeat(6), time: '03:30 / 07:00' })
  expect(progress({ ...p, isPlaying: false, pausedAt: 60_000 }, 400_000, 420).time).toBe('01:00 / 07:00')
  expect(progress(p, 90_000, null)).toEqual({ done: '', left: '', time: '01:30' })
  expect(progress(p, 999_000, 420).left).toBe('')
})

test('each start sets the kept volume again, once VLC listens', async ($, on) => {
  const { argv } = engine(on, '{"action":"play","query":"ambient music","long":true}')
  await $.prompt.submit(typed('joue moi un peu de musique ambient'))
  expect(argv[1]?.[2]).toContain('--extraintf http')
  expect(argv[2]?.slice(3)).toEqual(volumeArgv(70, true))
})

test('louder and quieter move the volume by steps, kept within 0 and 125', async ($, on) => {
  const { argv, say } = engine(on, '{"action":"play","query":"ambient music","long":true}')
  await $.prompt.submit(typed('joue moi un peu de musique ambient'))
  say('{"action":"volume","delta":20}')
  const r = await $.prompt.submit(typed('monte le son'))
  expect(r.drop).toBe('jukebox7: volume 90%')
  expect(argv.at(-1)).toEqual(volumeArgv(90))
  expect((await $.command.run({ command: 'music', args: 'vol 200' })).text).toBe('Volume 125%.')
  expect((await $.command.run({ command: 'music', args: 'vol -130' })).text).toBe('Volume 0%.')
  expect(volumeArgv(125).at(-1)).toContain('val=320')
  expect(clampVolume(-5)).toBe(0)
})

test('the code rain fills the given size, one glyph per cell, every other column blank', () => {
  const grid = rain(20, 8, 5)
  expect(grid).toHaveLength(8)
  for (const runs of grid) {
    const line = runs.map(r => r.text).join('')
    expect([...line]).toHaveLength(20)
    expect([...line].filter((_, c) => c % 2 === 1).every(ch => ch === ' ')).toBe(true)
  }
  expect(grid.flat().some(r => r.level === 2)).toBe(true)
})

test('a station pick searches the songs tab of YouTube Music, query encoded', () => {
  const argv = musicSearch('Mark Morgan Planescape Torment')
  expect(argv.at(-1)).toBe('https://music.youtube.com/search?q=Mark%20Morgan%20Planescape%20Torment#songs')
  expect(parseTracks('q_0Rgrl0zLw\tDeionarra\'s Theme\tNA')).toEqual([{ id: 'q_0Rgrl0zLw', title: "Deionarra's Theme", seconds: null }])
})

test('the radio puts other artists first and drops the song itself and the covers', () => {
  const out = [
    '68qcaxPr68A\tSpirit Warrior\t319\tFixions - Topic',
    'Ss2JVFHlZRU\tSacrifice\t258\tFixions - Topic',
    'HRsC2g79V3Y\tFuture Club\t290\tPerturbator',
    'aaaaaaaaaaa\tThe Streets of Whiterun\t200\tCelestial Aeon Project celtic music & epic music',
    'bbbbbbbbbbb\tNightcall (Piano Cover)\t240\tSomeone',
    'ccccccccccc\tCity Forgotten\t282\tStraplocked - Topic',
  ].join('\n')
  expect(parseRadio(out).map(t => t.title)).toEqual(['Perturbator - Future Club', 'Straplocked - City Forgotten', 'Fixions - Sacrifice'])
})

test('every genre carries discoveries, none of them already in its own list', () => {
  for (const g of GENRES) {
    expect((g.discover ?? []).length).toBeGreaterThan(0)
    expect((g.discover ?? []).filter(a => g.artists.includes(a))).toEqual([])
  }
})

test('a background session (a daemon spare) turns no prompt into a song', async ($, on) => {
  const { argv, toasts } = engine(on, '{"action":"play","query":"ambient music","long":true}', 'bg')
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/home/u' } as never)
  const r = await $.prompt.submit(typed('joue moi un peu de musique ambient'))
  expect(r.text).toBe('joue moi un peu de musique ambient')
  expect(argv.filter(a => a[0] !== 'sh')).toEqual([])
  expect(toasts).toEqual([])
})

test('while avatar7 speaks the music drops to a share of its level, then returns to it', () => {
  expect(duckArgv(80, true)).toEqual(volumeArgv(80 * DUCK))
  expect(duckArgv(80, false)).toEqual(volumeArgv(80))
  expect(DUCK).toBeLessThan(1)
})

test('the controls wrap on a narrow pane, and the rows they take are counted', () => {
  const controls = ['pause', 'next', 'similar', 'stop', 'vol−', 'vol+']
  expect(buttonRows(controls, 60)).toBe(1)
  // 44 columns: `u: vol+` goes to a second row.
  expect(buttonRows(controls, 44)).toBe(2)
  expect(buttonRows(controls, 20)).toBeGreaterThan(2)
})

test('the sieve keeps short music commands and lets talk through', () => {
  for (const cmd of ['joue moi un peu de musique ambient', 'pause', 'next', 'monte le son', 'baisse le son', 'plus fort', 'mets du lofi', 'stop the music', 'volume 40', 'joue I Was Born des Unicorns', 'mets des Daft Punk']) {
    expect(isCandidate(cmd)).toBe(true)
  }
  for (const talk of [
    'refactor the mesh7 pane',
    'oui, pousse et baisse la musique quand l avatar parle sinon on entend rien',
    'son code est trop fort pour moi',
    'mets le fichier dans le dossier',
    'lance les tests',
    'oui push',
  ]) {
    expect(isCandidate(talk)).toBe(false)
  }
})

test('a track listed without duration asks yt-dlp for its own, for the progress bar', async ($, on) => {
  const argv: string[][] = []
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"action":"play","query":"I Was Born","long":false}', usage: {} } }) as never)
  on('process.run', ($, e) => {
    const a = [...(e as { argv: string[] }).argv]
    argv.push(a)
    const stdout =
      a[0] !== 'yt-dlp' ? (a[0] === 'bash' ? '4242\n' : '') : a.includes('--skip-download') ? '245\n' : 'e9OLLTKryiA\tI Was Born (A Unicorn)\tNA'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('clock.now', () => ({ value: 1_000_000 }) as never)
  on('ui.status', () => undefined)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => undefined)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await $.prompt.submit(typed('joue I Was Born des Unicorns'))
  expect(argv).toContainEqual(durationArgv('e9OLLTKryiA'))
})

test('each song that starts is handed to avatar7 to introduce, by say, without the discovery mark', async ($, on) => {
  engine(on, '{"action":"play","query":"ambient music","long":true}')
  const says: { mood: string; event: string }[] = []
  on('state.set', ($, e, next) => {
    const w = e as { plugin: string; key: string; value: { mood: string; event: string } }
    if (w.plugin === 'jukebox7' && w.key === 'say') says.push(w.value)
    return next(e)
  })
  await $.prompt.submit(typed('joue moi un peu de musique ambient'))
  expect(says).toEqual([{ mood: 'watch', event: introEvent('Tranquility - Deep Healing Ambient'), at: expect.any(Number) } as never])
  expect(introEvent('✦ Grimes - Oblivion')).toContain('"Grimes - Oblivion"')
})

test('a session that never played leaves the VLC alone when it ends', async ($, on) => {
  const { argv } = engine(on, '{"action":"none"}')
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's', resume: { id: 's' } } as never)
  expect(argv).not.toContainEqual(detachedKillVlcArgv)
})

test('next past the last result ends the list instead of wrapping to the first', async ($, on) => {
  const { argv } = engine(on, '{"action":"play","query":"ambient music","long":true}')
  await $.prompt.submit(typed('joue moi un peu de musique ambient'))
  const r = await $.command.run({ command: 'music', args: 'next' })
  expect(r.text).toContain('Aero Skyway')
  const end = await $.command.run({ command: 'music', args: 'next' })
  expect(end.text).toBe('End of the list.')
  expect(argv.filter(a => a[0] === 'bash' && a.at(-1) === 'DRFHklnN-SM')).toHaveLength(1)
})
