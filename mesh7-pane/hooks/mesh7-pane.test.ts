import { test, expect } from 'claude-code/testing'
import { claudeName, decisionSay, meshShift, verdictSay } from './register'

test('mesh7 falling, halting and coming back each make one line; a steady reading none', () => {
  const up = { isUp: true, version: '0.19.0', halt: '' }
  expect(meshShift(up, up)).toBeUndefined()
  expect(meshShift(up, { ...up, isUp: false })?.mood).toBe('error')
  expect(meshShift({ ...up, isUp: false }, up)?.mood).toBe('watch')
  expect(meshShift(up, { ...up, halt: 'global: incident' })).toEqual({ mood: 'deny', event: 'mesh7 EMERGENCY STOP: global: incident' })
  expect(meshShift({ ...up, halt: 'global: incident' }, up)?.mood).toBe('watch')
})

test('a trace names its tool the way Claude Code does', () => {
  expect(claudeName('time.get_current_time')).toBe('mcp__mesh7__time_get_current_time')
  expect(claudeName('gmail-perso.gmail_send_email')).toBe('mcp__mesh7__gmail-perso_gmail_send_email')
  expect(claudeName('Bash')).toBe('Bash')
})

test('a refusal and an MCP hold are told, a Bash hold and an allow are not; a decision releases', () => {
  expect(verdictSay({ tool: 'Bash', verdict: 'deny', rule: 'no-rm', hint: 'rm -rf /' })).toEqual({
    mood: 'deny',
    event: 'mesh7 DENIED Bash rm -rf /, by rule no-rm',
    tool: 'Bash',
  })
  expect(verdictSay({ tool: 'gmail.send', verdict: 'human_approval', rule: 'mail', hint: '' })?.hold).toBe(true)
  expect(verdictSay({ tool: 'Bash', verdict: 'human_approval', rule: 'x', hint: '' })).toBeUndefined()
  expect(verdictSay({ tool: 'Read', verdict: 'allow', rule: 'x', hint: '' })).toBeUndefined()
  expect(decisionSay({ tool: 'gmail.send', status: 'denied' })).toEqual({
    mood: 'deny',
    event: 'the human denied gmail.send',
    tool: 'mcp__mesh7__gmail_send',
    release: true,
  })
})
