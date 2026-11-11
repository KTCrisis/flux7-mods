// net7: the connection in a pane. Every half minute while the pane is open, a few pings at four distances (the
// box, the ISP's first router, two public resolvers) and one small HTTPS page say whether the network is well
// and, when it is not, where the trouble starts: at home, at the ISP, or further. Under it, the ports this
// machine opens to the network. A speed test runs only when asked (/net speed): it spends bandwidth.
// Nothing is installed for it: ping, curl, ip and ss do the work, in one shell call per reading.
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Board, Device, Port, Reach, Say, Speed, Who } from '../types'

const PANE = 'net7'
const READ_MS = 30_000
const TRAIL = 80
const NONE: Reach = { sent: 0, got: 0, ms: 0 }
const EMPTY: Board = { at: 0, device: '', gateway: '', dns: '', hop: '', box: NONE, isp: NONE, world: [], web: { ok: false, name: 0, shake: 0, whole: 0 }, ports: [], trail: [] }
// Change the tag when the board's fields change: it declines what an earlier version stored.
const board = atom({ plugin: 'net7', key: 'board' } as const, EMPTY, { shape: 'board-1' })
let tick: { cancel: () => void } | undefined
// Asked once a session, and measured on demand: the module's own, the drawing is told when they change.
let who: Who | undefined
let speed: Speed | undefined
let measuring = false
// The devices of the home network, counted when asked (/net lan).
let lan: { at: number; net: string; devices: Device[] } | undefined

// ---- the reading

const WORLD = ['1.1.1.1', '9.9.9.9'] as const
const PAGE = 'https://cp.cloudflare.com/generate_204'
// One shell for a whole reading, every probe at once, each answering on one line under its name. The ISP's
// first router is found by a ping that is allowed two routers and no more: the second one says so, and names
// itself. It is passed back in ($0) at the next reading so that it is looked for only once.
const PROBE = `
gw=$(ip route show default 2>/dev/null | awk 'NR==1{print $3}'); dev=$(ip route show default 2>/dev/null | awk 'NR==1{print $5}')
echo "@route $gw $dev"
echo "@dns $(awk '$1=="nameserver"{print $2; exit}' /etc/resolv.conf 2>/dev/null)"
hop="$0"
[ -n "$hop" ] || hop=$(ping -n -c 1 -t 2 -W 1 ${WORLD[0]} 2>/dev/null | awk '/exceeded/{print $2; exit}')
echo "@hop $hop"
p() { echo "@$1 $(ping -n -c 3 -i 0.2 -W 1 -q "$2" 2>/dev/null | tail -2 | tr '\\n' ' ')"; }
[ -n "$gw" ] && p box "$gw" &
[ -n "$hop" ] && p isp "$hop" &
p world0 ${WORLD[0]} &
p world1 ${WORLD[1]} &
echo "@web $(curl -o /dev/null -s -m 6 -w '%{time_namelookup} %{time_appconnect} %{time_total} %{http_code}' ${PAGE})" &
wait
ss -tlnpH 2>/dev/null | sed 's/^/@port /'
`
export const probeArgv = (hop: string): string[] => ['sh', '-c', PROBE, hop]

