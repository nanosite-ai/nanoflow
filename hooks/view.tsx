// The dashboard pane: Worktrees / Tickets / Activity, with links and action buttons. A tree from the
// surface's own element table; every handler is passed in, so this file holds no state. The shared
// pieces (Row, Badge, Mark, links) live in ./ui.
import type { NfActivity, NfCheck, NfSnapshot, NfSource, NfTab, NfTicket, NfWorktree } from '../types'
import { truncate } from './diff'
import { stagesOf, type StageState } from './progress'
import { Badge, COLOR, LinkOr, type Look, Mark, type PaneElements, Row, StatusBadge, TicketLink } from './ui'

export { COLOR, statusColor, type PaneElements } from './ui'

export type PaneData = {
  snapshot: NfSnapshot | null
  activity: readonly NfActivity[]
  checks: Readonly<Record<string, NfCheck>>
  tab: NfTab
  selected: string | null
  /** The `at` of the activity entry whose output is open. */
  expanded: number | null
  busy: string | null
  source: NfSource
  columns: number
  now: number
  /** Which action buttons the repo configured. */
  can: { pickUp: boolean; startDev: boolean; stopDev: boolean; teardown: boolean; startTask: boolean; newTicket: boolean }
  openService: string | null
}

export type PaneHandlers = {
  setTab: (tab: NfTab) => void
  refresh: () => void
  select: (path: string | null) => void
  toggleOutput: (at: number) => void
  copyOutput: (text: string) => void
  pickUp: (wt: NfWorktree) => void
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

const CI_LOOK: Record<string, Look> = {
  pass: { icon: '✅', color: COLOR.ok },
  fail: { icon: '❌', color: COLOR.bad },
  pending: { icon: '🟡', color: COLOR.wait },
}

const PR_LOOK: Record<string, Look> = {
  OPEN: { icon: '🟢', color: COLOR.ok },
  MERGED: { icon: '🟣', color: COLOR.merged },
  CLOSED: { icon: '🔴', color: COLOR.bad },
}

const STAGE_LOOK: Record<StageState, Look> = {
  done: { icon: '✓', color: COLOR.ok },
  active: { icon: '…', color: COLOR.wait },
  fail: { icon: '✗', color: COLOR.bad },
  todo: { icon: '○', color: COLOR.muted },
}

const SERVICE_LOOK = { up: { icon: '●', color: COLOR.ok }, down: { icon: '○', color: COLOR.muted } } as const

const TONE: Record<NfActivity['tone'], string | undefined> = { error: COLOR.bad, success: COLOR.ok, warning: COLOR.wait, info: undefined }

/** A worktree's ticket is still up for pickup: open, not yet In progress / In review / Done, and no PR. */
export const isPickable = (wt: NfWorktree): boolean => {
  if (wt.isMain || !wt.ticket || wt.ticket.state === 'CLOSED' || wt.pr) return false
  const s = (wt.ticket.status ?? '').toLowerCase()
  return !['progress', 'review', 'done'].some(word => s.includes(word))
}

const ago = (now: number, iso: string): string => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}

const clock = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const Tabs = (el: PaneElements, data: PaneData, on: PaneHandlers) => {
  const { Text, Button } = el
  const tabs: Array<[NfTab, string, string]> = [['worktrees', '🌳 Worktrees', 'w'], ['tickets', '🎫 Tickets', 't'], ['activity', '⚡ Activity', 'a']]
  const updated = data.snapshot ? `updated ${ago(data.now, data.snapshot.generatedAt)}` : 'scanning…'
  const from = data.source.provider ?? 'git/gh'
  return Row(el, 'tabs', [
    ...tabs.map(([tab, label, hotkey]) => (
      <Button key={`tab-${tab}`} label={label} hotkey={hotkey} variant={data.tab === tab ? 'primary' : 'secondary'} onPress={() => on.setTab(tab)} />
    )),
    <Button key="refresh" label="🔄 Refresh" hotkey="r" onPress={on.refresh} />,
    <Text key="updated" dimColor>{`${updated} · ${from}`}</Text>,
    <Text key="brand" color={COLOR.current} dimColor>nanoflow by nanosite.ai</Text>,
    data.busy !== null && <Text key="busy" color={COLOR.wait} bold>{`⏳ ${data.busy}`}</Text>,
  ])
}

