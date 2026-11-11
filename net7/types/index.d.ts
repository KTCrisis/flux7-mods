// What came back from a few pings to one place: how many were sent, how many answered, and the average time of
// those (milliseconds, 0 when none answered).
export type Reach = { sent: number; got: number; ms: number }

// A TCP port this machine listens on: `open` when it listens beyond the loopback (the network can reach it),
// `who` the program when the system says it, or the usual name of the port.
export type Port = { port: number; open: boolean; who: string }

// One reading of the connection. The way out (`device`, `gateway`), the resolver (`dns`), the ISP's first router
// (`hop`, the second router on the way, empty when it does not show itself), what answered at each distance (the
// box, that router, two public resolvers), how long one small HTTPS page took (the name, the handshake done, the
// whole, in ms), the listening ports, and the trail: the world's time at each of the last readings (-1 when
// nothing answered). `at` is when (ms, 0 before the first reading).
export type Board = {
  at: number
  device: string
  gateway: string
  dns: string
  hop: string
  box: Reach
  isp: Reach
  world: Reach[]
  web: { ok: boolean; name: number; shake: number; whole: number }
  ports: Port[]
  trail: number[]
}

// A device that answered on the home network: its address, its hardware address, the name the network knows it
// by (empty when none) and its maker, read from the hardware address ("private address" when the device made
// one up, as phones do).
export type Device = { ip: string; mac: string; name: string; maker: string }

// Who the world sees: the public address, the ISP and its city, asked once a session from ipinfo.io.
export type Who = { ip: string; org: string; city: string }

// The last speed test, in Mbit/s, and when.
export type Speed = { down: number; up: number; at: number }

// Someone who came in over SSH in the last thirty days: how many times, by which method (publickey, password),
// under which account, from which address.
export type Entry = { n: number; method: string; user: string; from: string }

// One guard round, of this machine (`host` empty) or of a server reached over SSH. `reached` is false when the
// inside could not be looked at; `logs` is false when the SSH log could not be read (then `entries`, `failed`,
// `invalid`, `sources` and `named` are empty for want of reading, not for want of visitors). `from` is the
// address the server saw this machine come from, `self` the server's own addresses, `addr` the address it was
// tried at from outside. `entries` are those who came in; `failed` and `invalid` count the refused passwords and
// the names that do not exist; `sources` are where most of them came from, `named` the existing accounts they
// tried. `offers` is what sshd accepts from a caller who shows nothing. `keys` are the authorized keys files that
// could be read (how many keys, changed when, ms). `ghosts` are programs whose file is gone or lies in a
// temporary folder, among the `checked` ones: the system shows that file only to the program's own account, so
// `blind` counts the programs of the other accounts, which were not looked at (0 when the round runs as root). `fresh` are the units and cron files changed in thirty days, `cron` the lines of the user's
// crontab. `ports` is what listens (seen from inside), `doors` the ports that answered from outside.
export type Guard = {
  at: number
  host: string
  user: string
  name: string
  reached: boolean
  logs: boolean
  from: string
  self: string[]
  addr: string
  entries: Entry[]
  failed: number
  invalid: number
  sources: { n: number; ip: string }[]
  named: { n: number; user: string }[]
  offers: string[]
  keys: { path: string; count: number; at: number }[]
  checked: number
  blind: number
  ghosts: { pid: number; exe: string }[]
  fresh: string[]
  cron: number
  ports: Port[]
  doors: number[]
}

// What this mod asks avatar7 to say, if avatar7 is loaded: the connection just dropped, or is back. avatar7
// hears the write; nothing here depends on it.
export type Say = { mood: 'watch' | 'error'; event: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    net7: {
      board: Shaped<Board>   // kept under a tag (atom's shape): a change of fields declines the old value
      say: Say
    }
    // Read only: avatar7 owns it and says which face is on duty; the frame takes its color.
    avatar7: { color: string }
  }
}
