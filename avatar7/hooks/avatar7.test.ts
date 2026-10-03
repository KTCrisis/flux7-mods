import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'
import { heard, landed, meshShift } from './register'

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

test('rules in the persona color frame the face, the line and the controls', async ($, on) => {
  engine(on, '')
  on('ui.blit', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/home/u' } as never)
  const ui = await $.ui.mount({
    plugin: 'avatar7',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'avatar7',
    props: { bodyColumns: 48, scroll: { bodyRows: 40 } } as never,
  })
  // The drawn tree keeps no key on a Text: a rule is a truncated line of spans.
  type Node = { type: string; props: Record<string, unknown>; children?: (Node | string)[] }
  const all = (n: Node | string): Node[] => (typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(all)])
  const text = (n: Node | string): string => (typeof n === 'string' ? n : (n.children ?? []).map(text).join(''))
  const rules = all((await ui.drawn()) as unknown as Node)
    .filter(n => n.type === 'Text' && n.props.wrap === 'truncate')
    .map(text)
  expect(rules).toHaveLength(2)
  const [face = '', controls = ''] = rules
  expect(face).toContain('┤ AVATAR7 ├')
  expect(face).toContain('[IDLE] █')
  expect(controls).toContain('┤ CTRL ├')
  expect(controls).toContain('UP 00:00:00')
  expect([...face]).toHaveLength(48)
  expect([...controls]).toHaveLength(48)
})

test('an `announce` another mod publishes is kept, a malformed or foreign key is not', () => {
  expect(heard({ plugin: 'usage-bell', key: 'announce', value: { mood: 'error', event: 'a limit is near' } })).toEqual({
    mood: 'error',
    event: 'a limit is near',
  })
  expect(heard({ plugin: 'other', key: 'announce', value: { mood: 'shout', event: 'x' } })).toBeUndefined()
  expect(heard({ plugin: 'other', key: 'player', value: { mood: 'watch', event: 'x' } })).toBeUndefined()
  expect(heard({ plugin: 'avatar7', key: 'announce', value: { mood: 'watch', event: 'x' } })).toBeUndefined()
})

test('a write the host answers without isSet still counts; only isSet false does not', () => {
  expect(landed({ version: 3 })).toBe(true)
  expect(landed(undefined)).toBe(true)
  expect(landed({ isSet: true, version: 3 })).toBe(true)
  expect(landed({ isSet: false, version: 4 })).toBe(false)
})

test('mesh7 falling, halting and coming back each make one line; a steady reading none', () => {
  const up = { isUp: true, version: '0.19.0', halt: '' }
  expect(meshShift(up, up)).toBeUndefined()
  expect(meshShift(up, { ...up, isUp: false })?.mood).toBe('error')
  expect(meshShift({ ...up, isUp: false }, up)?.mood).toBe('watch')
  expect(meshShift(up, { ...up, halt: 'global: incident' })).toEqual({ mood: 'deny', event: 'mesh7 EMERGENCY STOP: global: incident' })
  expect(meshShift({ ...up, halt: 'global: incident' }, up)?.mood).toBe('watch')
})