const Stages = (el: PaneElements, key: string, wt: NfWorktree, checks: PaneData['checks']) =>
  Row(el, key, stagesOf(wt, checks).map(st => Mark(el, `${key}-${st.key}`, STAGE_LOOK[st.state], st.label)), { indent: true })

const WorktreeCard = (el: PaneElements, data: PaneData, on: PaneHandlers, wt: NfWorktree) => {
  const { Box, Text, Button, Link } = el
  const width = Math.max(20, data.columns - 6)
  const isSelected = data.selected === wt.path
  const title = wt.ticket?.title ? truncate(wt.ticket.title, Math.max(10, width - wt.name.length - 30)) : null
  const ci = wt.pr ? CI_LOOK[wt.pr.ci] : undefined
  const pr = wt.pr ? PR_LOOK[wt.pr.state] ?? PR_LOOK.OPEN : undefined
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
      {Row(el, k('head'), [
        wt.isCurrent && Badge(el, k('here'), '📍 THIS SESSION', COLOR.current),
        <Button key={k('select')} plain label={`${isSelected ? '▾' : '▸'} ${icon} ${wt.name}`} onPress={() => on.select(isSelected ? null : wt.path)} />,
        wt.ticket && TicketLink(el, k('ticket'), wt.ticket),
        title && <Text key={k('title')} bold color={wt.isCurrent ? COLOR.current : undefined}>{title}</Text>,
        wt.ticket?.status && StatusBadge(el, k('status'), wt.ticket.status),
      ])}
      {Row(el, k('meta'), [
        <Text key={k('branch')} color={COLOR.info}>{`⎇ ${wt.branch ?? '(detached)'}`}</Text>,
        <Text key={k('slot')} dimColor>{`slot ${wt.slot ?? '?'}`}</Text>,
        wt.dirty > 0 && <Text key={k('dirty')} color={COLOR.wait}>{`✎ ${wt.dirty} changed`}</Text>,
        wt.ahead > 0 && <Text key={k('ahead')} color={COLOR.ok}>{`↑ ${wt.ahead} ahead`}</Text>,
        pr && Mark(el, k('pr-icon'), pr),
        wt.pr && <Link key={k('pr')} href={wt.pr.url} label={`PR #${wt.pr.number} ${wt.pr.state.toLowerCase()}`} />,
        ci && Mark(el, k('ci-icon'), ci),
        ci && LinkOr(el, k('ci'), wt.pr?.ciUrl, 'CI', ci.color),
      ], { indent: true })}
      {!wt.isMain && Stages(el, k('stages'), wt, wt.isCurrent ? data.checks : {})}
      {wt.services.length > 0 && Row(el, k('svc'), wt.services.map(s => (
        Row(el, k(`svc-${s.name}`), [
          Mark(el, k(`svc-${s.name}-dot`), s.isUp ? SERVICE_LOOK.up : SERVICE_LOOK.down),
          LinkOr(el, k(`svc-${s.name}-link`), s.isUp ? s.url : null, `${s.name} :${s.port}`),
        ], { wrap: false })
      )), { gap: 2, indent: true })}
      {Row(el, k('path'), [
        <Text key={k('path-icon')}>📂</Text>,
        <Link key={k('path-link')} href={folderUrl(wt.path)} label={truncate(wt.path, width - 4)} />,
      ], { indent: true, wrap: false })}
      {isSelected && Row(el, k('actions'), [
        data.can.pickUp && isPickable(wt) && <Button key={k('pick-up')} label="▶ Pick up" onPress={() => on.pickUp(wt)} />,
        data.can.startDev && <Button key={k('up')} label="🚀 Start dev" onPress={() => on.startDev(wt)} />,
        data.can.stopDev && <Button key={k('down')} label="■ Stop" onPress={() => on.stopDev(wt)} />,
        open && <Link key={k('open-app')} href={open.url} label="🌐 Open app ↗" />,
        wt.pr && <Link key={k('open-pr')} href={wt.pr.url} label="🔀 Open PR ↗" />,
        wt.ticket && <Link key={k('open-ticket')} href={wt.ticket.url} label="🎫 Open ticket ↗" />,
        <Button key={k('copy')} label="📋 Copy path" onPress={() => on.copyPath(wt)} />,
        data.can.teardown && !wt.isMain && merged && <Button key={k('teardown')} label="🧹 Teardown" onPress={() => on.teardown(wt)} />,
        data.can.teardown && !wt.isMain && !merged && <Text key={k('teardown-later')} dimColor>🧹 teardown once the PR is merged</Text>,
      ], { indent: true })}
    </Box>
  )
}

