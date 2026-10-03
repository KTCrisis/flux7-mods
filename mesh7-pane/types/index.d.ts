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
export type Say = { mood: 'watch' | 'error' | 'deny' | 'wait'; event: string; at: number }

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
