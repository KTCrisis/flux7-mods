import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'
import { parseIntent, pickTrack, startArgv, killVlcArgv, isSong, GENRES } from './register'

const RESULTS = [
  'DRFHklnN-SM\tTranquility - Deep Healing Ambient\t420',
  'A8ChCZExAsw\tThe Aero Skyway - Aero Ambient\t12000',
].join('\n')

// The engine beneath: Haiku answers `intent`, yt-dlp the results above, the
// detached pipeline its process group 4242, and every command line is kept.
const engine = (on: On, intent: string): { argv: string[][]; toasts: string[]; say: (next: string) => void } => {
  const said = { intent }
  const argv: string[][] = []
  const toasts: string[] = []
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: said.intent, usage: {} } }) as never)
  on('process.run', ($, e) => {
    const a = [...(e as { argv: string[] }).argv]
    argv.push(a)
    const stdout = a[0] === 'yt-dlp' ? RESULTS : a[0] === 'bash' ? '4242\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
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

test('pause stops the group, stop resumes then ends it', async ($, on) => {
  const { argv, say } = engine(on, '{"action":"play","query":"ambient music","long":true}')
  await $.prompt.submit(typed('joue moi un peu de musique ambient'))
  say('{"action":"toggle"}')
  const paused = await $.prompt.submit(typed('pause la musique'))
  expect(paused.drop).toContain('paused')
  expect(argv).toContainEqual(['kill', '-STOP', '--', '-4242'])
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

test('pause sends no signal when nothing was started here', async ($, on) => {
  const { argv } = engine(on, '{"action":"toggle"}')
  const r = await $.prompt.submit(typed('coupe la musique'))
  expect(r.drop).toContain('nothing is playing')
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
