import { test, expect, mock } from 'claude-code/testing'

test('/bell test rings a sample toast under atelier-bell, which avatar7 voices', async ($, on) => {
  const rung: { text: string; plugin: string }[] = []
  on('ui.toast', ($, e, next) => {
    rung.push({ text: e.text, plugin: next.origin.plugin })
    return { value: undefined } as never
  })
  const r = await $.command.run({ command: 'bell', args: 'test' })
  expect(r.text).toBe('test ring sent.')
  expect(rung.length).toBe(1)
  expect(rung[0]?.plugin).toBe('atelier-bell')
})

test('/bell without argument reports the status', async ($, on) => {
  on('ui.toast', () => ({ value: undefined }) as never)
  const r = await $.command.run({ command: 'bell', args: '' })
  expect(r.text).toBe('studio: nothing rendered since this session started.')
})

test('session start publishes its announce for avatar7, as calm news', async ($, on) => {
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }) as never)
  const writes: { plugin: string; key: string; value: { mood: string } }[] = []
  on('state.set', ($, e) => {
    writes.push(e as never)
    return { value: { isSet: true, version: 1 } } as never
  })
  await $.session.start({ cwd: '/home/u' } as never)
  const announce = writes.find(w => w.plugin === 'atelier-bell' && w.key === 'announce')
  expect(announce?.value.mood).toBe('watch')
})

test('a clip render shows its progress, then rings when its mp4 is there', async ($, on) => {
  const clock = mock.clock(on)
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('state.set', () => ({ value: { version: 1 } }) as never)
  let progress = [{ clip: 'descent', file: 'd.mp4', done: 150, total: 300, left: 200 }]
  const body: Record<string, () => unknown> = {
    'http://localhost:8700/outputs': () => [],
    'http://localhost:8188/queue': () => ({ queue_running: [], queue_pending: [] }),
    'http://localhost:8700/clips/progress': () => progress,
    'http://localhost:8700/clips': () => [{ name: 'descent', renders: [{ file: 'd.mp4' }] }],
  }
  on('http.fetch', ($, e) => ({ value: { ok: true, status: 200, text: JSON.stringify(body[e.url]?.()) } }) as never)

  await $.session.start({ cwd: '/home/u' } as never)
  await clock.advance(3_000)
  expect((await $.command.run({ command: 'bell', args: '' })).text).toBe('studio: clip descent 50%, 3 min left')

  progress = []
  await clock.advance(3_000)
  expect(toasts).toEqual(['studio: clip descent is rendered, d.mp4'])
})
