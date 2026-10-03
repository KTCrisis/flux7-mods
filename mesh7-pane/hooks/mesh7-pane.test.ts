import { test, expect } from 'claude-code/testing'
import { meshShift } from './register'

test('mesh7 falling, halting and coming back each make one line; a steady reading none', () => {
  const up = { isUp: true, version: '0.19.0', halt: '' }
  expect(meshShift(up, up)).toBeUndefined()
  expect(meshShift(up, { ...up, isUp: false })?.mood).toBe('error')
  expect(meshShift({ ...up, isUp: false }, up)?.mood).toBe('watch')
  expect(meshShift(up, { ...up, halt: 'global: incident' })).toEqual({ mood: 'deny', event: 'mesh7 EMERGENCY STOP: global: incident' })
  expect(meshShift({ ...up, halt: 'global: incident' }, up)?.mood).toBe('watch')
})
