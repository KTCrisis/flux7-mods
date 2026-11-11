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

// Who the world sees: the public address, the ISP and its city, asked once a session from ipinfo.io.
export type Who = { ip: string; org: string; city: string }

// The last speed test, in Mbit/s, and when.
export type Speed = { down: number; up: number; at: number }

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
