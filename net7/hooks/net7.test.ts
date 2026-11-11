import { expect, test } from 'claude-code/testing'

import { curve, guardArgv, isHost, isNear, isUp, judge, parseGuard, parsePing, parsePorts, parseProbe, parseSpeed, parseSweep, parseWho, sayGuard, sayMs, sayOrg, sayReach, turned, veil, verdict } from './register'

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

test('the home network\'s devices come by address, the box named, a made-up hardware address said so', () => {
  const got = parseSweep(['@net 192.168.1.55/24', '@lan 192.168.1.134 a0:b1:c2:00:00:01 desk.home|Intel Corporate', '@lan 192.168.1.1 00:11:22:33:44:55 box.home|', '@lan 192.168.1.20 de:ad:be:ef:00:01 |', '@lan 192.168.1.9 00:aa:bb:cc:dd:ee |'].join('\n'), '192.168.1.1')
  expect(got.devices).toEqual([
    { ip: '192.168.1.1', mac: '00:11:22:33:44:55', name: 'the box', maker: '' },
    { ip: '192.168.1.9', mac: '00:aa:bb:cc:dd:ee', name: '', maker: '' },
    { ip: '192.168.1.20', mac: 'de:ad:be:ef:00:01', name: '', maker: 'private address' },
    { ip: '192.168.1.134', mac: 'a0:b1:c2:00:00:01', name: 'desk', maker: 'Intel Corporate' },
  ])
  expect([got.net, got.refused, got.missing]).toEqual(['192.168.1.55/24', false, false])
  expect(parseSweep('@net 203.0.113.7/24\n@refused', '').refused).toBe(true)        // not a private network: not swept
  expect(parseSweep('@nonmap', '').missing).toBe(true)
})

// What the guard's shells print for a server: seen from outside first, then from inside.
const round = (over: { blind?: number; logs?: boolean; offers?: string; doors?: number[]; entries?: string[]; inside?: boolean; ghost?: string } = {}): string => [
  '@addr 203.0.113.7',
  `@offers ${over.offers ?? 'publickey'}`,
  ...(over.doors ?? [22, 80, 443]).map(p => `@door ${p}`),
  ...(over.inside === false ? [] : [
    '@me deploy web1', '@from 198.51.100.4', '@self 203.0.113.7',
    ...(over.logs === false ? ['@logs no'] : ['@logs yes', '@fail 36897 16030', ...(over.entries ?? ['@in 703 publickey deploy 198.51.100.4']), '@src 1995 192.0.2.9', '@src 2884 192.0.2.50', '@named 40 backup', '@named 17538 root']),
    '@offers publickey,password',                                               // what sshd says to itself: the outside answer came first and is kept
    '@keys /home/deploy/.ssh/authorized_keys 1 1773615000',
    ...(over.ghost === undefined ? [] : [`@ghost ${over.ghost}`]),
    `@procs 41 ${over.blind ?? 0}`,
    '@new /etc/systemd/system/app.service', '@cron 2',
    '@port LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*', '@port LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=9,fd=8))', '@port LISTEN 0 4096 127.0.0.1:5432 0.0.0.0:*',
  ]),
].join('\n')

test('a guard round is put together from both sides, the busiest sources and names first', () => {
  const g = parseGuard(round(), 'web1', 9)
  expect([g.host, g.user, g.name, g.reached, g.logs, g.from, g.self, g.addr, g.at]).toEqual(['web1', 'deploy', 'web1', true, true, '198.51.100.4', ['203.0.113.7'], '203.0.113.7', 9])
  expect(g.entries).toEqual([{ n: 703, method: 'publickey', user: 'deploy', from: '198.51.100.4' }])
  expect([g.failed, g.invalid, g.sources, g.named]).toEqual([36897, 16030, [{ n: 2884, ip: '192.0.2.50' }, { n: 1995, ip: '192.0.2.9' }], [{ n: 17538, user: 'root' }, { n: 40, user: 'backup' }]])
  expect([g.offers, g.doors, g.cron, g.fresh, g.ghosts, g.checked, g.blind]).toEqual([['publickey'], [22, 80, 443], 2, ['/etc/systemd/system/app.service'], [], 41, 0])
  expect(g.keys).toEqual([{ path: '/home/deploy/.ssh/authorized_keys', count: 1, at: 1773615000000 }])
  expect(g.ports.filter(p => p.open).map(p => p.port)).toEqual([22, 443])
  expect(judge(g)).toEqual({ level: 'fine', notes: ['nothing wrong: 703 SSH entries in 30 days, all from near, 36897 passwords refused'] })
})

