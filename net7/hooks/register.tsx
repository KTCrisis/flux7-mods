// net7: the connection in a pane. Every half minute while the pane is open, a few pings at four distances (the
// box, the ISP's first router, two public resolvers) and one small HTTPS page say whether the network is well
// and, when it is not, where the trouble starts: at home, at the ISP, or further. Under it, the ports this
// machine opens to the network. A speed test runs only when asked (/net speed): it spends bandwidth. So does the
// guard (/net guard): who came in over SSH, and what a server shows from outside.
// Nothing is installed for it: ping, curl, ip and ss do the work, in one shell call per reading.
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Board, Device, Entry, Guard, Listen, Port, Reach, Say, Speed, Who } from '../types'

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
// The last guard round (/net guard), of this machine or of a server.
let guard: Guard | undefined

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

// ---- the guard

// Who came in, and what is left ajar: one shell on the machine that is looked at, this one or a server reached
// over SSH. Nothing here asks for root, so what only root can read (the firewall's rules, root's own keys) is not
// read; and the SSH log is read only by root or by a member of adm or systemd-journal: when it cannot be, the
// shell says so (@logs no) rather than report a month without a single attempt. The log is boiled down where it
// lies, a busy server writes tens of megabytes of refused passwords a month. The same holds for the programs:
// the system shows the file a program runs from only to its own account, so those of root and of the others are
// counted as not looked at (@procs, its second number), the kernel's own threads aside (they have no command).
const GUARD = `
echo "@me $(id -un) $(hostname)"
echo "@from $(echo "$SSH_CONNECTION" | cut -d' ' -f1)"
ip -o addr show scope global 2>/dev/null | awk '{sub(/\\/.*/, "", $4); print "@self", $4}'
if [ "$(id -u)" = 0 ] || id -nG | tr ' ' '\\n' | grep -qxE 'adm|systemd-journal'; then
  echo "@logs yes"
  seen=$(journalctl -u ssh -u sshd --since "30 days ago" --no-pager -q -o cat 2>/dev/null | awk '
    /^Accepted /{a[$2" "$4" "$6]++}
    /^Failed password/{f++; for(i=1;i<=NF;i++){ if($i=="from") s[$(i+1)]++; if($i=="for" && $(i+1)!="invalid") u[$(i+1)]++ }}
    /^Invalid user/{v++}
    END{print "@fail", f+0, v+0; for(k in a) print "@in", a[k], k; for(k in s) print "@src", s[k], k; for(k in u) print "@named", u[k], k}')
  echo "$seen" | grep -E '^@(fail|in) '
  echo "$seen" | grep '^@src ' | sort -k2,2nr | head -3
  echo "$seen" | grep '^@named ' | sort -k2,2nr | head -5
else
  echo "@logs no"
fi
echo "@offers $(ssh -o BatchMode=yes -o PreferredAuthentications=none -o PubkeyAuthentication=no -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=4 "$(id -un)@127.0.0.1" true 2>&1 | sed -n 's/.*Permission denied (\\(.*\\))\\..*/\\1/p')"
for f in "$HOME/.ssh/authorized_keys" /root/.ssh/authorized_keys; do
  [ -r "$f" ] && echo "@keys $f $(grep -cvE '^[[:space:]]*(#|$)' "$f") $(stat -c %Y "$f")"
done
mine=0; blind=0
for p in /proc/[0-9]*; do
  if e=$(readlink "$p/exe" 2>/dev/null); then
    mine=$((mine+1))
    case "$e" in *" (deleted)"|/tmp/*|/dev/shm/*|/var/tmp/*) echo "@ghost $(basename "$p") $e";; esac
  elif [ -n "$(tr -d '\\0' < "$p/cmdline" 2>/dev/null | head -c 1)" ]; then
    blind=$((blind+1))
  fi
done
echo "@procs $mine $blind"
find /etc/systemd/system /etc/cron.d /etc/cron.hourly /etc/cron.daily "$HOME/.config/systemd/user" -maxdepth 1 -type f ! -name 'snap[.-]*' -mtime -30 2>/dev/null | head -12 | sed 's/^/@new /'
echo "@cron $(crontab -l 2>/dev/null | grep -cvE '^[[:space:]]*(#|$)')"
ss -tlnpH 2>/dev/null | sed 's/^/@port /'
`
// The doors a server is tried at from here: the usual ones, and those a service left in a hurry tends to keep.
const DOORS = [21, 22, 23, 25, 80, 443, 3000, 3306, 5000, 5432, 6379, 8000, 8080, 8443, 9000, 9090, 11434, 27017] as const
// A server is looked at twice. From outside first, which needs no right on it: its address as SSH resolves the
// name ($0), what its sshd offers to a caller who shows no key, and which doors answer. Then from inside, the
// shell above passed whole as the remote command ($1). The outside answer on what sshd offers comes first in
// what is printed, and the first one is kept: it is the one a stranger gets.
const OUTSIDE = `
addr=$(ssh -G "$0" 2>/dev/null | awk '$1=="hostname"{print $2; exit}')
echo "@addr $addr"
echo "@offers $(ssh -o BatchMode=yes -o PreferredAuthentications=none -o PubkeyAuthentication=no -o ConnectTimeout=6 "$0" true 2>&1 | sed -n 's/.*Permission denied (\\(.*\\))\\..*/\\1/p')"
for p in ${DOORS.join(' ')}; do (timeout 3 bash -c "exec 3<>/dev/tcp/$addr/$p" 2>/dev/null && echo "@door $p") & done
wait
ssh -o BatchMode=yes -o ConnectTimeout=8 "$0" "$1" 2>/dev/null
`
// A name SSH can be handed as it is: a host, user@host or an alias of ~/.ssh/config, and nothing that could be
// read as an option or by a shell.
export const isHost = (text: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9._@:-]*$/.test(text)
const quoted = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`
// This machine when no host is named.
export const guardArgv = (host: string): string[] => (host === '' ? ['sh', '-c', GUARD] : ['bash', '-c', OUTSIDE, host, `sh -c ${quoted(GUARD)}`])

const TAILNET = /^(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[?fd7a:)/i
const WIDER: Record<Listen['reach'], number> = { all: 2, tailnet: 1, one: 0 }
// What listens, and for whom: on every address of the machine ('all': the whole network can knock), on its
// tailnet address only ('tailnet'), or on one other address ('one'). What listens on the loopback alone is left
// out: nobody else reaches it. A port keeps the widest of its addresses.
export const parseListen = (lines: readonly string[]): Listen[] => {
  const seen = new Map<number, Listen>()
  for (const line of lines) {
    const local = line.trim().split(/\s+/)[3] ?? ''
    const cut = local.lastIndexOf(':')
    const port = Number(local.slice(cut + 1))
    const host = local.slice(0, cut).replace(/%[^\]]*/, '')
    if (cut < 0 || !Number.isInteger(port) || port <= 0 || host.startsWith('127.') || host === '[::1]') continue
    const reach: Listen['reach'] = host === '*' || host === '0.0.0.0' || host === '[::]' ? 'all' : TAILNET.test(host) ? 'tailnet' : 'one'
    const before = seen.get(port)
    seen.set(port, { port, who: before?.who || (/\(\("([^"]+)"/.exec(line)?.[1] ?? USUAL[port] ?? ''), reach: before !== undefined && WIDER[before.reach] > WIDER[reach] ? before.reach : reach })
  }
  return [...seen.values()].sort((a, b) => a.port - b.port)
}
// "22 ssh · 8443–8447 · 9090 mesh7": neighbours that share a name (or have none) are said as one stretch.
export const sayPorts = (ports: readonly { port: number; who: string }[]): string => {
  const runs: { from: number; to: number; who: string }[] = []
  for (const p of [...ports].sort((a, b) => a.port - b.port)) {
    const last = runs[runs.length - 1]
    if (last !== undefined && p.port === last.to + 1 && p.who === last.who) last.to = p.port
    else runs.push({ from: p.port, to: p.port, who: p.who })
  }
  return runs.map(r => `${r.from}${r.to > r.from ? `–${r.to}` : ''}${r.who === '' ? '' : ` ${r.who}`}`).join(' · ')
}
const tagged = (out: string, name: string): string[] => out.split('\n').filter(l => l.startsWith(`@${name} `)).map(l => l.slice(name.length + 2).trim())
const counted = (lines: readonly string[]): { n: number; what: string }[] => lines.map(l => ({ n: Number(l.split(' ')[0]), what: l.split(' ').slice(1).join(' ') })).filter(c => Number.isFinite(c.n) && c.what !== '').sort((a, b) => b.n - a.n)
// The round from what the shells printed. `reached` is false when the inside shell printed nothing (the server
// let nobody in without a password, or did not answer): what was seen from outside is kept all the same.
export const parseGuard = (out: string, host: string, at: number): Guard => {
  const [user = '', name = ''] = (tagged(out, 'me')[0] ?? '').split(' ')
  const [failed = 0, invalid = 0] = (tagged(out, 'fail')[0] ?? '').split(' ').map(Number)
  const [checked = 0, blind = 0] = (tagged(out, 'procs')[0] ?? '').split(' ').map(Number)
  const keys = new Map(tagged(out, 'keys').map(l => l.split(' ')).map(([path = '', count = '0', changed = '0']) => [path, { path, count: Number(count), at: Number(changed) * 1000 }] as const))
  return {
    at, host, user, name,
    reached: user !== '',
    logs: tagged(out, 'logs')[0] === 'yes',
    from: tagged(out, 'from')[0] ?? '',
    self: tagged(out, 'self'),
    addr: tagged(out, 'addr')[0] ?? '',
    entries: counted(tagged(out, 'in')).flatMap(c => {
      const [method = '', who = '', from = ''] = c.what.split(' ')
      return from === '' ? [] : [{ n: c.n, method, user: who, from }]
    }),
    failed, invalid,
    sources: counted(tagged(out, 'src')).map(c => ({ n: c.n, ip: c.what })),
    named: counted(tagged(out, 'named')).map(c => ({ n: c.n, user: c.what })),
    offers: (tagged(out, 'offers').find(l => l !== '') ?? '').split(',').filter(m => m !== ''),
    keys: [...keys.values()],
    checked, blind,
    ghosts: tagged(out, 'ghost').map(l => ({ pid: Number(l.split(' ')[0]), exe: l.split(' ').slice(1).join(' ') })),
    fresh: tagged(out, 'new'),
    cron: Number(tagged(out, 'cron')[0] ?? 0),
    ports: parseListen(tagged(out, 'port')),
    doors: tagged(out, 'door').map(Number).filter(Number.isInteger).sort((a, b) => a - b),
  }
}
// Where an address is, in a word.
export const whence = (ip: string, g: Pick<Guard, 'from' | 'self'>): 'here' | 'this machine' | 'tailnet' | 'home network' | 'elsewhere' =>
  ip === g.from ? 'here'
    : g.self.includes(ip) || /^(127\.|::1$)/.test(ip) ? 'this machine'
      : TAILNET.test(ip) ? 'tailnet'
        : /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fe80:|f[cd][0-9a-f]{2}:)/i.test(ip) ? 'home network'
          : 'elsewhere'
// An address that is no stranger: this machine or the home network, the tailnet (100.64.0.0/10), the machine
// that is looked at, or the one the round is made from.
export const isNear = (ip: string, g: Pick<Guard, 'from' | 'self'>): boolean =>
  whence(ip, g) !== 'elsewhere'
const PUBLIC_DOORS = [22, 80, 443]
// What the round found, the gravest first: 'error' for someone who came in from elsewhere (or a server that
// could not be entered at all), 'warn' for what is left ajar or could not be read, 'fine' otherwise. A password
// that got in from a near address is not an error of its own: it is said by "sshd still takes passwords".
export const judge = (g: Guard): { level: 'fine' | 'warn' | 'error'; notes: string[] } => {
  const errors: string[] = [], warns: string[] = []
  if (!g.reached) errors.push(`${g.host || 'this machine'} could not be looked at from inside (no answer, or no key accepted)`)
  const far = g.entries.filter(e => !isNear(e.from, g))
  if (far.length > 0) errors.push(`${far.reduce((n, e) => n + e.n, 0)} SSH entries from elsewhere: ${far.slice(0, 4).map(e => `${e.from} (${e.user}, ${e.method})`).join(', ')}`)
  if (g.ghosts.length > 0) warns.push(`${g.ghosts.length} programs run from a file that is gone or from a temporary folder: ${g.ghosts.slice(0, 3).map(p => `${p.pid} ${p.exe}`).join(', ')}`)
  if (g.offers.some(m => m !== 'publickey')) warns.push(`sshd still takes ${g.offers.filter(m => m !== 'publickey').join(' and ')}: a key alone would close it to guesses`)
  const odd = g.doors.filter(p => !PUBLIC_DOORS.includes(p))
  if (odd.length > 0) warns.push(`port${odd.length > 1 ? 's' : ''} ${odd.join(', ')} answer${odd.length > 1 ? '' : 's'} from outside`)
  if (g.reached && !g.logs) warns.push(`the SSH log could not be read (${g.user} is neither root nor in adm): who came in is not known`)
  const notes = [...errors, ...warns]
  if (notes.length > 0) return { level: errors.length > 0 ? 'error' : 'warn', notes }
  const entries = g.entries.reduce((n, e) => n + e.n, 0)
  // Never more than what was looked at: the programs of the other accounts stay unseen without root.
  return { level: 'fine', notes: [`nothing wrong${g.blind > 0 ? ' in what could be read' : ''}: ${entries} SSH entries in 30 days, all from near, ${g.failed} passwords refused${g.blind > 0 ? `, ${g.blind} programs of other accounts not looked at` : ''}`] }
}
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
// The round in full, for the answer to the command (the pane only keeps the verdict). The verdict first, then
// four questions in the order one asks them: who came in, what is open, what is new, and what was not looked at,
// so that the blind spots stand in one place instead of hiding in each row.
export const sayGuard = (g: Guard): string => {
  const v = judge(g)
  const mark = v.level === 'fine' ? '✓' : v.level === 'warn' ? '!' : '✗'
  const title = (text: string): string => `\n  ${text}`
  const row = (name: string, text: string): string => `    ${name.padEnd(20)}${text}`
  const wide = (key: 'user' | 'method'): number => Math.max(0, ...g.entries.map(e => e[key].length)) + 2
  const entry = (e: Entry): string => `    ${`${e.n}×`.padEnd(7)}${e.user.padEnd(wide('user'))}${e.method.padEnd(wide('method'))}${e.from.padEnd(17)}${whence(e.from, g)}`
  const at = (reach: Listen['reach']): Listen[] => g.ports.filter(p => p.reach === reach)
  const unseen = [
    ...(g.reached ? [] : ['everything inside: the keys, the programs, what listens']),
    ...(g.reached && !g.logs ? [`the SSH log, so who came in (${g.user} is neither root nor in adm)`] : []),
    ...(g.blind > 0 ? [`${g.blind} programs of other accounts (only root sees where they run from)`] : []),
    ...(g.reached && g.user !== 'root' ? ["the firewall's rules and root's own keys (root only)"] : []),
  ]
  return [
    `net7 guard · ${g.host || 'this machine'}${g.reached ? ` (${g.user}@${g.name})` : ''} · ${v.level === 'fine' ? 'all clear' : v.level === 'warn' ? `${v.notes.length} to fix` : 'alert'}`,
    ...v.notes.map(n => `  ${mark} ${n}`),
    ...(!g.reached || !g.logs ? [] : [
      title('who came in · 30 days'),
      ...(g.entries.length === 0 ? ['    nobody'] : g.entries.slice(0, 8).map(entry)),
      `    turned away: ${g.failed} passwords, ${g.invalid} unknown names${g.sources.length === 0 ? '' : ` · most from ${g.sources.map(s => `${s.ip} (${s.n})`).join(', ')}`}`,
      ...(g.named.length === 0 ? [] : [`    accounts they tried: ${g.named.map(n => `${n.user} ${n.n}`).join(' · ')}`]),
    ]),
    title('what is open'),
    row('sshd accepts', g.offers.length === 0 ? 'no answer (no sshd, or closed to here)' : g.offers.join(', ')),
    ...(g.host === '' ? [] : [row('answers from here', g.doors.length === 0 ? `nothing at ${g.addr || g.host}` : `${g.doors.join(' · ')}  (at ${g.addr || g.host})`)]),
    ...(!g.reached ? [] : [
      row('listens to everyone', at('all').length === 0 ? 'nothing' : sayPorts(at('all'))),
      ...(at('tailnet').length === 0 ? [] : [row('to the tailnet only', sayPorts(at('tailnet')))]),
      ...(at('one').length === 0 ? [] : [row('on one address only', sayPorts(at('one')))]),
      title('what is new · 30 days'),
      row('keys', g.keys.length === 0 ? 'none readable' : g.keys.map(k => `${k.count} in ${k.path.replace(/^\/home\/[^/]+/, '~')}, last changed ${day(k.at)}`).join(' · ')),
      row('units and cron', `${g.fresh.length === 0 ? 'nothing new' : g.fresh.map(f => f.split('/').pop()).join(' · ')} · ${g.cron} lines in ${g.user}'s crontab`),
      row('programs', `${g.checked} of ${g.user}'s looked at: ${g.ghosts.length === 0 ? 'none' : g.ghosts.map(p => `${p.pid} ${p.exe}`).join(', ')} from a deleted file or a temporary folder`),
    ]),
    ...(unseen.length === 0 ? [] : [title('not looked at'), ...unseen.map(u => `    ${u}`)]),
  ].join('\n')
}

