// The dashboard pane: Worktrees / Tickets / Activity, with links and action buttons. A tree from the
// surface's own element table; every handler is passed in, so this file holds no state.
import type { Elements } from 'claude-code'
import type { NfActivity, NfCheck, NfSnapshot, NfSource, NfTab, NfTicket, NfWorktree } from '../types'
import { truncate } from './diff'
import { stagesOf, type StageState } from './progress'

export type PaneElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link'> & { Input?: Elements['terminal']['Input'] }

export type PaneData = {
  snapshot: NfSnapshot | null
  activity: readonly NfActivity[]
  checks: Readonly<Record<string, NfCheck>>
  tab: NfTab
  selected: string | null
  busy: string | null
  source: NfSource
  columns: number
  now: number
  /** Which action buttons the repo configured. */
  can: { startDev: boolean; stopDev: boolean; teardown: boolean; startTask: boolean; newTicket: boolean }
  openService: string | null
}

export type PaneHandlers = {
  setTab: (tab: NfTab) => void
  refresh: () => void
  select: (path: string | null) => void
  startDev: (wt: NfWorktree) => void
  stopDev: (wt: NfWorktree) => void
  teardown: (wt: NfWorktree) => void
  copyPath: (wt: NfWorktree) => void
  startTask: (ticket: NfTicket) => void
  goTo: (ticket: NfTicket) => void
  newTicket: (title: string) => void
}

/** file:// URL for a folder, built with the URL API (Windows drive paths and POSIX paths alike). */
export const folderUrl = (path: string): string => {
  const p = path.replace(/\\/g, '/')
  return new URL(p.startsWith('/') ? `file://${p}` : `file:///${p}`).href
}

/**
 * Semantic colors, as theme keys so they follow the person's light/dark theme. PRs keep GitHub's
 * meanings: open green, merged purple, closed red.
 */
export const COLOR = {
  current: 'claude',
  selected: 'suggestion',
  ok: 'success',
  bad: 'error',
  wait: 'warning',
  merged: 'merged',
  info: 'suggestion',
  muted: 'inactive',
  onBadge: 'inverseText',
} as const

const CI_BADGE: Record<string, { icon: string; color: string }> = {
  pass: { icon: '✅', color: COLOR.ok },
  fail: { icon: '❌', color: COLOR.bad },
  pending: { icon: '🟡', color: COLOR.wait },
}

const PR_BADGE: Record<string, { icon: string; color: string }> = {
  OPEN: { icon: '🟢', color: COLOR.ok },
  MERGED: { icon: '🟣', color: COLOR.merged },
  CLOSED: { icon: '🔴', color: COLOR.bad },
}

const STAGE_LOOK: Record<StageState, { mark: string; color: string }> = {
  done: { mark: '✓', color: COLOR.ok },
  active: { mark: '…', color: COLOR.wait },
  fail: { mark: '✗', color: COLOR.bad },
  todo: { mark: '○', color: COLOR.muted },
}

const TONE: Record<NfActivity['tone'], string | undefined> = { error: COLOR.bad, success: COLOR.ok, warning: COLOR.wait, info: undefined }

/** Board column → badge color; an unknown column stays neutral. */
export const statusColor = (status: string | null): string => {
  const s = (status ?? '').toLowerCase()
  if (s.includes('progress')) return COLOR.wait
  if (s.includes('review')) return COLOR.merged
  if (s.includes('ready') || s.includes('todo')) return COLOR.info
  if (s.includes('done')) return COLOR.ok
  return COLOR.muted
}

const ago = (now: number, iso: string): string => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}

const clock = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const Badge = (el: PaneElements, key: string, text: string, color: string) => {
  const { Text } = el
  return <Text key={key} backgroundColor={color} color={COLOR.onBadge} bold>{` ${text} `}</Text>
}