test('the guard names what is left ajar, and an entry from elsewhere before anything else', () => {
  const notes = (over: Parameters<typeof round>[0]): string[] => judge(parseGuard(round(over), 'web1', 1)).notes
  expect(notes({ offers: 'publickey,password' })).toEqual(['sshd still takes password: a key alone would close it to guesses'])
  expect(notes({ doors: [22, 443, 3000, 8000] })).toEqual(['ports 3000, 8000 answer from outside'])
  expect(notes({ doors: [22, 3000] })).toEqual(['port 3000 answers from outside'])
  expect(notes({ ghost: '412 /tmp/.x/kworker' })).toEqual(['1 programs run from a file that is gone or from a temporary folder: 412 /tmp/.x/kworker'])
  // Programs that could not be looked at are counted in the verdict, never passed over.
  const partial = parseGuard(round({ blind: 87 }), 'web1', 1)
  expect(judge(partial)).toEqual({ level: 'fine', notes: ['nothing wrong in what could be read: 703 SSH entries in 30 days, all from near, 36897 passwords refused, 87 programs of other accounts not looked at'] })
  expect(sayGuard(partial)).toContain('  programs      41 looked at, none from a file that is gone or a temporary folder · 87 of other accounts not readable (root would see them)')
  // An unread log is said, never taken for a quiet month.
  const blind = parseGuard(round({ logs: false }), 'web1', 1)
  expect([blind.entries, blind.failed, judge(blind)]).toEqual([[], 0, { level: 'warn', notes: ['the SSH log could not be read (deploy is neither root nor in adm): who came in is not known'] }])
  const broken = judge(parseGuard(round({ entries: ['@in 2 password root 192.0.2.50', '@in 5 password deploy 100.101.49.13', '@in 1 publickey deploy 203.0.113.7'], offers: 'publickey,password' }), 'web1', 1))
  expect(broken).toEqual({ level: 'error', notes: ['2 SSH entries from elsewhere: 192.0.2.50 (root, password)', 'sshd still takes password: a key alone would close it to guesses'] })
  // The server that lets nobody in: what it shows from outside is kept.
  const shut = parseGuard(round({ inside: false, doors: [22] }), 'web1', 1)
  expect([shut.reached, shut.doors, judge(shut).level, judge(shut).notes[0]]).toEqual([false, [22], 'error', 'web1 could not be looked at from inside (no answer, or no key accepted)'])
})

test('near is home, the tailnet, the server itself and where the round comes from', () => {
  const g = { from: '198.51.100.4', self: ['203.0.113.7'] }
  expect(['192.168.1.20', '10.0.0.1', '172.20.0.3', '100.101.49.13', '127.0.0.1', '198.51.100.4', '203.0.113.7', 'fd7a:115c:a1e0::1', '::1'].map(ip => isNear(ip, g))).toEqual(Array(9).fill(true))
  expect(['192.0.2.50', '100.128.0.1', '172.32.0.1', '2001:db8::1'].map(ip => isNear(ip, g))).toEqual(Array(4).fill(false))
})

test('the guard takes a host as SSH knows it and nothing a shell or ssh would read otherwise', () => {
  expect(['web1', 'deploy@203.0.113.7', 'my-server.example.org'].map(isHost)).toEqual([true, true, true])
  expect(['-oProxyCommand=x', 'a b', 'a;b', '$(x)', ''].map(isHost)).toEqual([false, false, false, false, false])
  expect(guardArgv('').slice(0, 2)).toEqual(['sh', '-c'])
  const there = guardArgv('web1')
  expect([there[0], there[3], there[4]?.startsWith('sh -c \'')]).toEqual(['bash', 'web1', true])
})

test('the round is told in rows, an unread log as such and this machine without an outside', () => {
  const told = sayGuard(parseGuard(round({ doors: [22, 3000] }), 'web1', 1)).split('\n')
  expect(told[0]).toBe('net7 guard · web1 (deploy@web1): 1 thing to look at')
  expect(told[1]).toBe('  - port 3000 answers from outside')
  expect(told.find(l => l.includes('came in'))).toBe('  came in, 30 d 703 publickey deploy from 198.51.100.4 (here)')
  expect(told.find(l => l.startsWith('  from outside'))).toBe('  from outside  22, 3000 answer at 203.0.113.7')
  expect(sayGuard(parseGuard(round({ logs: false }), 'web1', 1))).toContain('came in, 30 d not readable')
  expect(sayGuard(parseGuard(round(), '', 1))).not.toContain('from outside')
})
