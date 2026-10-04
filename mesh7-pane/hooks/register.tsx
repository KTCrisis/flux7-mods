import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { Decision, Health, Pending, Say, Verdict } from '../types'

const PANE = 'mesh7-pane'
const MESH = 'http://localhost:9090'
const POLL_MS = 1500
const KEEP = 60

const decisions = atom({ plugin: 'mesh7-pane', key: 'decisions' } as const, [] as Decision[])
const pending = atom({ plugin: 'mesh7-pane', key: 'pending' } as const, [] as Pending[])
const health = atom({ plugin: 'mesh7-pane', key: 'health' } as const, { isUp: true, version: '', halt: '' } as Health)
const isAll = atom({ plugin: 'mesh7-pane', key: 'isAll' } as const, false)

const LOOK: Record<Verdict, { label: string; color: string }> = {
  allow: { label: 'ALLOW', color: '#3ddc84' },
  deny: { label: 'DENY ', color: '#ff2a6d' },
  human_approval: { label: 'HUMAN', color: '#ffb000' },
}

type Trace = {
  trace_id: string
  session_id?: string
  agent_id: string
  tool: string
  params?: Record<string, unknown>
  policy: string
  policy_rule: string
  timestamp: string
  approval_status?: string
}

type Approval = { id: string; agent_id: string; tool: string; policy_rule: string; status: string; created_at: string }

type Halt = { scope: string; target?: string; reason?: string; resumed_at?: string }

// What a call was about, in one short line.
const hintOf = (params: Record<string, unknown> | undefined): string => {
  if (params === undefined) return ''
  const v = params.command ?? params.file_path ?? params.path ?? params.url ?? params.pattern ?? params.key ?? params.query
  return String(v ?? JSON.stringify(params)).replace(/\s+/g, ' ').slice(0, 120)
}

const clock = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toTimeString().slice(0, 8)
}

const ago = (iso: string, now: number): string => {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  return s < 120 ? `${s}s` : `${Math.round(s / 60)}m`
}

// What changed in mesh7's health between two polls, as a line for avatar7,
// or undefined when nothing did.
export const meshShift = (before: Health, after: Health): Omit<Say, 'at'> | undefined => {
  if (after.halt !== '' && after.halt !== before.halt) return { mood: 'deny', event: `mesh7 EMERGENCY STOP: ${after.halt}` }
  if (after.halt === '' && before.halt !== '') return { mood: 'watch', event: 'mesh7 emergency stop lifted, tools run again' }
  if (!after.isUp && before.isUp) return { mood: 'error', event: 'mesh7 went down, every tool call now fails closed' }
  if (after.isUp && !before.isUp) return { mood: 'watch', event: 'mesh7 is back up' }
  return undefined
}

// The health of a poll kept, and a shift since the one before told to
// avatar7 under this mod's `say` key; none before the first, so a load is silent.
async function report($: Engine, before: Health | null, now: Health): Promise<Health> {
  const shift = before === null ? undefined : meshShift(before, now)
  await update($, health, () => now)
  if (shift !== undefined) await $.state.set({ plugin: 'mesh7-pane', key: 'say' }, { ...shift, at: Date.now() })
  return now
}

// A trace's tool as Claude Code names it: MCP calls reach mesh7 as
// `server.tool` and Claude Code calls them `mcp__mesh7__server_tool`; the
// hook's built-in tools (Bash, Read...) keep their name.
export const claudeName = (tool: string): string =>
  tool.includes('.') ? `mcp__mesh7__${tool.replace('.', '_')}` : tool

// What a fresh decision of this session tells avatar7, or undefined: a
// refusal, or an MCP call held for a human (a held Bash call is Claude
// Code's own permission prompt, which avatar7 already sees).
export const verdictSay = (d: { tool: string; verdict: Verdict; rule: string; hint: string }): Omit<Say, 'at'> | undefined => {
  const tool = claudeName(d.tool)
  const what = d.hint === '' ? d.tool : `${d.tool} ${d.hint.slice(0, 60)}`
  if (d.verdict === 'deny') return { mood: 'deny', event: `mesh7 DENIED ${what}, by rule ${d.rule}`, tool }
  if (d.verdict === 'human_approval' && d.tool.includes('.')) {
    return { mood: 'wait', event: `mesh7 holds ${what} for a human, by rule ${d.rule}`, tool, hold: true }
  }
  return undefined
}