const Tabs = (el: PaneElements, data: PaneData, on: PaneHandlers) => {
  const { Box, Text, Button } = el
  const tabs: Array<[NfTab, string, string]> = [['worktrees', '🌳 Worktrees', 'w'], ['tickets', '🎫 Tickets', 't'], ['activity', '⚡ Activity', 'a']]
  const updated = data.snapshot ? `updated ${ago(data.now, data.snapshot.generatedAt)}` : 'scanning…'
  const from = data.source.provider ?? 'git/gh'
  return (
    <Box key="tabs" flexDirection="row" gap={1} flexWrap="wrap">
      {tabs.map(([tab, label, hotkey]) => (
        <Button key={`tab-${tab}`} label={label} hotkey={hotkey} variant={data.tab === tab ? 'primary' : 'secondary'} onPress={() => on.setTab(tab)} />
      ))}
      <Button key="refresh" label="🔄 Refresh" hotkey="r" onPress={on.refresh} />
      <Text dimColor>{`${updated} · ${from}`}</Text>
      <Text color={COLOR.current} dimColor>nanoflow by nanosite.ai</Text>
      {data.busy !== null && <Text color={COLOR.wait} bold>{`⏳ ${data.busy}`}</Text>}
    </Box>
  )
}

const Stages = (el: PaneElements, key: string, wt: NfWorktree, checks: PaneData['checks']) => {
  const { Box, Text } = el
  return (
    <Box key={key} flexDirection="row" gap={1} flexWrap="wrap" paddingLeft={2}>
      {stagesOf(wt, checks).map(st => (
        <Text key={`${key}-${st.key}`} color={STAGE_LOOK[st.state].color}>{`${STAGE_LOOK[st.state].mark}${st.label}`}</Text>
      ))}
    </Box>
  )
}

