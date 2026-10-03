import { test, expect } from 'claude-code/testing'

test('/bell test rings a sample toast under atelier-bell, which avatar7 voices', async ($, on) => {
  const rung: { text: string; plugin: string }[] = []
  on('ui.toast', ($, e, next) => {
    rung.push({ text: e.text, plugin: next.origin.plugin })
  })
  const r = await $.command.run({ command: 'bell', args: 'test' })
  expect(r.text).toBe('test ring sent.')
  expect(rung.length).toBe(1)
  expect(rung[0]?.plugin).toBe('atelier-bell')
})

test('/bell without argument reports the status', async ($, on) => {
  on('ui.toast', () => undefined)
  const r = await $.command.run({ command: 'bell', args: '' })
  expect(r.text).toBe('studio: nothing rendered since this session started.')
})

test('session start publishes its announce for avatar7, as calm news', async ($, on) => {
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', () => undefined)
  const writes: { plugin: string; key: string; value: { mood: string } }[] = []
  on('state.set', ($, e) => {
    writes.push(e as never)
    return { isSet: true, version: 1 } as never
  })
  await $.session.start({ cwd: '/home/u' } as never)
  const announce = writes.find(w => w.plugin === 'atelier-bell' && w.key === 'announce')
  expect(announce?.value.mood).toBe('watch')
})
