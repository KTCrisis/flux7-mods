import type { On } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'
import { drawsPictures, withPrivate } from './register'
import { facePixel, faceSample, faceCells, pickFace, TINT, type View } from './draw'
import { commandEvent, heard, heardSay, landed, nextStreak, streakNote } from './hearing'
import { speakScript, synthArgv } from './voice'
import { enqueue, fallbackPool, fresh, isOpinion, lineFrom, pickEvent, pickGuest, promptFor, rankOf, reads, recentNote, type Persona } from './speech'
import { ambientCells, ambientPixel } from './ambient'
import { hdFrame, hdKey, hdSize, PX, type Hd, type HdView } from './hd'
import { follows, givesOnEnd, newRelay, parseRemote } from './relay'
import { answered, ask as askFace, calm, hold, react, release, stage, tick } from './mood'
import { begin, end, HOLD_FRAMES, isHeard, restored, silent, start, typeOn, voiced } from './line'

// The engine beneath: the shell reports `kind` as CLAUDE_CODE_SESSION_KIND,
// no file can be read, and each registered command and opened pane is kept.
const engine = (on: On, kind: string, seen?: (argv: string[]) => void): { commands: string[]; panes: string[] } => {
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
    seen?.(a)
    const stdout = a.join(' ').includes('CLAUDE_CODE_SESSION_KIND') ? kind : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('store.get', () => ({ value: undefined }) as never)
  on('fs.read', () => {
    throw new Error('no file here')
  })
  on('ui.log', () => ({ value: undefined }) as never)
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
  expect(q.map(x => (x.ask === 'talk' ? 'talk' : typeof x.ask === 'object' && 'event' in x.ask ? x.ask.event : '?'))).toEqual(['mesh7 halted', 'context full', 'render ready', 'music on'])
  q = enqueue(q, 'talk', 5)
  expect(q.map(x => (x.ask === 'talk' ? 'talk' : typeof x.ask === 'object' && 'event' in x.ask ? x.ask.event : '?'))).toEqual(['talk', 'mesh7 halted', 'context full', 'render ready'])
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
  const f = { width: 40, height: 60, sceneTop: 0, sceneBottom: 60 }
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

test('a chat is the user speaking: urgent, never stale, never answered by a stock line', async () => {
  const fallback = { idle: ['x'], watch: ['x'], deny: ['x'], error: ['x'] } as never
  expect(rankOf({ chat: 'hello' })).toBe(4)
  expect(fallbackPool({ chat: 'hello' }, fallback)).toEqual([])
  expect(fresh([{ ask: { chat: 'hello' }, rank: 4, at: 0 }], 1_000_000)).toHaveLength(1)
  expect(parseRemote('{"cmd":"chat","text":"bonsoir"}')).toEqual({ cmd: 'chat', text: 'bonsoir' })
})

test('a /clear keeps a relay held by force; any other end gives it back', async ($, on) => {
  const released: string[] = []
  engine(on, '', a => {
    if (a[3] === 'avatar7-release') released.push(a[5] ?? '')
  })
  on('clock.sleep', () => ({ value: undefined }) as never)
  on('session.end', () => ({ sessionId: 'test-session' }))
  await $.session.start({ cwd: '/home/u' } as never)
  await $.session.end({ reason: 'clear' } as never)
  expect(released).toEqual(['test-session'])
  await $.command.run({ command: 'avatar', args: 'remote on' } as never)
  await $.session.end({ reason: 'clear' } as never)
  expect(released).toEqual(['test-session'])
  await $.session.end({ reason: 'prompt_input_exit' } as never)
  expect(released).toEqual(['test-session', 'test-session'])
})

test('the voice follows the prompt: Remote Control or ssh takes the relay, the terminal gives it back unless forced', () => {
  const r = { ...newRelay(), session: 's' }
  expect(follows(r, 'bridge')).toBe('take')
  expect(follows(r, 'composer')).toBe('give')
  expect(follows({ ...r, isSsh: true }, 'composer')).toBe('take')
  expect(follows({ ...r, isForced: true }, 'composer')).toBe('stay')
  expect(follows({ ...r, session: '' }, 'bridge')).toBe('stay')
  expect(givesOnEnd(r, 'clear')).toBe(true)
  expect(givesOnEnd({ ...r, isForced: true }, 'clear')).toBe(false)
  expect(givesOnEnd({ ...r, isForced: true }, 'prompt_input_exit')).toBe(true)
  expect(givesOnEnd({ ...r, session: '' }, 'prompt_input_exit')).toBe(false)
})

// A session with a persona on duty and a clock the test moves: the model's
// prompts are kept, the voice is silent (no WAV), every other call answers.
const onDutyEngine = (on: On, extra: { model?: () => string; ran?: (tool: string) => Record<string, unknown> | undefined } = {}) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.model', () => ({ value: extra.model?.() ?? 'opus' }) as never)
  on('session.messages', () => ({ value: [] }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('fs.read', ($, e) => {
    const path = (e as { path: string }).path
    if (path.endsWith('/persona.json')) {
      return { value: JSON.stringify({ name: 'Test', persona: 'You are a test.', greeting: 'Hello.', fallback: ['...'] }) } as never
    }
    // A black portrait, 64 x 64 RGB.
    if (path.endsWith('/face.rgb')) return { value: { base64: new Uint8Array(64 * 64 * 3).toBase64() } } as never
    throw new Error('no file here')
  })
  on('model.complete', ($, e) => {
    prompts.push((e as { prompt: string }).prompt)
    return { value: { isAnswered: true, text: 'A line.', usage: {} } } as never
  })
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.blit', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('tool.call', ($, e) => (extra.ran?.((e as { tool: string }).tool) ?? { result: 'ok' }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  return { clock, prompts }
}
const call = (tool: string) => ({ tool, input: {}, tool_use_id: 'u1' }) as never
const turnEnd = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answered' } as never

test('a refusal while another line waits takes its place in the queue instead of being dropped', async ($, on) => {
  const { clock, prompts } = onDutyEngine(on, { ran: tool => (tool === 'Bash' ? { deny: 'not allowed' } : undefined) })
  await $.session.start({ cwd: '/home/u' } as never)
  // The success finds the queue empty and waits there; the refusal comes
  // while it waits, and is spoken after it.
  await $.tool.call(call('Read'))
  await $.tool.call(call('Bash'))
  await clock.advance(30_000)
  const events = prompts.map(p => p.split('\n')[0])
  expect(events).toEqual(['Event: call succeeded: Read', 'Event: call DENIED: Bash (not allowed)'])
})

test('a model switch is heard at the end of the turn that follows it', async ($, on) => {
  let model = 'opus'
  const { clock, prompts } = onDutyEngine(on, { model: () => model })
  await $.session.start({ cwd: '/home/u' } as never)
  await clock.advance(10_000)
  await $.turn.complete(turnEnd)
  expect(prompts.some(p => p.includes('now runs on'))).toBe(false)
  model = 'sonnet'
  await $.turn.complete(turnEnd)
  await clock.advance(10_000)
  expect(prompts.some(p => p.includes('now runs on sonnet, no longer on opus'))).toBe(true)
})

test('a wait keeps the face: no toast, say, visit or call outcome changes it until it ends', () => {
  const asked = askFace(calm, 'Bash: rm -rf build', 10)
  expect(asked.mood).toBe('wait')
  expect(react(asked, 'deny', 11)).toBe(asked)
  const held = hold(calm, 'mcp__mesh7__x', 10)
  expect(react(held, 'watch', 11, 30)).toBe(held)
  // The call ran: the prompt is gone, and its outcome sets the face.
  const ran = react(answered(asked), 'deny', 12)
  expect([ran.mood, ran.until, ran.askSince]).toEqual(['deny', 42, null])
  // The human decided on the held call: the verdict shows for 30 frames.
  expect(release(held, 'watch', 20)).toMatchObject({ mood: 'watch', until: 50, held: null })
})

test('a mood fades to idle after its span; a calm look passes faster than an alarm', () => {
  const seen = react(calm, 'watch', 0)
  expect(tick(seen, 12, 1000).mood).toBe('watch')
  expect(tick(seen, 13, 1000).mood).toBe('idle')
  expect(tick(react(calm, 'error', 0), 13, 1000).mood).toBe('error')
})

test('a wait whose end never comes lets the face go after the cap', () => {
  const held = hold(calm, 'a call', 0)
  expect(tick(held, 100, 100)).toBe(held)
  const freed = tick(held, 101, 100)
  expect(freed.held).toBeNull()
  expect(tick(freed, 102, 100).mood).toBe('idle')
  const asked = tick(askFace(calm, 'x', 0), 101, 100)
  expect(asked.askSince).toBeNull()
})

test('a line waits for its voice, then types over the length of the audio; a late voice types only its own line', () => {
  const t = start(silent, 'Hello there.', false, 100)
  expect([t.seq, t.typed, t.from]).toEqual([1, 0, 100 + HOLD_FRAMES])
  expect(typeOn(t, 120)).toBe(t)
  // 12 characters over a 0.66 s WAV: 10 frames of 66 ms, from 5 frames on.
  const { t: v, wav, ms } = voiced(t, 1, '/tmp/x.wav\n0.66\n', 120, 66)
  expect([wav, ms]).toEqual(['/tmp/x.wav', 660])
  expect([v.from, v.speakUntil, v.rate]).toEqual([125, 135, 1.2])
  expect(isHeard(v, 130)).toBe(true)
  expect(typeOn(v, 125).typed).toBe(1.2)
  // A newer line took the screen: the old voice plays, the new line keeps its pace.
  const newer = start(v, 'Next.', false, 121)
  expect(voiced(newer, 1, '/tmp/x.wav\n0.66\n', 122, 66).t).toBe(newer)
  // SAPI spoke it itself: nothing to time.
  expect(voiced(t, 1, '', 120, 66)).toEqual({ t, wav: '', ms: 0 })
})

test('a muted line types at once; a line kept across a reload shows whole; the slot opens and closes', () => {
  expect(start(silent, 'Quiet.', true, 50).from).toBe(50)
  const kept = restored(silent, 'From before.')
  expect(typeOn(kept, 999)).toBe(kept)
  const busy = begin(silent, 40)
  expect([busy.isSpeaking, busy.lastSpoke]).toEqual([true, 40])
  expect(end(busy).isSpeaking).toBe(false)
})

const persona = { name: 'Test', persona: 'You are a test.', fallback: { idle: ['Hm.'], watch: ['Seen.'], deny: ['No.'], error: ['Oops.'] }, asks: 'machines' } as unknown as Persona
const asking = { voice: persona, other: 'Lain', conversation: 'user: hi', chatPast: [], asked: '', recent: [] }

test('each line reads what it needs from the session, and no more', () => {
  expect(reads('talk')).toEqual({ count: 6, chars: 300 })
  expect(reads({ consult: 'is this right?' })).toEqual({ count: 12, chars: 600 })
  expect(reads({ duo: 'lain', turn: 0, topic: 'session', history: [] })).toEqual({ count: 6, chars: 300 })
  // A later turn of a dialogue, or a dialogue about their stories, reads nothing.
  expect(reads({ duo: 'lain', turn: 2, topic: 'session', history: [] })).toBeNull()
  expect(reads({ duo: 'lain', turn: 0, topic: 'stories', history: [] })).toBeNull()
  expect(reads({ mood: 'deny', event: 'x' })).toBeNull()
  expect(reads({ greet: 'Hello.' })).toBeNull()
})

test('the prompt fits the line: an event against what was asked, a dialogue to the other, a greeting none', () => {
  expect(promptFor({ mood: 'deny', event: 'call DENIED: Bash' }, { ...asking, asked: 'clean the build' })).toBe(
    'The user asked: clean the build\nEvent: call DENIED: Bash',
  )
  expect(promptFor({ duo: 'lain', turn: 0, topic: 'stories', history: [] }, asking)).toContain('Lain visits your terminal')
  expect(promptFor({ duo: 'lain', turn: 5, topic: 'stories', history: ['Lain: hi'] }, asking)).toContain('Close the exchange')
  expect(promptFor('question', asking)).toContain('Your bent: machines')
  expect(promptFor({ chat: 'how are you' }, { ...asking, chatPast: ['User: hi', 'Test: hello'] })).toContain('User: hi\nTest: hello')
  expect(promptFor({ greet: 'Hello.' }, asking)).toBeNull()
  expect(promptFor('talk', { ...asking, recent: ['Seen it.'] })).toContain('- Seen it.')
})

test('an opinion keeps all its sentences, a line its first; no answer falls back to a stock line, or silence', () => {
  expect(isOpinion({ consult: 'x' })).toBe(true)
  expect(lineFrom({ isAnswered: true, text: 'One.\nTwo.' }, { mood: 'watch', event: 'x' }, persona, 0, '')).toBe('One.')
  expect(lineFrom({ isAnswered: true, text: 'One.\n  Two.' }, { consult: 'x' }, persona, 0, '')).toBe('One. Two.')
  expect(lineFrom({ isAnswered: false }, { mood: 'deny', event: 'x' }, persona, 0, '')).toBe('No.')
  expect(lineFrom({ isAnswered: false }, { consult: 'x' }, persona, 0, '')).toBe('')
})

test('a visit runs its six turns, host and guest in turn, then makes room for the next', async ($, on) => {
  const { clock, prompts } = onDutyEngine(on)
  await $.session.start({ cwd: '/home/u' } as never)
  await clock.advance(1_000)
  const asked = await $.command.run({ command: 'avatar', args: 'duo lain' } as never)
  expect(asked.text).toBe('Test visits Test.')
  expect((await $.command.run({ command: 'avatar', args: 'duo hal' } as never)).text).toContain('is visiting already')
  // No voice: each turn is written and typed at once, one per few frames.
  await clock.advance(3_000)
  const turns = prompts.filter(p => p.includes('visits your terminal') || p.includes('You are talking with'))
  expect(turns).toHaveLength(6)
  expect(turns.filter(p => p.includes('Close the exchange'))).toHaveLength(1)
  expect((await $.command.run({ command: 'avatar', args: 'duo hal' } as never)).text).toBe('Test visits Test.')
})

test('a model switch is no command heard (turn.complete hears it); ordinals stay English past ten', () => {
  expect(commandEvent('model', 'sonnet')).toBeUndefined()
  const after = (n: number) => streakNote({ mood: 'watch', count: 0 }, { mood: 'deny', count: n })
  expect([11, 12, 13, 21, 22, 103].map(after)).toEqual([
    ' (11th denial in a row)',
    ' (12th denial in a row)',
    ' (13th denial in a row)',
    ' (21st denial in a row)',
    ' (22nd denial in a row)',
    ' (103rd denial in a row)',
  ])
})

test('SAPI speaks a pitched voice through XML, the text escaped; volume stays within 0 and 1 for Piper', () => {
  const pitched = speakScript({ voice: 'Microsoft Zira', rate: 1, pitch: -4 }, 80)
  expect(pitched).toContain('<pitch absmiddle=')
  expect(pitched).toContain('[Security.SecurityElement]::Escape($t)')
  expect(pitched).toContain('"-4"')
  const plain = speakScript({ voice: 'Microsoft David', rate: 0 }, 50)
  expect(plain).toContain('$s.SelectVoice("Microsoft David")')
  expect(plain).not.toContain('<pitch')
  const who = { voice: 'Microsoft David', rate: 0, piper: { voice: 'en_US-ryan-high' } } as never
  expect(synthArgv('fox', who, 150)[5]).toBe('1')
  expect(synthArgv('fox', who, -5)[5]).toBe('0')
  // Without a Piper voice, $1 is empty and SAPI speaks the line itself.
  expect(synthArgv('hal', { voice: 'Microsoft David', rate: 0 } as never, 100)[4]).toBe('')
})

// A uniform grey portrait (100, 100, 100), drawn at 64: one portrait pixel
// per output pixel; at frame 0 the bright sweep sits on row 0.
const grey = (level = 100): Uint8Array => new Uint8Array(64 * 64 * 3).fill(level)
const view = (over: Partial<View> = {}): View => ({
  frame: 0,
  frameMs: 66,
  mood: 'idle',
  faces: { base: grey(), talk: null, deny: null },
  persona: { color: '#00ff9c' },
  isHeard: false,
  glitch: 1,
  size: 64,
  layers: [],
  field: { width: 64, height: 64, sceneTop: 0, sceneBottom: 64 },
  ambLeft: 0,
  ambT: 0,
  ...over,
})
const rgbOf = (c: number) => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]

test('the face draws its portrait with scanlines: odd rows at 70 %, the sweep brighter', () => {
  expect(rgbOf(faceSample(view(), 10, 2))).toEqual([100, 100, 100])
  expect(rgbOf(faceSample(view(), 10, 3))).toEqual([70, 70, 70])
  expect(rgbOf(faceSample(view(), 10, 0))).toEqual([135, 135, 135])
  // No persona loaded yet: static, dark.
  expect([0x1a2a22, 0x020806]).toContain(facePixel(view({ persona: null }), 5, 5))
})

test('a mood pulls the portrait toward its color; a refusal frowns when it can', () => {
  const [r = 0, g = 0, b = 0] = rgbOf(facePixel(view({ mood: 'watch' }), 10, 10))
  // Cyan: green and blue rise above red, which the mix lowers.
  expect(r).toBeLessThan(100)
  expect(g).toBeGreaterThan(r)
  expect(b).toBeGreaterThan(r)
  const frown = { base: grey(), talk: null, deny: grey(200) }
  const p = facePixel(view({ mood: 'error', faces: frown }), 10, 10)
  expect(rgbOf(p)[0]).toBeGreaterThan(100)
})

test('over a scene the face is framed like a comm window: bright corners, faint edges, the mood\'s color', () => {
  const scene = { layers: [{ kind: 'stars' as const, color: '#ffffff' }] }
  expect(faceSample(view(scene), 0, 0)).toBe(0x00ff9c)
  const faint = rgbOf(faceSample(view(scene), 32, 0))
  expect(faint).toEqual([0, 77, 47])
  expect(faceSample(view({ ...scene, mood: 'deny' }), 63, 63)).toBe(TINT.deny)
  // Without a scene there is no frame: the portrait runs to the edge.
  expect(rgbOf(faceSample(view(), 32, 2))).toEqual([100, 100, 100])
})

test('a dark portrait lets the scene through; a bright one hides it', () => {
  const scene = [{ kind: 'stars' as const, color: '#ffffff', density: 1 }]
  const dark = view({ faces: { base: grey(0), talk: null, deny: null }, layers: scene })
  const bright = view({ layers: scene })
  let through = 0
  for (let x = 1; x < 63; x++) for (let y = 2; y < 62; y += 2) if (faceSample(dark, x, y) !== 0) through++
  expect(through).toBeGreaterThan(0)
  expect(rgbOf(faceSample(bright, 10, 2))).toEqual([100, 100, 100])
})

test('the cells cover the face in upper half blocks, two pixels each', () => {
  const words = new Uint32Array(Uint8Array.fromBase64(faceCells(view({ size: 16 }))).buffer)
  expect(words.length).toBe(16 * 8 * 3)
  for (let i = 0; i < words.length; i += 3) expect(words[i]).toBe(0x2580)
})

test('a refusal acted in a scene shakes the portrait less than one a call earned', () => {
  const staged = stage(calm, 'deny', 0, 60)
  expect([staged.mood, staged.isStaged]).toEqual(['deny', true])
  expect(react(staged, 'deny', 1).isStaged).toBe(false)
  expect(tick(staged, 61, 1000).isStaged).toBe(false)
  // A horizontal ramp (each column its own grey), so a shifted row shows.
  const ramp = new Uint8Array(64 * 64 * 3)
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) ramp.fill(x * 3, (y * 64 + x) * 3, (y * 64 + x) * 3 + 3)
  const faces = { base: ramp, talk: null, deny: null }
  // Over a frame, count the rows the glitch moved: fewer with a softer glitch.
  const moved = (glitch: number) => {
    let n = 0
    for (let y = 0; y < 64; y++) if (facePixel(view({ mood: 'deny', glitch, faces }), 10, y) !== facePixel(view({ mood: 'deny', glitch: 0, faces }), 10, y)) n++
    return n
  }
  expect(moved(0.4)).toBeLessThan(moved(1))
  expect(moved(0.4)).toBeGreaterThan(0)
})