const WorktreeCard = (el: PaneElements, data: PaneData, on: PaneHandlers, wt: NfWorktree) => {
  const { Box, Text, Button, Link } = el
  const width = Math.max(20, data.columns - 6)
  const isSelected = data.selected === wt.path
  const title = wt.ticket?.title ? truncate(wt.ticket.title, Math.max(10, width - wt.name.length - 30)) : null
  const ci = wt.pr ? CI_BADGE[wt.pr.ci] : undefined
  const pr = wt.pr ? PR_BADGE[wt.pr.state] ?? PR_BADGE.OPEN : undefined
  const merged = wt.pr?.state === 'MERGED' || wt.pr?.state === 'CLOSED'
  const open = wt.services.find(s => s.isUp && s.name === data.openService) ?? wt.services.find(s => s.isUp)
  const icon = wt.isMain ? '🏠' : wt.services.some(s => s.isUp) ? '🚀' : '🌿'
  const k = (part: string): string => `${part}-${wt.path}`
  // The session's own worktree gets a colored frame and a badge; a selected one a quieter frame.
  const frame = wt.isCurrent
    ? { borderStyle: 'round', borderColor: COLOR.current, paddingX: 1, marginBottom: 0 }
    : isSelected
      ? { borderStyle: 'single', borderColor: COLOR.selected, paddingX: 1, marginBottom: 0 }
      : { paddingX: 2, marginBottom: 1 }
  return (
    <Box key={k('card')} flexDirection="column" {...frame}>
      <Box key={k('head')} flexDirection="row" gap={1} flexWrap="wrap">
        {wt.isCurrent && Badge(el, k('here'), '📍 THIS SESSION', COLOR.current)}
        <Button key={k('select')} plain label={`${isSelected ? '▾' : '▸'} ${icon} ${wt.name}`} onPress={() => on.select(isSelected ? null : wt.path)} />
        {wt.ticket && <Link href={wt.ticket.url} label={`🎫 #${wt.ticket.number}`} />}
        {title && <Text bold color={wt.isCurrent ? COLOR.current : undefined}>{title}</Text>}
        {wt.ticket?.status && Badge(el, k('status'), wt.ticket.status, statusColor(wt.ticket.status))}
      </Box>
      <Box key={k('meta')} flexDirection="row" gap={1} paddingLeft={2} flexWrap="wrap">
        <Text color={COLOR.info}>{`⎇ ${wt.branch ?? '(detached)'}`}</Text>
        <Text dimColor>{`slot ${wt.slot ?? '?'}`}</Text>
        {wt.dirty > 0 && <Text color={COLOR.wait}>{`✎ ${wt.dirty} changed`}</Text>}
        {wt.ahead > 0 && <Text color={COLOR.ok}>{`↑ ${wt.ahead} ahead`}</Text>}
        {wt.pr && pr && <Text key={k('pr-icon')} color={pr.color}>{pr.icon}</Text>}
        {wt.pr && <Link href={wt.pr.url} label={`PR #${wt.pr.number} ${wt.pr.state.toLowerCase()}`} />}
        {ci && <Text key={k('ci-icon')} color={ci.color}>{ci.icon}</Text>}
        {ci && (wt.pr?.ciUrl ? <Link href={wt.pr.ciUrl} label="CI" /> : <Text color={ci.color}>CI</Text>)}
      </Box>
      {!wt.isMain && Stages(el, k('stages'), wt, wt.isCurrent ? data.checks : {})}
      {wt.services.length > 0 && (
        <Box key={k('svc')} flexDirection="row" gap={2} paddingLeft={2} flexWrap="wrap">
          {wt.services.map(s => (
            <Box key={k(`svc-${s.name}`)} flexDirection="row" gap={1}>
              <Text color={s.isUp ? COLOR.ok : COLOR.muted}>{s.isUp ? '●' : '○'}</Text>
              {s.isUp ? <Link href={s.url} label={`${s.name} :${s.port}`} /> : <Text dimColor>{`${s.name} :${s.port}`}</Text>}
            </Box>
          ))}
        </Box>
      )}
      <Box key={k('path')} flexDirection="row" gap={1} paddingLeft={2}>
        <Text>📂</Text>
        <Link href={folderUrl(wt.path)} label={truncate(wt.path, width - 4)} />
      </Box>
      {isSelected && (
        <Box key={k('actions')} flexDirection="row" gap={1} paddingLeft={2} flexWrap="wrap">
          {data.can.startDev && <Button key={k('up')} label="▶ Start dev" onPress={() => on.startDev(wt)} />}
          {data.can.stopDev && <Button key={k('down')} label="■ Stop" onPress={() => on.stopDev(wt)} />}
          {open && <Link href={open.url} label="🌐 Open app ↗" />}
          {wt.pr && <Link href={wt.pr.url} label="🔀 Open PR ↗" />}
          {wt.ticket && <Link href={wt.ticket.url} label="🎫 Open ticket ↗" />}
          <Button key={k('copy')} label="📋 Copy path" onPress={() => on.copyPath(wt)} />
          {data.can.teardown && !wt.isMain && merged && <Button key={k('teardown')} label="🧹 Teardown" onPress={() => on.teardown(wt)} />}
          {data.can.teardown && !wt.isMain && !merged && <Text dimColor>🧹 teardown once the PR is merged</Text>}
        </Box>
      )}
    </Box>
  )
}

/** One line of counts above the cards. */
const Fleet = (el: PaneElements, snapshot: NfSnapshot) => {
  const { Box, Text } = el
  const trees = snapshot.worktrees
  const running = trees.filter(w => w.services.some(s => s.isUp)).length
  const prs = trees.filter(w => w.pr?.state === 'OPEN').length
  const red = trees.filter(w => w.pr?.state === 'OPEN' && w.pr.ci === 'fail').length
  const done = trees.filter(w => !w.isMain && (w.pr?.state === 'MERGED' || w.pr?.state === 'CLOSED')).length
  return (
    <Box key="fleet" flexDirection="row" gap={2} flexWrap="wrap">
      <Text bold>{`🌳 ${trees.length} worktrees`}</Text>
      <Text color={running ? COLOR.ok : COLOR.muted}>{`🚀 ${running} running`}</Text>
      <Text color={prs ? COLOR.info : COLOR.muted}>{`🔀 ${prs} open PRs`}</Text>
      {red > 0 && <Text color={COLOR.bad} bold>{`❌ ${red} red CI`}</Text>}
      {done > 0 && <Text color={COLOR.merged}>{`🧹 ${done} ready to tear down`}</Text>}
    </Box>
  )
}

