import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Decision, Health, Pending, Verdict } from '../types'

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

export const register: Register = on => {
  let seen = ''
  let isFirst = true

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
        const traces = (JSON.parse(tr.text) as Trace[]).filter(t => wide || t.session_id === session)
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
        }

        await update($, decisions, () => list)
        await update($, pending, () => waiting)
        await update($, health, () => ({ isUp: true, version, halt }))

        const allow = list.filter(d => d.verdict === 'allow').length
        const deny = list.filter(d => d.verdict === 'deny').length
        $.ui.status(
          halt !== ''
            ? `mesh7 HALTED (${halt})`
            : `mesh7 ${allow} allow · ${deny} deny · ${waiting.length} pending`,
        )
      } catch {
        await update($, health, was => ({ ...was, isUp: false }))
        $.ui.status('mesh7 DOWN: tools fail closed')
      }
    })

    void $.ui.open({ id: PANE, title: 'mesh7' })
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