// Real images only where the Image element draws them (kitty's Unicode
// placeholders): kitty and Ghostty yes, WezTerm and the rest no.
test('pictures are drawn in kitty and Ghostty only, and AVATAR7_HD=0 keeps the half blocks', () => {
  expect(drawsPictures('xterm-kitty||')).toBe(true)
  expect(drawsPictures('xterm-ghostty|ghostty|')).toBe(true)
  expect(drawsPictures('xterm-256color|WezTerm|')).toBe(false)
  expect(drawsPictures('xterm-256color||')).toBe(false)
  expect(drawsPictures('xterm-kitty||0')).toBe(false)
})

// A gray portrait on a black ground over a blue scene.
const hdView = (mood: HdView['mood']): HdView => {
  const side = 8
  const base = new Uint8Array(side * side * 3)
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) base.fill(200, (y * side + x) * 3, (y * side + x) * 3 + 3)
  const scene = { width: 16, height: 4, pixels: new Uint8Array(16 * 4 * 3).map((_, i) => (i % 3 === 2 ? 255 : 0)) }
  const hd: Hd = { side, base, talk: null, deny: null, scene }
  return { hd, mood, face: 'base', glitchStep: 0, glitch: 1, color: '#00ff9c', cutout: 12, columns: 20, rows: 4, size: 8 }
}
const at = (img: Uint8Array, width: number, x: number, y: number): number[] => Array.from(img.slice((y * width + x) * 4, (y * width + x) * 4 + 3))