const WorktreesTab = (el: PaneElements, data: PaneData, on: PaneHandlers) => {
  const { Box, Text } = el
  if (!data.snapshot) return <Text dimColor>🔎 Scanning worktrees…</Text>
  // The session's own worktree first, then the main checkout, then the rest as listed.
  const rank = (wt: NfWorktree): number => (wt.isCurrent ? 0 : wt.isMain ? 1 : 2)
  const trees = [...data.snapshot.worktrees].sort((a, b) => rank(a) - rank(b))
  return (
    <Box key="worktrees" flexDirection="column" gap={1}>
      {Fleet(el, data.snapshot)}
      <Box key="cards" flexDirection="column">
        {trees.map(wt => WorktreeCard(el, data, on, wt))}
      </Box>
    </Box>
  )
}

const TicketsTab = (el: PaneElements, data: PaneData, on: PaneHandlers) => {
  const { Box, Text, Button, Link, Input } = el
  const board = data.snapshot?.board
  const width = Math.max(20, data.columns - 44)
  return (
    <Box key="tickets" flexDirection="column">
      {data.can.newTicket && Input && (
        <Box key="new-ticket" marginBottom={1}>
          <Input key="new-ticket-input" label="✨ New ticket" placeholder="title, then Enter" submitLabel="Create" onSubmit={value => on.newTicket(value)} />
        </Box>
      )}
      {board === null || board === undefined
        ? <Text dimColor>{data.snapshot ? 'Tickets load with the next full refresh (r).' : '🔎 Scanning…'}</Text>
        : board.length === 0
          ? <Text dimColor>No open tickets. 🎉</Text>
          : board.map(t => (
              <Box key={`ticket-${t.number}`} flexDirection="row" gap={1} flexWrap="wrap">
                <Link href={t.url} label={`🎫 #${t.number}`} />
                {t.status && Badge(el, `status-${t.number}`, t.status, statusColor(t.status))}
                <Text bold={t.worktree !== null}>{truncate(t.title ?? '', width)}</Text>
                {t.worktree
                  ? <Button key={`go-${t.number}`} plain label={`🌿 → ${t.worktree}`} onPress={() => on.goTo(t)} />
                  : data.can.startTask && <Button key={`start-${t.number}`} label="▶ Start" onPress={() => on.startTask(t)} />}
              </Box>
            ))}
    </Box>
  )
}

const ActivityTab = (el: PaneElements, data: PaneData) => {
  const { Box, Text, Link } = el
  if (data.activity.length === 0) return <Text dimColor>Nothing yet: tests, PRs, CI, worktrees and the browser show up here.</Text>
  const width = Math.max(20, data.columns - 10)
  return (
    <Box key="activity" flexDirection="column">
      {[...data.activity].reverse().map((a, i) => (
        <Box key={`act-${a.at}-${i}`} flexDirection="row" gap={1}>
          <Text dimColor>{clock(a.at)}</Text>
          <Text color={TONE[a.tone]}>{`${a.icon} ${truncate(a.text, width)}`}</Text>
          {a.href && <Link href={a.href} label="↗" />}
        </Box>
      ))}
    </Box>
  )
}

export const PaneView = (el: PaneElements, data: PaneData, on: PaneHandlers) => {
  const { Box, Text } = el
  return (
    <Box key="nanoflow" flexDirection="column" gap={1}>
      {Tabs(el, data, on)}
      {data.source.error && <Text color={COLOR.wait}>{`⚠ ${data.source.error}`}</Text>}
      {data.tab === 'worktrees' && WorktreesTab(el, data, on)}
      {data.tab === 'tickets' && TicketsTab(el, data, on)}
      {data.tab === 'activity' && ActivityTab(el, data)}
    </Box>
  )
}
