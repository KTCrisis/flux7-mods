export type Line = { text: string; at: number }

// What a mod asks of the avatar when it toasts, published by that mod under
// its own `announce` key: the face to wear (calm, or amber for a warning) and
// what happened, for the line the avatar speaks.
// A persona's station: its name and the artists it would put on, none for a
// persona without one.
export type Station = { name: string; artists: string[] }

export type Announce = { mood: 'watch' | 'error'; event: string }

// What a mod asks the avatar to say now, with no toast: published under the
// mod's own `say` key, the face to wear, what happened, and when (ms), so the
// same event twice is still two writes. The avatar queues it by urgency.
export type Say = { mood: 'watch' | 'error' | 'deny' | 'wait'; event: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    avatar7: {
      line: Line
      isMuted: boolean
      volume: number
      avatar: string
      color: string
      // Each mod's announce, by plugin name, as heard; kept across a reload.
      announcers: Record<string, Announce>
      // True while a line is heard (the WAV playing), read by jukebox7 to duck.
      isVoicing: boolean
      // The on-duty persona's music, from its persona.json: jukebox7 plays it.
      station: Station
    }
  }
}
