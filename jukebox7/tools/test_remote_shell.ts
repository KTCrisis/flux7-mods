// jukebox7's remote branch, run for real: the song written for the phone, the
// wait for its end, the pause flag, the clearing on halt. The plugin tests
// (hooks/*.test.ts) mock every process, so this script is checked here.
//
//     node --experimental-strip-types --test jukebox7/tools/test_remote_shell.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { drainArgv, parseJukebox, pauseScript, REMOTE, statusArgv } from '../hooks/remote.ts'

const ID = 'DRFHklnN-SM'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('with the relay held, a song is written for the phone, waits for its end, and clears on halt', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jukebox7-remote-'))
  const R = join(home, 'avatar7', 'relay')
  mkdirSync(R, { recursive: true })
  writeFileSync(join(R, 'owner'), 'session')
  const env = { ...process.env, XDG_CACHE_HOME: home }
  // As startArgv runs it: detached in a group of its own, the group id back.
  const start = () => spawnSync('bash', ['-c', `setsid bash -c '${REMOTE}echo local' _ "$1" </dev/null >/dev/null 2>&1 & echo $!`, '_', ID], { env, encoding: 'utf8' }).stdout.trim()
  const alive = (pg: string) => spawnSync('kill', ['-0', '--', `-${pg}`]).status === 0
  const music = () => JSON.parse(readFileSync(join(R, 'music.json'), 'utf8'))
  try {
    let pg = start()
    await sleep(1200)
    assert.deepEqual(music(), { id: ID, paused: false })
    assert.ok(alive(pg), 'it waits while the phone plays')
    spawnSync('sh', ['-c', pauseScript(true), '_', 'false'], { env })
    assert.deepEqual(music(), { id: ID, paused: true })
    writeFileSync(join(R, `ended-${ID}`), '')
    await sleep(1600)
    assert.deepEqual([alive(pg), existsSync(join(R, `ended-${ID}`)), music()], [false, false, {}])
    pg = start()
    await sleep(1200)
    spawnSync('kill', ['-TERM', '--', `-${pg}`])
    await sleep(500)
    assert.deepEqual(music(), {})
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('without the relay, the pipeline plays here, and pause goes to VLC', () => {
  const home = mkdtempSync(join(tmpdir(), 'jukebox7-local-'))
  const env = { ...process.env, XDG_CACHE_HOME: home }
  try {
    const out = spawnSync('bash', ['-c', `${REMOTE}echo local`, '_', ID], { env, encoding: 'utf8' }).stdout
    assert.equal(out.trim(), 'local')
    const p = spawnSync('sh', ['-c', pauseScript(true), '_', 'echo', 'curl'], { env, encoding: 'utf8' }).stdout
    assert.equal(p.trim(), 'curl')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the phone may only press the jukebox controls and its own genres', () => {
  const genres = ['ambient', 'lofi']
  assert.deepEqual(parseJukebox('{"do":"next"}', genres), { do: 'next' })
  assert.deepEqual(parseJukebox('{"do":"genre","genre":"lofi"}', genres), { do: 'genre', genre: 'lofi' })
  assert.equal(parseJukebox('{"do":"genre","genre":"rm -rf"}', genres), undefined)
  assert.equal(parseJukebox('{"do":"vlc"}', genres), undefined)
  assert.equal(parseJukebox('not json', genres), undefined)
})

test('presses queued by the relay are read once, and the status is written only while the relay is held', () => {
  const home = mkdtempSync(join(tmpdir(), 'jukebox7-drain-'))
  const R = join(home, 'avatar7', 'relay')
  mkdirSync(join(R, 'jukebox'), { recursive: true })
  const env = { ...process.env, XDG_CACHE_HOME: home }
  const run = (argv: string[], input = '') => spawnSync(argv[0] ?? '', argv.slice(1), { env, input, encoding: 'utf8' }).stdout
  try {
    writeFileSync(join(R, 'jukebox', '1.json'), '{"do":"next"}')
    writeFileSync(join(R, 'jukebox', '2.json'), '{"do":"pause"}')
    assert.deepEqual(run(drainArgv()).trim().split('\n'), ['{"do":"next"}', '{"do":"pause"}'])
    assert.equal(run(drainArgv()).trim(), '')
    run(statusArgv(), '{"title":"x"}')
    assert.equal(existsSync(join(R, 'jukebox.json')), false)
    writeFileSync(join(R, 'owner'), 'session')
    run(statusArgv(), '{"title":"x"}')
    assert.equal(readFileSync(join(R, 'jukebox.json'), 'utf8'), '{"title":"x"}')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
