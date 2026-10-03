import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

// The engine beneath: the shell reports `kind` as CLAUDE_CODE_SESSION_KIND,
// no file can be read, and each registered command and opened pane is kept.
const engine = (on: On, kind: string): { commands: string[]; panes: string[] } => {
  const commands: string[] = []
  const panes: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } } as never
  })
  on('process.run', ($, e) => {
    const a = (e as { argv: string[] }).argv
    const stdout = a.join(' ').includes('CLAUDE_CODE_SESSION_KIND') ? kind : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('store.get', () => ({ value: undefined }) as never)
  on('fs.read', () => {
    throw new Error('no file here')
  })
  on('ui.log', () => undefined)
  on('ui.open', ($, e) => {
    panes.push((e as { id: string }).id)
    return { value: { isPlaced: true } } as never
  })
  return { commands, panes }
}

test('a background session (a daemon spare) gets no face and no voice', async ($, on) => {
  const { commands, panes } = engine(on, 'bg')
  await $.session.start({ cwd: '/home/u' } as never)
  expect(commands).toEqual([])
  expect(panes).toEqual([])
})

test('a session someone watches registers /avatar and opens the pane', async ($, on) => {
  const { commands, panes } = engine(on, '')
  await $.session.start({ cwd: '/home/u' } as never)
  expect(commands).toContain('avatar')
  expect(panes).toContain('avatar7')
})
