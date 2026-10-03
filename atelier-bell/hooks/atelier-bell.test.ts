import { test, expect } from 'claude-code/testing'

test('/bell test rings a sample toast under atelier-bell, which avatar7 voices', async ($, on) => {
  const rung: { text: string; plugin: string }[] = []
  on('ui.toast', ($, e, next) => {
    rung.push({ text: e.text, plugin: next.origin.plugin })
  })
  const r = await $.command.run({ command: 'bell', args: 'test' })
  expect(r.text).toBe('atelier-bell: test ring sent.')
  expect(rung.length).toBe(1)
  expect(rung[0]?.plugin).toBe('atelier-bell')
})

test('/bell without argument reports the status', async ($, on) => {
  on('ui.toast', () => undefined)
  const r = await $.command.run({ command: 'bell', args: '' })
  expect(r.text).toBe('studio: nothing rendered since this session started.')
})