test('the HD picture is the band in pixels: PX a column, twice that a row', () => {
  const v = hdView('idle')
  const { width, height } = hdSize(v.columns, v.rows)
  expect([width, height]).toEqual([20 * PX, 4 * 2 * PX])
  expect(hdFrame(v).length).toBe(width * height * 4)
})

test('the scene shows beside the face and through its dark ground, the portrait over it', () => {
  const v = hdView('idle')
  const { width, height } = hdSize(v.columns, v.rows)
  const img = hdFrame(v)
  const left = Math.floor((v.columns - v.size) / 2) * PX
  const side = v.size * PX
  // Beside the face, low in the band: the scene's blue.
  const beside = at(img, width, 2, height - 2)
  expect(beside[2]).toBeGreaterThan(0)
  expect(beside[0]).toBe(0)
  // In the face's black ground, away from the frame: the scene again.
  const ground = at(img, width, left + 4, side - 4)
  expect(ground[2]).toBeGreaterThan(0)
  // In the portrait's middle: its gray, opaque.
  const middle = at(img, width, left + side / 2, side / 2)
  expect(middle[0]).toBeGreaterThan(100)
  expect(middle[0]).toBe(middle[2])
})

test('the frame takes the persona color at rest and the mood color on a refusal', () => {
  const idle = hdView('idle')
  const deny = hdView('deny')
  const { width } = hdSize(idle.columns, idle.rows)
  const left = Math.floor((idle.columns - idle.size) / 2) * PX
  expect(at(hdFrame(idle), width, left, 0)).toEqual([0x00, 0xff, 0x9c])
  expect(at(hdFrame(deny), width, left, 0)).toEqual([0xff, 0x2a, 0x6d])
  expect(hdKey(idle)).not.toBe(hdKey(deny))
})
