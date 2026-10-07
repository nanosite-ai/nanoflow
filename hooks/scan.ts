// Pure helpers for building a snapshot. The I/O itself lives in register.tsx: `$` never crosses an import.
import type { NfCi, NfSnapshot, NfTicket } from '../types'
import type { NfConfig } from './config'
import { fillTemplate } from './config'

/** cmd.exe quoting for one argument. */
export const quoteForCmd = (arg: string): string => (/^[\w./:=@\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`)

export const parseJson = <T>(text: string | null): T | null => {
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export const isSnapshot = (v: unknown): v is NfSnapshot =>
  typeof v === 'object' && v !== null && Array.isArray((v as NfSnapshot).worktrees) && typeof (v as NfSnapshot).mainRoot === 'string'

export const normalizePath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

export const samePath = (a: string, b: string, win: boolean): boolean =>
  win ? normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase() : normalizePath(a) === normalizePath(b)

export const isInside = (dir: string, root: string, win: boolean): boolean => {
  const d = win ? normalizePath(dir).toLowerCase() : normalizePath(dir)
  const r = win ? normalizePath(root).toLowerCase() : normalizePath(root)
  return d === r || d.startsWith(`${r}/`)
}

export const baseName = (p: string): string => normalizePath(p).split('/').pop() ?? p

export type GitWorktree = { path: string; branch: string | null }

export const parseWorktreeList = (porcelain: string): GitWorktree[] => {
  const trees: GitWorktree[] = []
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) trees.push({ path: normalizePath(line.slice(9).trim()), branch: null })
    const last = trees[trees.length - 1]
    if (line.startsWith('branch ') && last) last.branch = line.slice(7).replace('refs/heads/', '').trim()
  }
  return trees
}

export const ticketNumberOf = (pattern: string, branch: string | null, name: string): number | null => {
  const re = new RegExp(pattern)
  const match = re.exec(branch ?? '') ?? re.exec(name)
  const n = match?.[1] ? Number(match[1]) : NaN
  return Number.isInteger(n) ? n : null
}

export type CheckRun = { status?: string; conclusion?: string | null; state?: string; detailsUrl?: string; targetUrl?: string }
const FAILING = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PENDING = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED'])

/** statusCheckRollup → one CI state + the link worth opening (same rules as `ns flow`). */
export const ciRollup = (checks: readonly CheckRun[]): { ci: NfCi; ciUrl: string | null } => {
  if (checks.length === 0) return { ci: 'none', ciUrl: null }
  const verdict = (c: CheckRun): string => (c.conclusion || c.state || c.status || '').toUpperCase()
  const link = (c: CheckRun | undefined): string | null => c?.detailsUrl ?? c?.targetUrl ?? null
  const failed = checks.find(c => FAILING.has(verdict(c)))
  if (failed) return { ci: 'fail', ciUrl: link(failed) }
  const pending = checks.find(c => PENDING.has(verdict(c)) || (c.status !== undefined && c.status !== 'COMPLETED'))
  if (pending) return { ci: 'pending', ciUrl: link(pending) }
  return { ci: 'pass', ciUrl: null }
}

/** http://host:port/path, with the URL API. */
export const serviceUrl = (host: string, port: number, path = '/'): string => {
  const url = new URL('http://localhost')
  url.hostname = host
  url.port = String(port)
  url.pathname = path
  return url.href
}

export const ticketUrl = (config: NfConfig, n: number, githubUrl: string | null): string =>
  config.ticket.urlTemplate ? fillTemplate(config.ticket.urlTemplate, { ticket: n }) : (githubUrl ?? '')

/** A sibling worktree's own part of its name: "repo-712-x" next to main "repo" → "712-x". */
export const featureOf = (name: string, mainRoot: string): string => {
  const prefix = `${baseName(mainRoot)}-`
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

/** owner/name from a GitHub remote URL (https or ssh). */
export const slugFromRemote = (url: string): string | null =>
  /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.slice(1, 3).join('/') ?? null

// ONE GraphQL query per full scan, the same shape as the CLI's `nanoflow flow`: per-worktree gh calls fired
// in parallel trip GitHub's secondary rate limit and drain the hourly budget other tools share.
const PROJECT_STATUS = 'projectItems(first: 10) { nodes { project { number owner { ... on Organization { login } ... on User { login } } } fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }'
const ISSUE_FIELDS = `number title url state ${PROJECT_STATUS}`
const PR_FIELDS = 'number url state commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { ... on CheckRun { status conclusion detailsUrl } ... on StatusContext { state targetUrl } } } } } } }'

type QueryTree = { ticket: { number: number } | null; branch: string | null; isMain: boolean }

export const buildFlowQuery = (trees: readonly QueryTree[]): string => {
  const parts = trees.flatMap((t, i) => [
    ...(t.ticket ? [`t${i}: issue(number: ${t.ticket.number}) { ${ISSUE_FIELDS} }`] : []),
    ...(t.branch && !t.isMain ? [`p${i}: pullRequests(headRefName: ${JSON.stringify(t.branch)}, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }`] : []),
  ])
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { open: issues(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${ISSUE_FIELDS} } } ${parts.join(' ')} } }`
}

type GqlIssue = {
  number: number
  title: string
  url: string
  state: string
  projectItems?: { nodes: Array<{ project: { number: number; owner: { login?: string } }; fieldValueByName: { name?: string } | null }> }
}
type GqlPr = { number: number; url: string; state: string; commits?: { nodes: Array<{ commit: { statusCheckRollup: { contexts: { nodes: CheckRun[] } } | null } }> } }
export type GqlRepo = Record<string, unknown> & { open?: { nodes: GqlIssue[] } }

const statusIn = (config: NfConfig, issue: GqlIssue): string | null => {
  const b = config.github.board
  if (!b) return null
  const item = issue.projectItems?.nodes.find(n => n.project.number === b.number && n.project.owner.login?.toLowerCase() === b.owner.toLowerCase())
  return item?.fieldValueByName?.name ?? null
}

/** Fold the query's answer into the worktrees (mutating them) and return the tickets up next / in flight. */
export const applyFlowResult = (config: NfConfig, trees: NfSnapshot['worktrees'], data: GqlRepo): NfTicket[] => {
  trees.forEach((t, i) => {
    const issue = data[`t${i}`] as GqlIssue | null | undefined
    if (t.ticket && issue) Object.assign(t.ticket, { title: issue.title, state: issue.state, status: statusIn(config, issue), url: ticketUrl(config, t.ticket.number, issue.url) })
    const pr = (data[`p${i}`] as { nodes: GqlPr[] } | null | undefined)?.nodes[0]
    t.pr = pr ? { number: pr.number, url: pr.url, state: pr.state, ...ciRollup(pr.commits?.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []) } : null
  })
  const worktreeOf = new Map(trees.flatMap(t => (t.ticket ? [[t.ticket.number, t.name] as const] : [])))
  const active = config.github.board?.active ?? null
  return (data.open?.nodes ?? [])
    .map(r => ({ number: r.number, title: r.title, url: ticketUrl(config, r.number, r.url), state: r.state, status: statusIn(config, r), worktree: worktreeOf.get(r.number) ?? null }))
    .filter(r => active === null || (r.status !== null && active.includes(r.status)))
}
