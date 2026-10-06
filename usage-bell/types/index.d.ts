// What this mod asks of avatar7 when it toasts, if avatar7 is loaded: the
// face (calm, or amber for a warning) and what happened. avatar7 hears the
// write; nothing here depends on it.
export type Announce = { mood: 'watch' | 'error'; event: string }

// A model call another mod published (avatar7, jukebox7): read only here.
export type ModelUse = { model: string; input: number; output: number; cacheRead: number; at: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-bell': { announce: Announce }
    avatar7: { modelUse: ModelUse }
    jukebox7: { modelUse: ModelUse }
  }
}