// An approval of this agent leaving pending: the human's decision, which
// releases the waiting face.
export const decisionSay = (a: { tool: string; status: string }): Omit<Say, 'at'> =>
  ({ mood: a.status === 'approved' ? 'watch' : 'deny', event: `the human ${a.status} ${a.tool}`, tool: claudeName(a.tool), release: true })

export const register: Register = on => {
  let seen = ''
  let isFirst = true
  let was: Health | null = null
  // MCP calls reach mesh7 under the MCP connection's session, not Claude
  // Code's: learned by matching a call this session just made to its trace.
  let mcpSession = ''
  const recentCalls: { tool: string; at: number }[] = []
  // Each approval's last status seen; null until the first poll seeds it.
  let statuses: Map<string, string> | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mesh7',
      description: 'Open the mesh7 decisions pane; /mesh7 all|session switches the scope',
    })
    const session = await $.session.id()

    $.clock.every(POLL_MS, async () => {
      const wide = await read($, isAll)
      try {
        const [tr, ap, ha, he] = await Promise.all([
          $.http.fetch(`${MESH}/traces?limit=300`),
          $.http.fetch(`${MESH}/approvals`),
          $.http.fetch(`${MESH}/halts`),
          $.http.fetch(`${MESH}/health`),
        ])
        const all = JSON.parse(tr.text) as Trace[]
        if (mcpSession === '') {
          const match = all.find(
            t =>
              t.tool.includes('.') &&
              t.agent_id === 'claude' &&
              t.session_id !== undefined &&
              recentCalls.some(c => c.tool === claudeName(t.tool) && Math.abs(new Date(t.timestamp).getTime() - c.at) < 15_000),
          )
          if (match?.session_id !== undefined) mcpSession = match.session_id
        }
        const mine = (t: Trace): boolean => t.session_id === session || (mcpSession !== '' && t.session_id === mcpSession)
        const traces = all.filter(t => wide || mine(t))
        const mineIds = new Set(traces.filter(mine).map(t => t.trace_id))
        const approvals = ap.ok ? (JSON.parse(ap.text) as Approval[]) : []
        const halts = ha.ok ? (JSON.parse(ha.text) as Halt[]).filter(h => !h.resumed_at) : []
        const version = he.ok ? String((JSON.parse(he.text) as { version?: string }).version ?? '') : ''

        const list: Decision[] = traces.slice(0, KEEP).map(t => ({
          id: t.trace_id,
          at: t.timestamp,
          agent: t.agent_id,
          tool: t.tool,
          verdict: (t.policy in LOOK ? t.policy : 'deny') as Verdict,
          rule: t.policy_rule,
          hint: hintOf(t.params),
          approval: t.approval_status ?? '',
        }))
        const waiting: Pending[] = approvals
          .filter(a => a.status === 'pending' && (wide || a.agent_id === 'claude'))
          .map(a => ({ id: a.id, agent: a.agent_id, tool: a.tool, rule: a.policy_rule, since: a.created_at }))
        const halt = halts.map(h => (h.target ? `${h.scope} ${h.target}` : h.scope) + (h.reason ? `: ${h.reason}` : '')).join(' · ')

        // Tell about what is new since the last poll, never about the backlog.
        const fresh = isFirst ? [] : list.slice(0, Math.max(0, list.findIndex(d => d.id === seen)))
        isFirst = false
        seen = list[0]?.id ?? seen
        for (const d of fresh) {
          if (d.verdict === 'deny') $.ui.toast(`mesh7 DENY ${d.tool} (${d.rule})`)
          if (d.verdict === 'human_approval') $.ui.toast(`mesh7 waits for a human: ${d.tool}`)
          const said = mineIds.has(d.id) ? verdictSay(d) : undefined
          if (said !== undefined) await $.state.set({ plugin: 'mesh7-pane', key: 'say' }, { ...said, at: Date.now() })
        }
        // The human's decisions on this agent's held calls.
        const now = new Map(approvals.filter(a => a.agent_id === 'claude').map(a => [a.id, a.status]))
        if (statuses !== null) {
          for (const a of approvals) {
            if (a.agent_id === 'claude' && statuses.get(a.id) === 'pending' && a.status !== 'pending') {
              await $.state.set({ plugin: 'mesh7-pane', key: 'say' }, { ...decisionSay(a), at: Date.now() })
            }
          }
        }
        statuses = now

        await update($, decisions, () => list)
        await update($, pending, () => waiting)
        was = await report($, was, { isUp: true, version, halt })

        const allow = list.filter(d => d.verdict === 'allow').length
        const deny = list.filter(d => d.verdict === 'deny').length
        $.ui.status(
          halt !== ''
            ? `mesh7 HALTED (${halt})`
            : `mesh7 ${allow} allow · ${deny} deny · ${waiting.length} pending`,
        )
      } catch {
        was = await report($, was, { ...(await read($, health)), isUp: false })
        $.ui.status('mesh7 DOWN: tools fail closed')
      }
    })

    void $.ui.open({ id: PANE, title: 'mesh7' })
    return next(e)
  })

  // The MCP calls this session makes, by name and time, to find their traces.
  on('tool.call', async ($, e, next) => {
    if (e.tool.startsWith('mcp__mesh7__') && mcpSession === '') {
      recentCalls.push({ tool: e.tool, at: Date.now() })
      if (recentCalls.length > 20) recentCalls.shift()
    }
    return next(e)
  })

  on('command.run', { command: 'mesh7' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'all' || arg === 'session') {
      await update($, isAll, () => arg === 'all')
      isFirst = true
    }
    const opened = await $.ui.open({ id: PANE, title: 'mesh7' })
    const scope = (await read($, isAll)) ? 'all agents and sessions' : 'this session'
    return { text: opened.isPlaced ? `mesh7 pane: ${scope}.` : 'The pane needs a wider terminal.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, decisions)
    const waiting = await read($, pending)
    const state = await read($, health)
    const wide = await read($, isAll)
    const now = Date.now()
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 8 - waiting.length)

    return (
      <Box flexDirection="column" flexGrow={1} width="100%" height={e.viewport?.rows ?? 30} backgroundColor="#000000">
        <Text backgroundColor="#000000" wrap="truncate-end">
          <Text bold color="#00e5ff">mesh7</Text>
          <Text dimColor> {state.version} · {wide ? 'all sessions' : 'this session'} · </Text>
          {state.isUp ? <Text color="#3ddc84">up</Text> : <Text bold color="#ff2a6d">DOWN, tools fail closed</Text>}
        </Text>

        {state.halt !== '' && (
          <Text bold color="#000000" backgroundColor="#ff2a6d" wrap="truncate-end">
            {` EMERGENCY STOP  ${state.halt} `}
          </Text>
        )}

        {waiting.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="#ffb000">Waiting for a human ({waiting.length})</Text>
            {waiting.map(p => (
              <Text wrap="truncate-end">
                <Text color="#ffb000">{p.id.slice(0, 8)} </Text>
                <Text>{p.tool} </Text>
                <Text dimColor>
                  {wide ? `${p.agent} · ` : ''}
                  {p.rule} · {ago(p.since, now)}
                </Text>
              </Text>
            ))}
            <Text dimColor wrap="truncate-end">resolve: mesh approve|deny {'<id>'}, or /mesh-approve</Text>
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          {list.length === 0 && <Text dimColor>No decision yet in this scope.</Text>}
          {list.slice(0, room).map(d => (
            <Text wrap="truncate-end">
              <Text dimColor>{clock(d.at)} </Text>
              <Text bold={d.verdict !== 'allow'} color={LOOK[d.verdict].color}>
                {LOOK[d.verdict].label}
              </Text>
              <Text> {d.tool} </Text>
              {d.approval !== '' && <Text color="#ffb000">[{d.approval}] </Text>}
              {wide && <Text color="#7f8fa6">{d.agent} </Text>}
              <Text dimColor>
                {d.verdict === 'allow' ? '' : `${d.rule} · `}
                {d.hint}
              </Text>
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