/** One line of counts above the cards. */
const Fleet = (el: PaneElements, snapshot: NfSnapshot) => {
  const { Text } = el
  const trees = snapshot.worktrees
  const running = trees.filter(w => w.services.some(s => s.isUp)).length
  const prs = trees.filter(w => w.pr?.state === 'OPEN').length
  const red = trees.filter(w => w.pr?.state === 'OPEN' && w.pr.ci === 'fail').length
  const done = trees.filter(w => !w.isMain && (w.pr?.state === 'MERGED' || w.pr?.state === 'CLOSED')).length
  return Row(el, 'fleet', [
    <Text key="fleet-trees" bold>{`🌳 ${trees.length} worktrees`}</Text>,
    <Text key="fleet-running" color={running ? COLOR.ok : COLOR.muted}>{`🚀 ${running} running`}</Text>,
    <Text key="fleet-prs" color={prs ? COLOR.info : COLOR.muted}>{`🔀 ${prs} open PRs`}</Text>,
    red > 0 && <Text key="fleet-red" color={COLOR.bad} bold>{`❌ ${red} red CI`}</Text>,
    done > 0 && <Text key="fleet-done" color={COLOR.merged}>{`🧹 ${done} ready to tear down`}</Text>,
  ], { gap: 2 })
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
  const { Box, Text, Button, Input } = el
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
          : board.map(t => Row(el, `ticket-${t.number}`, [
              TicketLink(el, `link-${t.number}`, t),
              t.status && StatusBadge(el, `status-${t.number}`, t.status),
              <Text key={`title-${t.number}`} bold={t.worktree !== null}>{truncate(t.title ?? '', width)}</Text>,
              t.worktree
                ? <Button key={`go-${t.number}`} plain label={`🌿 → ${t.worktree}`} onPress={() => on.goTo(t)} />
                : data.can.startTask && <Button key={`start-${t.number}`} label="▶ Start" onPress={() => on.startTask(t)} />,
            ]))}
    </Box>
  )
}

/** Lines of an open output shown in the pane; the copy button takes all of it. */
const OUTPUT_ROWS = 40

const ActivityTab = (el: PaneElements, data: PaneData, on: PaneHandlers) => {
  const { Box, Text, Button, Link } = el
  if (data.activity.length === 0) return <Text dimColor>Nothing yet: tests, PRs, CI, worktrees and the browser show up here.</Text>
  const width = Math.max(20, data.columns - 22)
  return (
    <Box key="activity" flexDirection="column">
      {[...data.activity].reverse().map((a, i) => {
        const k = `act-${a.at}-${i}`
        const isOpen = a.detail !== undefined && data.expanded === a.at
        const lines = isOpen ? a.detail!.split('\n') : []
        return (
          <Box key={k} flexDirection="column">
            {Row(el, `${k}-row`, [
              <Text key={`${k}-at`} dimColor>{clock(a.at)}</Text>,
              <Text key={`${k}-text`} color={TONE[a.tone]}>{`${a.icon} ${truncate(a.text, width)}`}</Text>,
              a.href && <Link key={`${k}-href`} href={a.href} label="↗" />,
              a.detail && <Button key={`${k}-output`} plain label={isOpen ? '▾ output' : '▸ output'} onPress={() => on.toggleOutput(a.at)} />,
            ], { wrap: false })}
            {isOpen && (
              <Box key={`${k}-detail`} flexDirection="column" borderStyle="single" borderColor={COLOR.muted} paddingX={1}>
                {lines.length > OUTPUT_ROWS && <Text key={`${k}-more`} dimColor>{`… ${lines.length - OUTPUT_ROWS} earlier lines: 📋 copy for all of them`}</Text>}
                {lines.slice(-OUTPUT_ROWS).map((line, j) => <Text key={`${k}-l${j}`}>{line || ' '}</Text>)}
                {Row(el, `${k}-tools`, [
                  <Button key={`${k}-copy`} label="📋 Copy output" onPress={() => on.copyOutput(a.detail!)} />,
                ])}
              </Box>
            )}
          </Box>
        )
      })}
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
      {data.tab === 'activity' && ActivityTab(el, data, on)}
    </Box>
  )
}
