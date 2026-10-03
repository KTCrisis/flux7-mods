import type { On } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'

// The engine beneath the plugin: it echoes measurements and keeps the toasts.
const engine = (on: On): string[] => {
  const toasts: string[] = []
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.status', () => undefined)
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
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
  })
  const r = await $.command.run({ command: 'usage7', args: 'test' })
  expect(r.text).toBe('usage-bell: test ring sent.')
  expect(origins).toEqual(['usage-bell'])
})
