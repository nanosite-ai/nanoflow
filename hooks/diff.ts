// Snapshot → snapshot: what changed that the person should hear about. Pure.
import type { NfSnapshot, NfTone, NfWorktree } from '../types'

export type NfEvent = { icon: string; text: string; tone: NfTone; important: boolean; href?: string }

const label = (wt: NfWorktree): string =>
  wt.ticket ? `#${wt.ticket.number}${wt.ticket.title ? ` ${truncate(wt.ticket.title, 40)}` : ''}` : wt.name

export const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * A `--local` snapshot carries no GitHub fields: keep tickets, PRs and the board from the last full one,
 * matched by worktree path, so a fast poll never makes a PR "disappear".
 */
export const mergeLocal = (prev: NfSnapshot | null, local: NfSnapshot): NfSnapshot => {
  if (!prev) return local
  const byPath = new Map(prev.worktrees.map(wt => [wt.path, wt]))
  return {
    ...local,
    board: local.board ?? prev.board,
    worktrees: local.worktrees.map(wt => {
      const old = byPath.get(wt.path)
      if (!old) return wt
      const ticket = wt.ticket && old.ticket && old.ticket.number === wt.ticket.number
        ? { ...wt.ticket, title: wt.ticket.title ?? old.ticket.title, state: wt.ticket.state ?? old.ticket.state, status: wt.ticket.status ?? old.ticket.status, url: old.ticket.url || wt.ticket.url }
        : wt.ticket
      return { ...wt, ticket, pr: wt.pr ?? (old.branch === wt.branch ? old.pr : null) }
    }),
  }
}

/** Events between two snapshots. The first snapshot of a session is the baseline: no events. */
export const diffSnapshots = (prev: NfSnapshot | null, next: NfSnapshot, browserOpen: boolean): NfEvent[] => {
  if (!prev) return []
  const events: NfEvent[] = []
  const before = new Map(prev.worktrees.map(wt => [wt.path, wt]))
  const after = new Map(next.worktrees.map(wt => [wt.path, wt]))

  for (const wt of next.worktrees) {
    const old = before.get(wt.path)
    if (!old) {
      events.push({ icon: '🌱', text: `Worktree ${wt.name} created${wt.slot !== null ? ` (slot ${wt.slot})` : ''}`, tone: 'success', important: true })
      continue
    }
    for (const svc of wt.services) {
      const was = old.services.find(s => s.name === svc.name)
      if (was && !was.isUp && svc.isUp) events.push({ icon: '🟢', text: `${label(wt)}: ${svc.name} is up :${svc.port}`, tone: 'success', important: false, href: svc.url })
      if (was?.isUp && !svc.isUp) events.push({ icon: '⚪', text: `${label(wt)}: ${svc.name} stopped`, tone: 'info', important: false })
    }
    if (wt.pr && !old.pr) {
      events.push({ icon: '🔀', text: `${label(wt)}: PR #${wt.pr.number} opened`, tone: 'info', important: true, href: wt.pr.url })
    }
    if (wt.pr && old.pr && old.pr.number === wt.pr.number) {
      if (wt.pr.state !== old.pr.state && wt.pr.state === 'MERGED') {
        events.push({ icon: '🎉', text: `PR #${wt.pr.number} merged: ${label(wt)}`, tone: 'success', important: true, href: wt.pr.url })
        events.push({
          icon: '🧹',
          text: `Tear down ${wt.name}? (deletes the dir + local branch)${browserOpen ? ' · close the browser + delete your screenshots' : ''}`,
          tone: 'warning',
          important: true,
        })
      } else if (wt.pr.state !== old.pr.state && wt.pr.state === 'CLOSED') {
        events.push({ icon: '🚫', text: `PR #${wt.pr.number} closed without merge: ${label(wt)}`, tone: 'warning', important: true, href: wt.pr.url })
      }
      if (wt.pr.ci !== old.pr.ci && wt.pr.ci === 'pass') {
        events.push({ icon: '✅', text: `CI green on PR #${wt.pr.number}`, tone: 'success', important: true, href: wt.pr.url })
      }
      if (wt.pr.ci !== old.pr.ci && wt.pr.ci === 'fail') {
        events.push({ icon: '❌', text: `CI failed on PR #${wt.pr.number}`, tone: 'error', important: true, href: wt.pr.ciUrl ?? wt.pr.url })
      }
    }
    if (wt.ticket?.state === 'CLOSED' && old.ticket?.state === 'OPEN') {
      events.push({ icon: '🏁', text: `Ticket #${wt.ticket.number} closed`, tone: 'success', important: false, href: wt.ticket.url })
    }
  }
  for (const old of prev.worktrees) {
    if (!after.has(old.path)) events.push({ icon: '🗑️', text: `Worktree ${old.name} removed`, tone: 'info', important: true })
  }
  return events
}
