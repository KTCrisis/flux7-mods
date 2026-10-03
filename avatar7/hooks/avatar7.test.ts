import { test, expect } from 'claude-code/testing'
import { windShift, auraGlow } from './register'

const wind = { x: 32, y: 32, rx: 10, ry: 10, amp: 2 }

test('the wind leaves the face still and sways what lies outside it', () => {
  for (const t of [0, 0.7, 1.9]) expect(windShift(wind, 32, 32, t)).toBe(0)
  const shifts = [0, 0.5, 1, 1.5, 2].map(t => windShift(wind, 2, 32, t))
  expect(shifts.some(v => Math.abs(v) > 0.5)).toBe(true)
  expect(shifts.every(v => Math.abs(v) <= 2 * 1.35)).toBe(true)
})

test('the aura peaks on its ring and fades away from it', () => {
  const aura = { color: '#ff0000', radius: 20, width: 3 }
  const on = auraGlow(aura, 32 + 20, 32, 1)
  expect(on).toBeGreaterThan(0.3)
  expect(auraGlow(aura, 32, 32, 1)).toBeLessThan(0.01)
  expect(auraGlow(aura, 32 + 31, 32, 1)).toBeLessThan(on)
})