// "3 packets transmitted, 3 received, 0% packet loss, time 408ms rtt min/avg/max/mdev = 0.609/0.720/0.781/0.078 ms"
export const parsePing = (text: string): Reach => {
  const count = /(\d+) packets transmitted, (\d+) received/.exec(text)
  if (count === null) return NONE
  return { sent: Number(count[1]), got: Number(count[2]), ms: Number(/= [\d.]+\/([\d.]+)\//.exec(text)?.[1] ?? 0) }
}
// The names of the ports whose program the system keeps to itself (they belong to root).
const USUAL: Record<number, string> = { 22: 'ssh', 53: 'dns', 80: 'http', 443: 'https', 631: 'cups', 3389: 'rdp', 5432: 'postgres', 6379: 'redis' }
// ss's listening sockets, one port once (IPv4 and IPv6 are the same door): open as soon as one of its addresses
// is not the loopback. The open ones first, then by number.
export const parsePorts = (lines: readonly string[]): Port[] => {
  const seen = new Map<number, Port>()
  for (const line of lines) {
    const local = line.trim().split(/\s+/)[3] ?? ''
    const cut = local.lastIndexOf(':')
    const port = Number(local.slice(cut + 1))
    if (cut < 0 || !Number.isInteger(port) || port <= 0) continue
    const host = local.slice(0, cut)
    const open = !(host.startsWith('127.') || host === '[::1]')
    const name = /\(\("([^"]+)"/.exec(line)?.[1] ?? USUAL[port] ?? ''
    const before = seen.get(port)
    seen.set(port, { port, open: open || (before?.open ?? false), who: before?.who || name })
  }
  return [...seen.values()].sort((a, b) => Number(b.open) - Number(a.open) || a.port - b.port)
}
// The whole reading from what the shell printed; the trail of the readings before is carried on.
export const parseProbe = (out: string, before: Board, at: number): Board => {
  const of = (name: string): string[] => out.split('\n').filter(l => l.startsWith(`@${name} `) || l === `@${name}`).map(l => l.slice(name.length + 2).trim())
  const [gateway = '', device = ''] = (of('route')[0] ?? '').split(/\s+/)
  // Each under its own name: the two pings run at once and answer in any order.
  const world = WORLD.map((_, i) => parsePing(of(`world${i}`)[0] ?? ''))
  const [name = 0, shake = 0, whole = 0, code = 0] = (of('web')[0] ?? '').split(/\s+/).map(Number)
  const answered = world.filter(r => r.got > 0)
  const ms = answered.length === 0 ? -1 : Math.min(...answered.map(r => r.ms))
  return {
    at, device, gateway,
    dns: of('dns')[0] ?? '',
    hop: of('hop')[0] ?? '',
    box: parsePing(of('box')[0] ?? ''),
    isp: parsePing(of('isp')[0] ?? ''),
    world,
    web: { ok: code >= 200 && code < 400, name: Math.round(name * 1000), shake: Math.round(shake * 1000), whole: Math.round(whole * 1000) },
    ports: parsePorts(of('port')),
    trail: [...before.trail, ms].slice(-TRAIL),
  }
}

// ---- what it means

export const isUp = (b: Board): boolean => b.world.some(r => r.got > 0)
const lost = (r: Reach): number => (r.sent === 0 ? 0 : r.sent - r.got)
const SLOW_MS = 80
const SLOW_NAME_MS = 300
// Where the trouble starts, read from the nearest outward: 'error' when the connection is cut, 'warn' when it
// limps, 'fine' otherwise.
export const verdict = (b: Board): { level: 'fine' | 'warn' | 'error'; text: string } => {
  if (b.gateway === '') return { level: 'error', text: 'no way out: this machine has no network' }
  if (b.box.got === 0 && !isUp(b)) return { level: 'error', text: 'the box does not answer: the trouble is at home (cable, Wi-Fi, box)' }
  if (!isUp(b)) return { level: 'error', text: b.isp.got > 0 ? 'the ISP answers but nothing beyond it: the trouble is on their network or further' : 'the box answers but nothing beyond it: the line or the ISP' }
  // A box that answers no ping at all while the world does is only a box that ignores them.
  if (b.box.got > 0 && lost(b.box) > 0) return { level: 'warn', text: 'packets are lost between this machine and the box (Wi-Fi, cable)' }
  if (b.world.some(r => lost(r) > 0)) return { level: 'warn', text: lost(b.isp) > 0 ? 'packets are lost from the ISP on' : 'packets are lost beyond the box' }
  if (!b.web.ok) return { level: 'warn', text: 'the network answers but the web does not (names or HTTPS)' }
  if (b.web.name >= SLOW_NAME_MS) return { level: 'warn', text: `names are slow to resolve (${b.web.name} ms)` }
  const ms = Math.min(...b.world.filter(r => r.got > 0).map(r => r.ms))
  if (ms >= SLOW_MS) return { level: 'warn', text: `the world is far today (${Math.round(ms)} ms)` }
  return { level: 'fine', text: 'all clear, from here to the world' }
}
// What is worth a word aloud: the connection that was there is gone, or the one that was gone is back. A first
// reading has nothing to compare with.
export const turned = (before: Board, now: Board): Say['mood'] | undefined =>
  before.at === 0 || isUp(before) === isUp(now) ? undefined : isUp(now) ? 'watch' : 'error'

// "0.7 ms" under ten, "24 ms" over.
export const sayMs = (ms: number): string => `${ms < 10 ? ms.toFixed(1) : String(Math.round(ms))} ms`
export const sayReach = (r: Reach): string => (r.sent === 0 ? 'not asked' : r.got === 0 ? 'no answer' : `${sayMs(r.ms)}${r.got < r.sent ? ` · ${r.sent - r.got}/${r.sent} lost` : ''}`)
// The public address with its last half hidden: enough to know it, not enough to give it away on a capture.
export const veil = (ip: string): string => (ip.includes(':') ? `${ip.split(':').slice(0, 2).join(':')}:…` : ip.split('.').length === 4 ? `${ip.split('.').slice(0, 2).join('.')}.·.·` : ip)
// "AS15557 Societe Francaise Du Radiotelephone - SFR SA" is "Societe Francaise Du Radiotelephone - SFR SA · AS15557"
export const sayOrg = (org: string): string => org.replace(/^(AS\d+)\s+(.*)$/, '$2 · $1')
export const parseWho = (text: string): Who | undefined => {
  try {
    const got = JSON.parse(text) as { ip?: string; org?: string; city?: string }
    return typeof got.ip === 'string' ? { ip: got.ip, org: got.org ?? '', city: got.city ?? '' } : undefined
  } catch {
    return undefined
  }
}

// The trail as a small curve in braille dots, two readings to a cell, the newest on the right: the taller the
// slower, against the slowest of the trail (or 50 ms, so that a calm line stays low). A reading that got no
// answer leaves a gap.
export const curve = (trail: readonly number[], cells: number, rows: number): string[] => {
  const shown = trail.slice(-cells * 2)
  const top = Math.max(50, ...shown)
  const out = Array.from({ length: rows }, () => new Array<number>(cells).fill(0))
  const offset = cells * 2 - shown.length
  shown.forEach((ms, i) => {
    if (ms < 0) return
    const x = offset + i, high = Math.max(1, Math.round((ms / top) * rows * 4))
    for (let k = 0; k < high; k++) {
      const row = out[rows - 1 - (k >> 2)]
      // braille numbers its dots down the left column, then down the right; the fourth row came later (0x40, 0x80)
      if (row !== undefined) row[x >> 1] = (row[x >> 1] ?? 0) | ([[0x40, 0x80], [0x04, 0x20], [0x02, 0x10], [0x01, 0x08]][k & 3]?.[x & 1] ?? 0)
    }
  })
  return out.map(row => row.map(v => String.fromCharCode(0x2800 + v)).join(''))
}

// ---- the speed test

const DOWN = 'https://speed.cloudflare.com/__down?bytes=200000000'
const UP = 'https://speed.cloudflare.com/__up'
// Eight seconds down, then 25 MB up: curl's own average, in bytes a second, one per line.
export const speedArgv = (): string[] => [
  'sh',
  '-c',
  `curl -s -m 8 -o /dev/null -w '%{speed_download}\\n' "${DOWN}"; head -c 25000000 /dev/zero | curl -s -m 10 -o /dev/null -w '%{speed_upload}\\n' --data-binary @- "${UP}"`,
]
export const parseSpeed = (out: string, at: number): Speed | undefined => {
  const [down = 0, up = 0] = out.trim().split(/\s+/).map(Number)
  return down > 0 ? { down: Math.round((down * 8) / 1e6), up: Math.round(((Number.isFinite(up) ? up : 0) * 8) / 1e6), at } : undefined
}

// ---- the home network

// Who is on the home network: nmap knocks once at every address (no root: it only tries to connect), which makes
// the system ask each one for its hardware address; the system's own table then lists the ones that answered,
// even those that refuse every connection. Only a private network of a thousand addresses at most is swept:
// anywhere else (a public address, a large company network) the sweep is refused.
const SWEEP = `
command -v nmap >/dev/null || { echo "@nonmap"; exit 0; }
dev=$(ip route show default 2>/dev/null | awk 'NR==1{print $5}'); net=$(ip -4 -o addr show dev "$dev" 2>/dev/null | awk 'NR==1{print $4}')
echo "@net $net"
case "$net" in 10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) ;; *) echo "@refused"; exit 0;; esac
[ "\${net##*/}" -ge 22 ] || { echo "@refused"; exit 0; }
nmap -sn -n -T4 --max-retries 1 "$net" >/dev/null 2>&1
ip -4 neigh show dev "$dev" | awk '/lladdr/ && $NF!="FAILED"{print $1, $3}' | while read ip mac; do
  pre=$(echo "$mac" | tr -d : | cut -c1-6 | tr a-f A-F)
  echo "@lan $ip $mac $(timeout 1 getent hosts "$ip" | awk '{print $2; exit}')|$(grep -m1 "^$pre " /usr/share/nmap/nmap-mac-prefixes 2>/dev/null | cut -d' ' -f2-)"
done
`
export const sweepArgv = (): string[] => ['sh', '-c', SWEEP]
// A hardware address a phone or a laptop made up for this network instead of showing its maker's (the second
// digit says so: 2, 6, A or E).
const isPrivate = (mac: string): boolean => /^.[26ae]/i.test(mac)
// The devices from what the sweep printed, by address; the box is named as such. `refused` when the network is
// not one this mod sweeps, `missing` when nmap is not installed.
export const parseSweep = (out: string, gateway: string): { net: string; devices: Device[]; refused: boolean; missing: boolean } => {
  const lines = out.split('\n')
  const devices = lines.filter(l => l.startsWith('@lan ')).flatMap(l => {
    const [ip = '', mac = '', ...rest] = l.slice(5).split(' ')
    const [name = '', maker = ''] = rest.join(' ').split('|')
    return ip === '' ? [] : [{ ip, mac, name: ip === gateway ? 'the box' : name.replace(/\.(home|lan|local|localdomain)$/, ''), maker: maker.trim() || (isPrivate(mac) ? 'private address' : '') }]
  })
  const last = (ip: string): number => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0)
  return { net: lines.find(l => l.startsWith('@net '))?.slice(5).trim() ?? '', devices: devices.sort((a, b) => last(a.ip) - last(b.ip)), refused: lines.includes('@refused'), missing: lines.includes('@nonmap') }
}

// ---- the pane

// The palette the mods share, avatar7's.
const BLACK = '#000000'
const CYAN = '#00e5ff'
const RED = '#ff2a6d'
const AMBER = '#ffb000'
const GREEN = '#3ddc84'
const HELP = '/net: open the pane and read the connection · /net now: read again · /net speed: measure the speed (spends about 200 MB at most) · /net lan: count the devices of the home network (needs nmap) · /net who: the public address in full · /net off: close the pane'
// Read only: avatar7 owns it and says which face is on duty; the frame takes its color, as jukebox7's does.
const tint = { plugin: 'avatar7', key: 'color' } as const

const say = async ($: Engine, mood: Say['mood'], text: string): Promise<void> => {
  await $.state.set({ plugin: 'net7', key: 'say' } as const, { mood, event: text, at: Date.now() } satisfies Say)
}
const load = async ($: Engine): Promise<void> => {
  const before = await read($, board)
  const out = (await $.process.run(probeArgv(before.hop), { timeoutMs: 20_000 })).stdout
  const now = parseProbe(out, before, Date.now())
  await update($, board, () => now)
  const turn = turned(before, now)
  if (turn !== undefined) await say($, turn, turn === 'error' ? `the internet connection just dropped: ${verdict(now).text}` : 'the internet connection is back')
  // Who the world sees is asked once, and only when there is a world to ask.
  if (who === undefined && isUp(now)) {
    try {
      const answer = await $.http.fetch('https://ipinfo.io/json')
      who = answer.ok ? parseWho(answer.text) : undefined
      $.ui.invalidate('ui.render')
    } catch { /* asked again at the next reading */ }
  }
}
const watch = ($: Engine): void => {
  if (tick === undefined) tick = $.clock.every(READ_MS, () => void load($))
}
const show = async ($: Engine): Promise<void> => {
  await $.ui.open({ id: PANE, title: 'net7', rows: 26 })
  watch($)
  await load($)
}
const hour = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const register: Register = on => {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    watch($)            // after a reload the pane is still open and the timer is gone
    const b = await read($, board)
    const { value: color } = await $.state.get(tint)
    const accent = typeof color === 'string' && color !== '' ? color : CYAN
    const rows = e.props.scroll?.bodyRows ?? 22
    const columns = e.props.bodyColumns ?? 80
    const inner = Math.max(30, columns - 4)
    if (b.at === 0) return <Box width="100%" height={rows > 0 ? rows : undefined} backgroundColor={BLACK}><Text backgroundColor={BLACK} dimColor>reading the connection…</Text></Box>
    const v = verdict(b)
    const shade = (r: Reach): string => (r.sent === 0 ? '' : r.got === 0 ? RED : r.got < r.sent ? AMBER : GREEN)
    const row = (name: string, where: string, r: Reach) => (
      <Text key={name + where} backgroundColor={BLACK} wrap="truncate-end">
        <Text dimColor>{name.padEnd(7)}</Text>
        <Text color={shade(r) || undefined} dimColor={r.sent === 0}>{sayReach(r).padEnd(18)}</Text>
        <Text dimColor>{where}</Text>
      </Text>
    )
    const open = b.ports.filter(p => p.open), local = b.ports.length - open.length
    // The frame: its two borders and ten rows at most. The curve takes two rows, the ports what is left.
    const curveRows = rows >= 18 ? 2 : 0
    // Under the curve, the devices of the home network once they were counted (two rows are kept for the ports),
    // then the ports.
    const under = Math.max(0, rows - 12 - curveRows)
    const half = Math.max(1, Math.floor((columns - 2) / 40))
    const devices = lan === undefined ? [] : lan.devices.slice(0, Math.max(0, under - 3) * half)
    const deviceRows = lan === undefined ? 0 : 1 + Math.ceil(devices.length / half)
    const portRows = Math.max(0, under - deviceRows - 1)
    const perRow = Math.max(1, Math.floor((columns - 2) / 18))
    const listed = open.slice(0, portRows * perRow)
    return (
      <Box flexDirection="column" width="100%" height={rows > 0 ? rows : undefined} backgroundColor={BLACK}>
        <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} backgroundColor={BLACK}>
          <Text backgroundColor={BLACK} bold color={v.level === 'fine' ? GREEN : v.level === 'warn' ? AMBER : RED} wrap="truncate-end">{v.text}</Text>
          <Text backgroundColor={BLACK} wrap="truncate-end">
            <Text dimColor>{'link   '}</Text>
            {`${b.device || 'none'} · dns ${b.dns || 'none'}`.slice(0, inner - 7)}
          </Text>
          <Text backgroundColor={BLACK} wrap="truncate-end">
            <Text dimColor>{'seen as'}</Text>
            {who === undefined ? <Text dimColor>{' not known yet'}</Text> : ` ${veil(who.ip)} · ${sayOrg(who.org)}${who.city === '' ? '' : ` · ${who.city}`}`.slice(0, inner - 7)}
          </Text>
          {row('box', b.gateway, b.box)}
          {row('isp', b.hop === '' ? 'its first router does not show itself' : b.hop, b.isp)}
          {b.world.map((r, i) => row('world', WORLD[i] ?? '', r))}
          <Text backgroundColor={BLACK} wrap="truncate-end">
            <Text dimColor>{'web    '}</Text>
            {b.web.ok ? <Text color={b.web.name >= SLOW_NAME_MS ? AMBER : GREEN}>{`name ${b.web.name} ms · secured ${b.web.shake} ms · page ${b.web.whole} ms`}</Text> : <Text color={RED}>no answer</Text>}
          </Text>
          <Text backgroundColor={BLACK} wrap="truncate-end">
            <Text dimColor>{'speed  '}</Text>
            {measuring ? <Text color={AMBER}>measuring…</Text> : speed === undefined ? <Text dimColor>/net speed measures it</Text> : `↓ ${speed.down} Mbit/s · ↑ ${speed.up} Mbit/s`}
            {!measuring && speed !== undefined && <Text dimColor>{`  at ${hour(speed.at)}`}</Text>}
          </Text>
          <Text backgroundColor={BLACK} dimColor wrap="truncate-end">
            <Text color={CYAN}>{hour(b.at)}</Text>
            {` · read every 30 s · ${open.length} ports open to the network, ${local} to this machine only`}
          </Text>
        </Box>
        {curveRows > 0 && curve(b.trail, Math.max(1, columns - 2), curveRows).map((line, y) => (
          <Text key={`c${y}`} backgroundColor={BLACK} color={v.level === 'error' ? RED : accent}>{` ${line}`}</Text>
        ))}
        {lan !== undefined && (
          <Text backgroundColor={BLACK} dimColor wrap="truncate-end">{` ${lan.devices.length} devices on ${lan.net} at ${hour(lan.at)}${devices.length < lan.devices.length ? ` (${lan.devices.length - devices.length} not shown)` : ''}`}</Text>
        )}
        {Array.from({ length: Math.ceil(devices.length / half) }, (_, y) => (
          <Text key={`d${y}`} backgroundColor={BLACK} wrap="truncate-end">
            {' '}
            {devices.slice(y * half, (y + 1) * half).map(d => (
              <Text key={d.ip}>
                <Text color={CYAN}>{d.ip.padEnd(16)}</Text>
                <Text dimColor={d.name === ''}>{(d.name || d.maker || 'unknown').slice(0, 22).padEnd(24)}</Text>
              </Text>
            ))}
          </Text>
        ))}
        {Array.from({ length: Math.ceil(listed.length / perRow) }, (_, y) => (
          <Text key={`p${y}`} backgroundColor={BLACK} wrap="truncate-end">
            {' '}
            {listed.slice(y * perRow, (y + 1) * perRow).map(p => (
              <Text key={String(p.port)}>
                <Text color={AMBER}>{String(p.port).padEnd(6)}</Text>
                <Text dimColor>{(p.who || '?').slice(0, 11).padEnd(12)}</Text>
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    )
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) { tick?.cancel(); tick = undefined }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'net', description: 'net7: the connection, where it is slow, the open ports, a speed test (/net, /net now, /net speed, /net lan, /net who, /net off, /net help)' })
    return next(e)
  })

  on('command.run', { command: 'net' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'off') {
      tick?.cancel(); tick = undefined
      await $.ui.close({ id: PANE })
      return { text: 'net7: the pane is closed and nothing is read any more (/net opens it again).' }
    }
    if (args === 'lan') {
      const gateway = (await read($, board)).gateway
      const got = parseSweep((await $.process.run(sweepArgv(), { timeoutMs: 60_000 })).stdout, gateway)
      if (got.missing) return { text: 'net7: nmap is not installed (sudo apt-get install nmap).' }
      if (got.refused || got.net === '') return { text: `net7: ${got.net === '' ? 'no network to sweep' : `${got.net} is not a home network (private, a thousand addresses at most): not swept`}.` }
      lan = { at: Date.now(), net: got.net, devices: got.devices }
      $.ui.invalidate('ui.render')
      return { text: `net7: ${got.devices.length} devices answered on ${got.net} (this machine not counted):\n${got.devices.map(d => `${d.ip.padEnd(16)}${d.mac}  ${[d.name, d.maker].filter(t => t !== '').join(' · ') || 'unknown'}`).join('\n')}` }
    }
    if (args === 'who') {
      if (who === undefined) await load($)
      return { text: who === undefined ? 'net7: the public address could not be asked (ipinfo.io did not answer).' : `net7: seen as ${who.ip} · ${sayOrg(who.org)}${who.city === '' ? '' : ` · ${who.city}`}` }
    }
    if (args === 'speed') {
      if (measuring) return { text: 'net7: a speed test is already running.' }
      measuring = true
      $.ui.invalidate('ui.render')
      try {
        speed = parseSpeed((await $.process.run(speedArgv(), { timeoutMs: 30_000 })).stdout, Date.now()) ?? speed
      } finally {
        measuring = false
        $.ui.invalidate('ui.render')
      }
      return { text: speed === undefined ? 'net7: the speed test gave nothing (speed.cloudflare.com did not answer).' : `net7: ↓ ${speed.down} Mbit/s · ↑ ${speed.up} Mbit/s, measured against Cloudflare.` }
    }
    if (args !== '' && args !== 'now') return { text: `net7: ${HELP}` }
    await show($)
    const b = await read($, board)
    return { text: `net7: ${verdict(b).text} (box ${sayReach(b.box)}, world ${sayReach(b.world[0] ?? NONE)}; read every 30 s while the pane is open, /net off closes it).` }
  })
}