// ---- the pane

// The palette the mods share, avatar7's.
const BLACK = '#000000'
const CYAN = '#00e5ff'
const RED = '#ff2a6d'
const AMBER = '#ffb000'
const GREEN = '#3ddc84'
const HELP = [
  'the connection, in a pane',
  '  /net                open the pane and read the connection',
  '  /net now            read again',
  '  /net off            close the pane',
  'on demand',
  '  /net speed          measure the speed (spends about 200 MB at most)',
  '  /net lan            count the devices of the home network (needs nmap)',
  '  /net who            the public address in full',
  'the guard',
  '  /net guard          who came in over SSH and what is open, on this machine',
  '  /net guard <host>   the same on a server, with what it shows from outside',
].join('\n')
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
    const under = Math.max(0, rows - 12 - curveRows - (guard === undefined ? 0 : 1))
    const round = guard === undefined ? undefined : judge(guard)
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
        {guard !== undefined && round !== undefined && (
          <Text backgroundColor={BLACK} wrap="truncate-end">
            <Text dimColor>{` guard ${guard.host || 'this machine'} at ${hour(guard.at)}: `}</Text>
            <Text color={round.level === 'fine' ? GREEN : round.level === 'warn' ? AMBER : RED}>{round.notes[0]}{round.notes.length > 1 ? ` (+${round.notes.length - 1})` : ''}</Text>
          </Text>
        )}
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
    await $.command.register({ name: 'net', description: 'net7: the connection, where it is slow, the open ports, a speed test, a guard round (/net, /net now, /net speed, /net lan, /net guard [host], /net who, /net off, /net help)' })
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
    if (args === 'guard' || args.startsWith('guard ')) {
      const host = args.slice(5).trim()
      if (host !== '' && !isHost(host)) return { text: 'net7: /net guard takes one host as SSH knows it (a name, user@host, or an alias of ~/.ssh/config).' }
      guard = parseGuard((await $.process.run(guardArgv(host), { timeoutMs: 60_000 })).stdout, host, Date.now())
      $.ui.invalidate('ui.render')
      return { text: sayGuard(guard) }
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
    if (args !== '' && args !== 'now') return { text: `net7\n${HELP}` }
    await show($)
    const b = await read($, board)
    return { text: `net7: ${verdict(b).text} (box ${sayReach(b.box)}, world ${sayReach(b.world[0] ?? NONE)}; read every 30 s while the pane is open, /net off closes it).` }
  })
}
