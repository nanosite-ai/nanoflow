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

/** 950, 12.3k, 4.56M: short enough for a dashboard row; rounded first, then placed (999,800 is 1.00M, not 1000k). */
export const formatTokens = (n: number): string => {
  if (n < 1000) return String(n)
  const k = n / 1000
  if (Number(k.toFixed(k < 10 ? 1 : 0)) < 1000) return Number(k.toFixed(1)) < 10 ? `${k.toFixed(1)}k` : `${k.toFixed(0)}k`
  const m = n / 1_000_000
  return Number(m.toFixed(2)) < 10 ? `${m.toFixed(2)}M` : `${m.toFixed(1)}M`
}

/** `claude-opus-5-5` → `opus-5-5`. */
export const shortModel = (model: string): string => model.replace(/^claude-/, '')

/** Models by tokens spent, most first. */
export const byModel = (models: Readonly<Record<string, NfTokens>>): Array<[string, NfTokens]> =>
  Object.entries(models).sort(([, a], [, b]) => allTokens(b) - allTokens(a))

/**
 * The commands that may answer `usage --json`, in order: the provider's own CLI (what comes before its `flow`,
 * as in `npx nanoflow flow --json`), then `nanoflow`.
 */
export const usageCommands = (provider: readonly string[] | undefined): string[][] => {
  const at = provider?.indexOf('flow') ?? -1
  const own = provider && at > 0 ? [...provider.slice(0, at), 'usage', '--json'] : null
  const fallback = ['nanoflow', 'usage', '--json']
  return own && own.join(' ') !== fallback.join(' ') ? [own, fallback] : [fallback]
}
