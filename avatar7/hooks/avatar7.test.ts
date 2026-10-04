import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'
import { commandEvent, parseRemote, withPrivate, fallbackPool, pickFace, synthArgv, enqueue, fresh, heard, heardSay, landed, nextStreak, pickEvent, pickGuest, rankOf, recentNote, streakNote } from './register'
import { ambientCells, ambientPixel } from './ambient'

// The engine beneath: the shell reports `kind` as CLAUDE_CODE_SESSION_KIND,
// no file can be read, and each registered command and opened pane is kept.
const engine = (on: On, kind: string): { commands: string[]; panes: string[] } => {
  const commands: string[] = []
  const panes: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
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

test('a `say` another mod publishes is kept with its mood and time; a malformed one is not', () => {
  expect(heardSay({ plugin: 'mesh7-pane', key: 'say', value: { mood: 'deny', event: 'mesh7 EMERGENCY STOP', at: 5 } })).toEqual({
    mood: 'deny',
    event: 'mesh7 EMERGENCY STOP',
    at: 5,
  })
  expect(heardSay({ plugin: 'other', key: 'say', value: { mood: 'deny', event: 'x' } })).toBeUndefined()
  expect(heardSay({ plugin: 'other', key: 'say', value: { mood: 'shout', event: 'x', at: 1 } })).toBeUndefined()
  expect(heardSay({ plugin: 'avatar7', key: 'say', value: { mood: 'watch', event: 'x', at: 1 } })).toBeUndefined()
})

test('the queue speaks the most urgent first, the oldest among equals, and drops the least urgent when full', () => {
  let q = enqueue([], { mood: 'watch', event: 'render ready' }, 1)
  q = enqueue(q, { mood: 'watch', event: 'music on' }, 2)
  q = enqueue(q, { mood: 'deny', event: 'mesh7 halted' }, 3)
  q = enqueue(q, { mood: 'error', event: 'context full' }, 4)
  expect(q.map(x => (x.ask === 'talk' ? 'talk' : x.ask.event))).toEqual(['mesh7 halted', 'context full', 'render ready', 'music on'])
  q = enqueue(q, 'talk', 5)
  expect(q.map(x => (x.ask === 'talk' ? 'talk' : x.ask.event))).toEqual(['talk', 'mesh7 halted', 'context full', 'render ready'])
})

test('a line that waited too long is dropped, a poke never', () => {
  const q = enqueue(enqueue([], { mood: 'watch', event: 'old news' }, 0), 'talk', 0)
  expect(fresh(q, 300)).toHaveLength(2)
  expect(fresh(q, 301).map(x => x.ask)).toEqual(['talk'])
})

test('a run of denials is counted, and a success after three failures is news', () => {
  let s = { mood: 'watch' as const, count: 4 } as Parameters<typeof nextStreak>[0]
  const deny1 = nextStreak(s, 'deny')
  expect(streakNote(s, deny1)).toBe('')
  const deny2 = nextStreak(deny1, 'deny')
  expect(streakNote(deny1, deny2)).toBe(' (2nd denial in a row)')
  const deny3 = nextStreak(deny2, 'deny')
  expect(streakNote(deny2, deny3)).toBe(' (3rd denial in a row)')
  const back = nextStreak(deny3, 'watch')
  expect(streakNote(deny3, back)).toBe(' (first success after 3 denials in a row)')
  s = { mood: 'error', count: 11 }
  expect(streakNote(s, nextStreak(s, 'error'))).toBe(' (12th failure in a row)')
  expect(streakNote(back, nextStreak(back, 'watch'))).toBe('')
})

test('the last lines go back to the model, none on a fresh session', () => {
  expect(recentNote([])).toBe('')
  expect(recentNote(['Noted. For science.', 'Denied.'])).toBe(
    '\nYour last lines, do not reuse their wording or openings:\n- Noted. For science.\n- Denied.',
  )
})

test('a persona event is a story or a question, even odds when it has both', () => {
  const stories = [
    { story: 'a leviathan passes', mood: 'error' as const },
    { story: 'a beacon calls', mood: 'watch' as const },
  ]
  expect(pickEvent(stories, true, 0.2, 0.9)).toEqual({ story: 'a beacon calls', mood: 'watch' })
  expect(pickEvent(stories, true, 0.7, 0.1)).toBe('question')
  expect(pickEvent(stories, false, 0.9, 0)).toEqual({ story: 'a leviathan passes', mood: 'error' })
  expect(pickEvent([], true, 0.1, 0)).toBe('question')
  expect(pickEvent([], false, 0.1, 0)).toBeUndefined()
})

test('the persona\'s own events wait behind everything; the user\'s answer goes first and never goes stale', () => {
  expect(rankOf({ story: 'x', mood: 'error' })).toBe(0)
  expect(rankOf('question')).toBe(0)
  expect(rankOf({ question: 'q', answer: 'a' })).toBe(4)
  expect(rankOf({ consult: 'q' })).toBe(4)
  let q = enqueue([], 'question', 0)
  q = enqueue(q, { mood: 'watch', event: 'render ready' }, 1)
  expect(q[0]?.ask).toEqual({ mood: 'watch', event: 'render ready' })
  q = enqueue([], { question: 'q', answer: 'a' }, 0)
  expect(fresh(q, 10_000)).toHaveLength(1)
})

test('a guest is any avatar but the one on duty; a dialogue turn waits behind everything', () => {
  const all = ['hal', 'glados', 'shodan']
  expect(pickGuest(all, 'hal', 0)).toBe('glados')
  expect(pickGuest(all, 'hal', 0.99)).toBe('shodan')
  expect(pickGuest(['hal'], 'hal', 0.5)).toBeUndefined()
  expect(rankOf({ duo: 'glados', turn: 1, topic: 'stories', history: [] })).toBe(0)
})

test('a friend is three times as likely a guest as anyone else', () => {
  const all = ['hal', 'glados', 'shodan', 'duck7']
  // weights from hal: glados 3, shodan 1, duck7 1, total 5
  expect(pickGuest(all, 'hal', 0, ['glados'])).toBe('glados')
  expect(pickGuest(all, 'hal', 0.59, ['glados'])).toBe('glados')
  expect(pickGuest(all, 'hal', 0.61, ['glados'])).toBe('shodan')
  expect(pickGuest(all, 'hal', 0.99, ['glados'])).toBe('duck7')
})

test('a multi-speaker Piper voice passes its speaker as the last argument; a single voice passes none', () => {
  const lain = { voice: 'Zira', rate: 0, piper: { voice: 'en_GB-vctk-medium', speaker: 86 } } as never
  expect(synthArgv('lain', lain, 100).at(-1)).toBe('86')
  const hal = { voice: 'David', rate: 0, piper: { voice: 'en_US-norman-medium' } } as never
  expect(synthArgv('hal', hal, 100).at(-1)).toBe('')
})

test('the frown wins on a refusal, the mouth flaps while speaking, a persona without frames keeps its portrait', () => {
  const all = { base: 'base', talk: 'talk', deny: 'deny' }
  expect(pickFace(all, 'deny', true, 0)).toBe('deny')
  expect(pickFace(all, 'error', false, 0.9)).toBe('deny')
  expect(pickFace(all, 'watch', true, 0.2)).toBe('talk')
  expect(pickFace(all, 'watch', true, 0.8)).toBe('base')
  expect(pickFace(all, 'idle', false, 0.2)).toBe('base')
  const bare = { base: 'base', talk: null, deny: null }
  expect(pickFace(bare, 'deny', true, 0.1)).toBe('base')
})

test('every kind of line finds its fallback without throwing; a poke takes the idle lines', () => {
  const fb = { idle: ['i'], watch: ['w'], deny: ['d'], error: ['e'], wait: ['wa'] }
  expect(fallbackPool('talk', fb)).toEqual(['i'])
  expect(fallbackPool('question', fb)).toEqual([])
  expect(fallbackPool({ consult: 'q' }, fb)).toEqual([])
  expect(fallbackPool({ duo: 'hal', turn: 0, topic: 'stories', history: [] }, fb)).toEqual([])
  expect(fallbackPool({ story: 's', mood: 'error' }, fb)).toEqual(['i'])
  expect(fallbackPool({ mood: 'wait', event: 'x' }, fb)).toEqual(['wa'])
  expect(fallbackPool({ mood: 'deny', event: 'x' }, fb)).toEqual(['d'])
})

test('a say carries its tool, hold and release through; a stray field is not kept', () => {
  expect(heardSay({ plugin: 'mesh7-pane', key: 'say', value: { mood: 'wait', event: 'held', at: 1, tool: 'mcp__mesh7__gmail_send', hold: true } })).toEqual({
    mood: 'wait',
    event: 'held',
    at: 1,
    tool: 'mcp__mesh7__gmail_send',
    hold: true,
  })
  expect(heardSay({ plugin: 'x', key: 'say', value: { mood: 'deny', event: 'e', at: 1, hold: 'yes', other: 3 } })).toEqual({ mood: 'deny', event: 'e', at: 1 })
})

test('an opinion asked of the avatar outranks its own news and never goes stale', () => {
  const q = enqueue(enqueue([], { mood: 'deny', event: 'x' }, 0), { consult: 'is this split right?' }, 1)
  expect(q[0]?.ask).toEqual({ consult: 'is this split right?' })
  expect(fresh(q, 10_000).map(x => x.ask)).toEqual([{ consult: 'is this split right?' }])
})

test('/avatar-ask is registered with the other commands', async ($, on) => {
  const { commands } = engine(on, '')
  await $.session.start({ cwd: '/home/u' } as never)
  expect(commands).toContain('avatar-ask')
})

test('a listed command earns a line with what it means; any other passes in silence', () => {
  expect(commandEvent('rewind', '')).toEqual({ mood: 'error', event: 'the user runs /rewind, which rewinds the conversation to undo what went wrong' })
  expect(commandEvent('compact', ' focus  on mesh7 ')?.event).toContain('/compact focus on mesh7, which')
  expect(commandEvent('context', '')).toBeUndefined()
  expect(commandEvent('avatar-ask', 'x')).toBeUndefined()
})

test('the ambient draws only where a layer lights, and stays dim', async () => {
  const f = { width: 40, height: 60 }
  expect(ambientPixel([], f, 5, 5, 1, false)).toBe(0)
  const rain = [{ kind: 'rain' as const, color: '#00ff9c', density: 1 }]
  let lit = 0
  let brightest = 0
  for (let y = 0; y < f.height; y++) {
    const p = ambientPixel(rain, f, 3, y, 2, false)
    if (p !== 0) lit++
    brightest = Math.max(brightest, (p >> 8) & 0xff)
  }
  expect(lit).toBeGreaterThan(0)
  expect(brightest).toBeLessThanOrEqual(128)
  // A cell shows two colors: a lone drop on black is a quadrant, lit in the drop's color.
  const words = new Uint32Array(Uint8Array.fromBase64(ambientCells([], f, 0, 0, 2, 2, 0, false)).buffer)
  expect(words[1]).toBe(0)
})

test('the relay page may only ask for the pane gestures, well formed', async () => {
  expect(parseRemote('{"cmd":"talk"}')).toEqual({ cmd: 'talk' })
  expect(parseRemote('{"cmd":"ask","text":"why?"}')).toEqual({ cmd: 'ask', text: 'why?' })
  expect(parseRemote('{"cmd":"volume","step":-1}')).toEqual({ cmd: 'volume', step: -1 })
  expect(parseRemote('{"cmd":"volume","step":50}')).toBeUndefined()
  expect(parseRemote('{"cmd":"approve","id":"x"}')).toBeUndefined()
  expect(parseRemote('{"cmd":"ask"}')).toBeUndefined()
  expect(parseRemote('not json')).toBeUndefined()
})

test('a private complement adds scenes and character, keeps the public ones', async () => {
  const pub = { name: 'HAL', persona: 'You are HAL.', events: [{ story: 'a', mood: 'watch' }], asks: 'truth', nobody: 'Dave' } as never
  const merged = withPrivate(pub, { persona: 'You know the user plays judo.', events: [{ story: 'b', mood: 'wait' }], asks: 'judo' })
  expect(merged.persona).toBe('You are HAL. You know the user plays judo.')
  expect(merged.events?.map(e => e.story)).toEqual(['a', 'b'])
  expect(merged.asks).toBe('truth; judo')
  expect(merged.nobody).toBe('Dave')
  expect(withPrivate(pub, null)).toBe(pub)
})
