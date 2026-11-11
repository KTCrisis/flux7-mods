import { expect, test } from 'claude-code/testing'

import { curve, isUp, parsePing, parsePorts, parseProbe, parseSpeed, parseWho, sayMs, sayOrg, sayReach, turned, veil, verdict } from './register'

const EMPTY = { at: 0, device: '', gateway: '', dns: '', hop: '', box: { sent: 0, got: 0, ms: 0 }, isp: { sent: 0, got: 0, ms: 0 }, world: [], web: { ok: false, name: 0, shake: 0, whole: 0 }, ports: [], trail: [] }
const ping = (got: number, ms: string): string => `3 packets transmitted, ${got} received, ${Math.round(((3 - got) / 3) * 100)}% packet loss, time 408ms ${got > 0 ? `rtt min/avg/max/mdev = 0.609/${ms}/0.781/0.078 ms` : ''}`
const probe = (box: number, isp: number, world: number, web = '0.024215 0.043841 0.052842 204'): string => [
  '@route 192.168.1.1 eth0', '@dns 100.100.100.100', '@hop 10.0.0.77',
  `@box ${ping(box, '0.720')}`, `@isp ${ping(isp, '3.100')}`, `@world1 ${ping(world, '9.400')}`, `@world0 ${ping(world, '2.571')}`, `@web ${web}`,
  '@port LISTEN 0      4096                                  0.0.0.0:22    0.0.0.0:*',
  '@port LISTEN 0      4096                                     [::]:22       [::]:*',
  '@port LISTEN 0      2048                                127.0.0.1:8750  0.0.0.0:* users:(("uvicorn",pid=2921986,fd=13))',
  '@port LISTEN 0      4096                            127.0.0.53%lo:53    0.0.0.0:*',
  '@port LISTEN 0      4096                                        *:11434       *:* users:(("ollama",pid=12,fd=3))',
].join('\n')

test('a ping\'s summary gives what answered and how fast, silence gives nothing', () => {
  expect(parsePing(ping(3, '0.720'))).toEqual({ sent: 3, got: 3, ms: 0.72 })
  expect(parsePing(ping(0, ''))).toEqual({ sent: 3, got: 0, ms: 0 })
  expect(parsePing('')).toEqual({ sent: 0, got: 0, ms: 0 })
  expect([sayMs(0.72), sayMs(24.4), sayReach({ sent: 3, got: 2, ms: 12.2 }), sayReach({ sent: 3, got: 0, ms: 0 }), sayReach({ sent: 0, got: 0, ms: 0 })]).toEqual(['0.7 ms', '24 ms', '12 ms · 1/3 lost', 'no answer', 'not asked'])
})

test('a reading is put together from the shell\'s lines, the ports once each and the open ones first', () => {
  const b = parseProbe(probe(3, 3, 3), { ...EMPTY, trail: [4, -1] }, 99)
  expect([b.gateway, b.device, b.dns, b.hop, b.at]).toEqual(['192.168.1.1', 'eth0', '100.100.100.100', '10.0.0.77', 99])
  expect([b.box.ms, b.isp.ms, b.world.map(r => r.ms)]).toEqual([0.72, 3.1, [2.571, 9.4]])
  expect(b.web).toEqual({ ok: true, name: 24, shake: 44, whole: 53 })
  expect(b.ports).toEqual([{ port: 22, open: true, who: 'ssh' }, { port: 11434, open: true, who: 'ollama' }, { port: 53, open: false, who: 'dns' }, { port: 8750, open: false, who: 'uvicorn' }])
  expect(b.trail).toEqual([4, -1, 2.571])                                      // the nearest of the two, after what was there
  expect(parseProbe('', EMPTY, 5).trail).toEqual([-1])                         // a shell that printed nothing: a reading all the same
  expect(parsePorts(['garbage'])).toEqual([])
})

test('the verdict names where the trouble starts, from the nearest outward', () => {
  const at = (box: number, isp: number, world: number, web?: string): string => verdict(parseProbe(probe(box, isp, world, web), EMPTY, 1)).text
  expect(verdict(parseProbe('@route  \n', EMPTY, 1)).text).toBe('no way out: this machine has no network')
  expect(at(0, 0, 0)).toBe('the box does not answer: the trouble is at home (cable, Wi-Fi, box)')
  expect(at(3, 0, 0)).toBe('the box answers but nothing beyond it: the line or the ISP')
  expect(at(3, 3, 0)).toBe('the ISP answers but nothing beyond it: the trouble is on their network or further')
  expect(at(2, 3, 3)).toBe('packets are lost between this machine and the box (Wi-Fi, cable)')
  expect(at(3, 3, 2)).toBe('packets are lost beyond the box')
  expect(at(3, 3, 3, '0 0 0 000')).toBe('the network answers but the web does not (names or HTTPS)')
  expect(at(3, 3, 3, '0.450 0.500 0.600 204')).toBe('names are slow to resolve (450 ms)')
  expect([at(3, 3, 3), verdict(parseProbe(probe(3, 3, 3), EMPTY, 1)).level]).toEqual(['all clear, from here to the world', 'fine'])
  expect(at(0, 3, 3)).toBe('all clear, from here to the world')                // a box that ignores pings is not a cut
})

test('only a connection that drops or comes back gets a word', () => {
  const up = parseProbe(probe(3, 3, 3), EMPTY, 1), down = parseProbe(probe(3, 0, 0), EMPTY, 2)
  expect([isUp(up), isUp(down)]).toEqual([true, false])
  expect([turned(up, down), turned(down, up), turned(up, up), turned(EMPTY, down)]).toEqual(['error', 'watch', undefined, undefined])
})

test('the public address is veiled, the ISP said by its name, the speed in Mbit/s', () => {
  expect([veil('203.0.113.42'), veil('2001:db8:85a3::8a2e'), veil('odd')]).toEqual(['203.0.·.·', '2001:db8:…', 'odd'])
  expect(sayOrg('AS64500 Example Telecom SA')).toBe('Example Telecom SA · AS64500')
  expect(parseWho('{"ip":"203.0.113.42","org":"AS64500 Example","city":"Paris","loc":"1,2"}')).toEqual({ ip: '203.0.113.42', org: 'AS64500 Example', city: 'Paris' })
  expect([parseWho('<html>'), parseWho('{}')]).toEqual([undefined, undefined])
  expect(parseSpeed('53757949\n12409257\n', 7)).toEqual({ down: 430, up: 99, at: 7 })
  expect(parseSpeed('0\n0\n', 7)).toBeUndefined()
})

test('the trail is a curve, the newest on the right, taller when slower, with a gap where nothing answered', () => {
  expect(curve([], 4, 1)).toEqual(['⠀⠀⠀⠀'])
  expect(curve([50, -1, 25, 1], 3, 1)).toEqual(['⠀⡇⣄'])                      // full height, a gap, then half and one dot in the same cell
  expect(curve([100, 100], 1, 2)).toEqual(['⣿', '⣿'])
})
