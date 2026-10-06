// The relay's shell, run for real: each argv relay.ts builds goes to sh or
// bash against a spool of its own. The plugin tests (hooks/*.test.ts) mock
// every process, so these scripts are checked here.
//
//     node --experimental-strip-types --test avatar7/tools/test_relay_shell.ts

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

import { aliveArgv, claimArgv, drainArgv, forgetArgv, heldArgv, latestArgv, mirrorArgv, playArgv, promptedArgv, releaseArgv, startArgv, takeArgv, wantedArgv } from '../hooks/relay.ts'

let home = ''
let spool = ''
// A process that lives for the test: its pid stands for a running relay.
let live: ReturnType<typeof spawn> | null = null

const run = (argv: string[], stdin = ''): string => {
  const [cmd = '', ...args] = argv
  const r = spawnSync(cmd, args, { input: stdin, env: { ...process.env, XDG_CACHE_HOME: home }, encoding: 'utf8' })
  return r.stdout
}
const relayRunning = (owner: string, pid: number) => {
  mkdirSync(spool, { recursive: true })
  writeFileSync(join(spool, 'owner'), owner)
  writeFileSync(join(spool, 'relay.pid'), String(pid))
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'avatar7-relay-'))
  spool = join(home, 'avatar7', 'relay')
  live = spawn('sleep', ['30'])
})
afterEach(() => {
  live?.kill()
  rmSync(home, { recursive: true, force: true })
})

test('a session holds the relay only when it is the owner and the relay lives', () => {
  relayRunning('me', live?.pid ?? 0)
  assert.equal(run(heldArgv('me')).trim(), 'up')
  assert.equal(run(heldArgv('other')).trim(), '')
  // A relay killed without cleaning up left its spool: nobody holds it.
  relayRunning('me', 2 ** 22 + 7)
  assert.equal(run(heldArgv('me')).trim(), '')
  assert.equal(run(aliveArgv()).trim(), '')
})

test('taking needs a spool; giving back is the owner\'s alone and leaves the page an empty face', () => {
  assert.equal(run(takeArgv('me')), '')
  assert.equal(existsSync(spool), false)
  relayRunning('other', live?.pid ?? 0)
  run(releaseArgv('me'))
  assert.equal(readFileSync(join(spool, 'owner'), 'utf8'), 'other')
  run(takeArgv('me'))
  assert.equal(readFileSync(join(spool, 'owner'), 'utf8'), 'me')
  run(releaseArgv('me'))
  assert.equal(existsSync(join(spool, 'owner')), false)
  assert.equal(readFileSync(join(spool, 'state.json'), 'utf8'), '{}')
})

test('only the owner mirrors its face to the page, written whole', () => {
  relayRunning('other', live?.pid ?? 0)
  run(mirrorArgv('me'), '{"persona":"nova"}')
  assert.equal(existsSync(join(spool, 'state.json')), false)
  relayRunning('me', live?.pid ?? 0)
  run(mirrorArgv('me'), '{"persona":"nova"}')
  assert.equal(readFileSync(join(spool, 'state.json'), 'utf8'), '{"persona":"nova"}')
  assert.equal(existsSync(join(spool, 'state.part')), false)
})

test('the page\'s presses come out one per line, in order, and are gone once read', () => {
  mkdirSync(join(spool, 'cmd'), { recursive: true })
  writeFileSync(join(spool, 'cmd', '1000.json'), '{"cmd":"talk"}')
  writeFileSync(join(spool, 'cmd', '2000.json'), '{"cmd":"mute"}')
  writeFileSync(join(spool, 'cmd', '3000.part'), 'half')
  assert.deepEqual(run(drainArgv()).trim().split('\n'), ['{"cmd":"talk"}', '{"cmd":"mute"}'])
  assert.deepEqual(readdirSync(join(spool, 'cmd')), ['3000.part'])
  assert.equal(run(drainArgv()), '')
})

test('a line goes to the spool when held, to the host otherwise; its WAV is removed either way', () => {
  const wav = join(home, 'line.wav')
  const marker = join(home, 'played-here')
  const local = `printf %s "$1" > "${marker}"`
  relayRunning('me', live?.pid ?? 0)
  writeFileSync(wav, 'RIFF')
  run(playArgv(wav, 'me', local))
  assert.equal(existsSync(wav), false)
  assert.equal(existsSync(marker), false)
  const sent = readdirSync(spool).filter(f => /^\d+\.(ogg|wav)$/.test(f))
  assert.equal(sent.length, 1)
  writeFileSync(wav, 'RIFF')
  run(playArgv(wav, 'other', local))
  assert.equal(existsSync(wav), false)
  assert.equal(readFileSync(marker, 'utf8'), wav)
})

test('starting the relay clears a stale spool and runs tools/relay.py from the plugin, detached', async () => {
  relayRunning('ghost', 2 ** 22 + 7)
  const root = join(home, 'plugin')
  mkdirSync(join(root, 'tools'), { recursive: true })
  const started = join(home, 'started')
  writeFileSync(join(root, 'tools', 'relay.py'), `open(${JSON.stringify(started)}, "w").write("yes")\n`)
  run(startArgv(root))
  assert.equal(existsSync(join(spool, 'owner')), false)
  for (let i = 0; i < 50 && !existsSync(started); i++) await new Promise(r => setTimeout(r, 50))
  assert.equal(readFileSync(started, 'utf8'), 'yes')
})

test('wanted reads up only while the marker is there and the relay lives', () => {
  relayRunning('a', live?.pid ?? 0)
  assert.equal(run(wantedArgv()).trim(), '')
  writeFileSync(join(spool, 'wanted'), '')
  assert.equal(run(wantedArgv()).trim(), 'up')
  writeFileSync(join(spool, 'relay.pid'), '999999')
  assert.equal(run(wantedArgv()).trim(), '')
})

test('a claim takes a free relay and leaves a held one to its owner', () => {
  mkdirSync(spool, { recursive: true })
  writeFileSync(join(spool, 'relay.pid'), String(live?.pid ?? 0))
  run(claimArgv('a'))
  assert.equal(readFileSync(join(spool, 'owner'), 'utf8'), 'a')
  run(claimArgv('b'))
  assert.equal(readFileSync(join(spool, 'owner'), 'utf8'), 'a')
  rmSync(spool, { recursive: true, force: true })
  run(claimArgv('c'))
  assert.equal(existsSync(join(spool, 'owner')), false)
})

test('the session prompted last is the latest; one that ends leaves the list; no spool, no mark', () => {
  assert.equal(run(latestArgv()).trim(), '')
  run(promptedArgv('a'))
  assert.equal(existsSync(join(spool, 'active')), false)
  mkdirSync(spool, { recursive: true })
  run(promptedArgv('a'))
  spawnSync('sleep', ['0.02'])
  run(promptedArgv('b'))
  assert.equal(run(latestArgv()).trim(), 'b')
  spawnSync('sleep', ['0.02'])
  run(promptedArgv('a'))
  assert.equal(run(latestArgv()).trim(), 'a')
  run(forgetArgv('a'))
  assert.equal(run(latestArgv()).trim(), 'b')
})
