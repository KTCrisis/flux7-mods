export type Verdict = 'allow' | 'deny' | 'human_approval'

export type Decision = {
  id: string
  at: string
  agent: string
  tool: string
  verdict: Verdict
  rule: string
  hint: string
  approval: string
}

export type Pending = { id: string; agent: string; tool: string; rule: string; since: string }

export type Health = { isUp: boolean; version: string; halt: string }

// What this mod asks avatar7 to say, if avatar7 is loaded: mesh7 falling,
// halting, coming back. avatar7 hears the write; nothing here depends on it.
// tool: the call it is about, as Claude Code names it, so avatar7 drops its
// own line for it; hold and release: a call held for a human, then decided.
export type Say = {
  mood: 'watch' | 'error' | 'deny' | 'wait'
  event: string
  at: number
  tool?: string
  hold?: boolean
  release?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'mesh7-pane': {
      decisions: Decision[]
      pending: Pending[]
      health: Health
      isAll: boolean
      say: Say
    }
  }
}
