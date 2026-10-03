// What this mod asks of avatar7 when it toasts, if avatar7 is loaded: the
// face (calm, or amber for a warning) and what happened. avatar7 hears the
// write; nothing here depends on it.
export type Announce = { mood: 'watch' | 'error'; event: string }

declare module 'claude-code' {
  interface PluginState {
    'atelier-bell': { announce: Announce }
  }
}
