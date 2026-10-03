export type Line = { text: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    shodan7: { line: Line; isMuted: boolean }
  }
}
