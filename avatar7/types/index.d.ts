export type Line = { text: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    avatar7: { line: Line; isMuted: boolean; volume: number; avatar: string; color: string }
  }
}
