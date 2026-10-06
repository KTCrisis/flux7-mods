import type { On } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'
import { addUsage, parseSpend, priced } from './register'

// The engine beneath the plugin: it echoes measurements and keeps the toasts.
const engine = (on: On): string[] => {
  const toasts: string[] = []
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  return toasts
}

const measure = (percent: number, used = 10) => ({
  context: { percent, tokens: percent * 10_000, window: 1_000_000 },
  rateLimits: [{ kind: 'five_hour', percentUsed: used }],
  changed: ['context' as const],
})

test('context rings once per threshold, again after it falls back', async ($, on) => {
  const toasts = engine(on)

  await $.session.measure(measure(50))
  await $.session.measure(measure(72))
  await $.session.measure(measure(74))
  await $.session.measure(measure(88))
  expect(toasts).toEqual(['context 72% full (720k of 1000k)', 'context 88% full (880k of 1000k)'])

  // A compaction: down to 20 %, the steps arm again.
  await $.session.measure(measure(20))
  await $.session.measure(measure(71))
  expect(toasts.length).toBe(3)
})

test('a rate-limit window rings at 80 and 95', async ($, on) => {
  const toasts = engine(on)

  await $.session.measure(measure(10, 79))
  await $.session.measure(measure(10, 81))
  await $.session.measure(measure(10, 96))
  expect(toasts).toEqual(['5h rate limit 81% used', '5h rate limit 96% used'])
})

test('/usage7 reports the last reading', async ($, on) => {
  engine(on)
  await $.session.measure(measure(42, 30))
  const r = await $.command.run({ command: 'usage7', args: '' })
  expect(r.text).toContain('context: 42%')
  expect(r.text).toContain('5h: 30%')
})

test('the memory index rings near its limit, then once it is cut', async ($, on) => {
  const toasts = engine(on)
  const clock = mock.clock(on)
  const INDEX = '/home/u/.claude/projects/p/memory/MEMORY.md'
  let index = 'line\n'.repeat(150)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: { window: 1_000_000, breakdown: { memoryFiles: [{ path: INDEX, type: 'AutoMem', tokens: 1 }] } },
    },
  }) as never)
  on('fs.read', () => ({ value: index }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)

  await $.session.start({ cwd: '/home/u' } as never)
  await clock.advance(2_000)
  expect(toasts).toEqual([])

  index = 'line\n'.repeat(185)
  await $.tool.call({ tool: 'Edit', file_path: INDEX, old_string: 'a', new_string: 'b' } as never)
  await clock.advance(2_000)
  index = 'line\n'.repeat(201)
  await $.tool.call({ tool: 'Write', file_path: INDEX, content: index } as never)
  await clock.advance(2_000)
  expect(toasts).toEqual([
    'memory index near its limit: 185/200 lines, 1/25 kB',
    'memory index is cut at load: 201 lines, 1005 bytes (limit 200 / 25000)',
  ])
})

test('the readings ride dim at the end of the hint line', async ($, on) => {
  engine(on)
  let tail: string | undefined
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    tail = e.props.tail
    const { Text } = $.ui.resolve(e)
    return h(Text, null, e.props.hint)
  })

  await $.session.measure(measure(42, 30))
  await $.ui.render({
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
  } as never)
  expect(tail).toBe(' · ctx 42% · 5h 30%')
})

test('/usage7 test rings a sample toast under usage-bell, which avatar7 voices', async ($, on) => {
  const origins: string[] = []
  on('ui.toast', ($, e, next) => {
    origins.push(next.origin.plugin)
    return { value: undefined } as never
  })
  const r = await $.command.run({ command: 'usage7', args: 'test' })
  expect(r.text).toBe('test ring sent.')
  expect(origins).toEqual(['usage-bell'])
})

test('session start publishes its announce for avatar7, as a warning', async ($, on) => {
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('session.usage', () => {
    throw new Error('no breakdown')
  })
  const writes: { plugin: string; key: string; value: { mood: string } }[] = []
  on('state.set', ($, e) => {
    writes.push(e as never)
    return { value: { isSet: true, version: 1 } } as never
  })
  await $.session.start({ cwd: '/home/u' } as never)
  const announce = writes.find(w => w.plugin === 'usage-bell' && w.key === 'announce')
  expect(announce?.value.mood).toBe('error')
})

const SPEND = JSON.stringify({
  ok: true,
  total: { today: 6.2, yesterday: 11.08, month: 43.11 },
  workspaces: { hoshi7: { today: 4.1, yesterday: 0, month: 4.1 }, Default: { today: 2.1, yesterday: 11.08, month: 39.01 } },
})

// A session that starts: ops7 answers `spend`, the model answers each call
// with `usage`, and the commands and toasts are kept.
const started = async ($: never, on: On, spend: string) => {
  const toasts = engine(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('state.set', () => ({ value: { isSet: true } }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('session.usage', () => {
    throw new Error('no breakdown here')
  })
  on('process.run', ($, e) => {
    const a = (e as { argv: string[] }).argv
    return { value: { exitCode: a[0] === 'curl' ? 0 : 1, stdout: a[0] === 'curl' ? spend : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('ui.invalidate', () => ({ value: undefined }) as never)
  mock.clock(on)
  await ($ as any).session.start({ cwd: '/home/u' })
  return toasts
}

test('a model call is priced as the API would: Haiku 1 and 5 dollars a million, a cache read a tenth', () => {
  expect(priced('claude-haiku-4-5', { input_tokens: 1_000_000, output_tokens: 0 })).toBe(1)
  expect(Math.round(priced('claude-haiku-4-5', { input_tokens: 0, output_tokens: 200_000, cache_read_input_tokens: 1_000_000 }) * 100)).toBe(110)
  expect(priced('claude-sonnet-5-5', { input_tokens: 0, output_tokens: 100_000 })).toBe(1)
  expect(priced('some-other', { input_tokens: 5, output_tokens: 5 })).toBe(0)
})

test('ops7\'s answer is read, and anything else is no answer', () => {
  expect(parseSpend(SPEND)?.total?.month).toBe(43.11)
  expect(parseSpend('{"ok": false, "error": "no key"}')?.ok).toBe(false)
  expect(parseSpend('<html>')).toBeUndefined()
  expect(parseSpend('[]')).toBeUndefined()
})

test('each model call adds to its model\'s tally', () => {
  const u = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0 }
  const once = addUsage(undefined, 'claude-haiku-4-5', u)
  const twice = addUsage(once, 'claude-haiku-4-5', u)
  expect(twice).toEqual({ calls: 2, input: 2400, output: 600, cacheRead: 0, usd: priced('claude-haiku-4-5', u) * 2 })
})

test('the API spend shows in /usage7, and a day past $5 rings', async ($, on) => {
  const toasts = await started($ as never, on, SPEND)
  const r = await $.command.run({ command: 'usage7', args: '' } as never)
  expect(r.text).toContain('mods (subscription): no model call yet this session')
  expect(r.text).toContain('api: $6.20 today, $11 yesterday, $43 this month')
  expect(r.text).toContain('  hoshi7: $4.10 today, $4.10 month')
  expect(toasts).toContain('API spend today $6.20, past $5 (month $43)')
})

test('without ops7 the bell says so and rings nothing', async ($, on) => {
  const toasts = await started($ as never, on, 'not json')
  const r = await $.command.run({ command: 'usage7', args: '' } as never)
  expect(r.text).toContain('api: ops7 did not answer on :8710')
  expect(toasts).toEqual([])
})
