export type Line = { text: string; at: number }

// What a mod asks of the avatar when it toasts, published by that mod under
// its own `announce` key: the face to wear (calm, or amber for a warning) and
// what happened, for the line the avatar speaks.
export type Announce = { mood: 'watch' | 'error'; event: string }

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
    }
  }
}
