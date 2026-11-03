// Token usage per session, as `nanoflow usage --json` counts it from the transcripts: the shape check and
// the formatting the pane shares.
import type { NfTokens, NfUsage, NfWorktreeUsage } from '../types'
import { samePath } from './scan'

export const isUsage = (v: unknown): v is NfUsage =>
  typeof v === 'object' && v !== null && Array.isArray((v as NfUsage).worktrees) && typeof (v as NfUsage).total === 'object'

/** A worktree's usage, matched by path; null when it has no sessions. */
export const usageOf = (usage: NfUsage | null, path: string, win: boolean): NfWorktreeUsage | null => {
  const hit = usage?.worktrees.find(u => samePath(u.path, path, win))
  return hit && hit.sessions.length > 0 ? hit : null
}

/** Every token the counts name: input, output and both cache kinds. */
export const allTokens = (t: NfTokens): number => t.input + t.output + t.cacheRead + t.cacheWrite

/** 950, 12.3k, 4.56M: short enough for a dashboard row. */
export const formatTokens = (n: number): string => {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`
}

/** `claude-opus-5-5` → `opus-5-5`. */
export const shortModel = (model: string): string => model.replace(/^claude-/, '')

/** Models by tokens spent, most first. */
export const byModel = (models: Readonly<Record<string, NfTokens>>): Array<[string, NfTokens]> =>
  Object.entries(models).sort(([, a], [, b]) => allTokens(b) - allTokens(a))
