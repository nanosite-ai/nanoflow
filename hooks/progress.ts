// Where the current task stands: ticket → branch → code → checks → PR → CI → merged. Pure.
import type { NfCheck, NfSnapshot, NfWorktree } from '../types'
import { truncate } from './diff'

export type StageState = 'done' | 'active' | 'fail' | 'todo'
export type Stage = { key: string; label: string; state: StageState }

const MARK: Record<StageState, string> = { done: '✓', active: '…', fail: '✗', todo: '○' }

export const currentWorktree = (snapshot: NfSnapshot | null): NfWorktree | null =>
  snapshot?.worktrees.find(wt => wt.isCurrent) ?? null

/** The checks stage: failed if any latest check failed, done if all passed, todo with none yet. */
const checksState = (checks: Readonly<Record<string, NfCheck>>): StageState => {
  const all = Object.values(checks)
  if (all.length === 0) return 'todo'
  return all.some(c => !c.ok) ? 'fail' : 'done'
}

export const stagesOf = (wt: NfWorktree, checks: Readonly<Record<string, NfCheck>>): Stage[] => {
  const pr = wt.pr
  const ciState: StageState = !pr || pr.ci === 'none' ? 'todo' : pr.ci === 'pass' ? 'done' : pr.ci === 'fail' ? 'fail' : 'active'
  const merged = pr?.state === 'MERGED'
  return [
    { key: 'ticket', label: 'ticket', state: wt.ticket ? 'done' : 'todo' },
    { key: 'branch', label: 'branch', state: wt.isMain ? 'todo' : 'done' },
    { key: 'code', label: 'code', state: wt.ahead > 0 || merged ? 'done' : wt.dirty > 0 ? 'active' : 'todo' },
    { key: 'checks', label: 'checks', state: merged && checksState(checks) === 'todo' ? 'done' : checksState(checks) },
    { key: 'pr', label: pr ? `PR #${pr.number}` : 'PR', state: pr ? 'done' : 'todo' },
    { key: 'ci', label: 'CI', state: merged ? 'done' : ciState },
    { key: 'merged', label: 'merged', state: merged ? 'done' : 'todo' },
  ]
}

export const stageLine = (stages: readonly Stage[]): string => stages.map(s => `${MARK[s.state]}${s.label}`).join(' ')

export const fleetLine = (snapshot: NfSnapshot): string => {
  const running = snapshot.worktrees.filter(wt => wt.services.some(s => s.isUp)).length
  const count = snapshot.worktrees.length
  return `${count} worktree${count === 1 ? '' : 's'}${running ? ` · ${running} running` : ''}`
}

/** The pinned status line. */
export const statusLine = (args: {
  snapshot: NfSnapshot | null
  checks: Readonly<Record<string, NfCheck>>
  running: string | null
  skill: string | null
}): string => {
  const { snapshot, checks, running, skill } = args
  if (!snapshot) return 'nanoflow · scanning…'
  const wt = currentWorktree(snapshot)
  const extras = [running ? `⏳ ${running}` : '', skill ? `📘 ${skill}` : ''].filter(Boolean).join(' · ')
  const tail = ` │ ${fleetLine(snapshot)}${extras ? ` │ ${extras}` : ''}`
  if (!wt || wt.isMain) return `${wt?.branch ?? 'main'}${tail}`
  const head = wt.ticket ? `#${wt.ticket.number}${wt.ticket.title ? ` ${truncate(wt.ticket.title, 28)}` : ''}` : wt.name
  return `${head} │ ${stageLine(stagesOf(wt, checks))}${tail}`
}
