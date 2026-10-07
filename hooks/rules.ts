// Which Bash commands are workflow moments, and what each one's outcome says. Pure.
import type { NfRule } from './config'

/** `nanoflow <sub>` or `nf <sub>` at a command boundary. */
const cli = (sub: string): string => `(?:^|[\\s;&|(])(?:nanoflow|nf) ${sub}\\b`

const nanoflowRules = (): NfRule[] => {
  return [
    { match: cli('task start'), kind: 'task', label: 'kickoff', toast: { ok: 'Task started: ticket In progress, worktree ready', fail: 'Task kickoff failed' }, rescan: 'full', important: true },
    { match: cli('task pr'), kind: 'task', label: 'task pr', toast: { ok: 'Ticket → In review' }, rescan: 'full' },
    { match: cli('task (done|merged)'), kind: 'task', label: 'task done', toast: { ok: 'Ticket → Done ✓' }, rescan: 'full', important: true },
    { match: cli('pr create'), kind: 'github', label: 'PR', toast: { ok: 'PR opened', fail: 'PR create failed' }, rescan: 'full', important: true },
    { match: cli('ticket new'), kind: 'github', label: 'ticket', toast: { ok: 'Ticket created' }, rescan: 'full' },
    { match: cli('wt (remove|clean)'), kind: 'git', label: 'teardown', toast: { ok: 'Worktree torn down', fail: 'Teardown failed' }, rescan: 'local', important: true },
    { match: cli('wt create'), kind: 'git', label: 'worktree', toast: { ok: 'Worktree created', fail: 'Worktree create failed' }, rescan: 'local' },
    { match: cli('up'), kind: 'other', label: 'dev stack', toast: { start: 'Starting the dev stack…', ok: 'Dev stack up', fail: 'Dev stack failed to start' }, rescan: 'local' },
    { match: cli('kill'), kind: 'other', label: 'stop', toast: { ok: 'Dev stack stopped' }, rescan: 'local' },
    { match: cli('check'), kind: 'check', label: 'checks', toast: { start: 'checks running…', ok: 'Checks green', fail: 'Checks failed' } },
    { match: cli('ci'), kind: 'github', label: 'CI', toast: { ok: 'CI green', fail: 'CI red' }, rescan: 'full', important: true },
    { match: cli('shots'), kind: 'github', label: 'screenshots', toast: { ok: 'Screenshots uploaded to the PR' } },
  ]
}

/** Generic rules every repo gets; a repo's own rules are tried first. Specific before general. */
export const BUILTIN_RULES: readonly NfRule[] = [
  // The nanoflow CLI (`nanoflow …` or `nf …`).
  ...nanoflowRules(),
  { match: '\\bgit worktree add\\b', kind: 'git', label: 'worktree', toast: { ok: 'Worktree created', fail: 'Worktree add failed' }, rescan: 'local' },
  { match: '\\bgit worktree remove\\b', kind: 'git', label: 'worktree', toast: { ok: 'Worktree removed', fail: 'Worktree remove failed' }, rescan: 'local' },
  { match: '\\bgh pr create\\b', kind: 'github', label: 'PR', toast: { ok: 'PR opened', fail: 'PR create failed' }, rescan: 'full', important: true },
  { match: '\\bgh pr merge\\b', kind: 'github', label: 'merge', toast: { ok: 'PR merged', fail: 'Merge failed' }, rescan: 'full', important: true },
  { match: '\\bgh issue create\\b', kind: 'github', label: 'ticket', toast: { ok: 'Ticket created', fail: 'Ticket create failed' }, rescan: 'full' },
  { match: '\\bgh pr checks\\b', kind: 'github', label: 'CI', toast: { ok: 'CI green', fail: 'CI not green' }, rescan: 'full' },
  { match: '\\bgit push\\b', kind: 'git', label: 'push', toast: { ok: 'Pushed', fail: 'Push failed' }, rescan: 'full' },
  { match: '\\bgit commit\\b', kind: 'git', label: 'commit', toast: { fail: 'Commit rejected' }, rescan: 'local' },
  { match: '\\bplaywright test\\b', kind: 'e2e', label: 'e2e', toast: { start: 'e2e running…', ok: 'e2e passed', fail: 'e2e failed' } },
  {
    match: '\\b(vitest|jest|pytest|go test|cargo test|(npm|pnpm|yarn|bun) (run )?test(:[\\w-]+)?)\\b',
    kind: 'test',
    label: 'tests',
    toast: { start: 'tests running…', ok: 'Tests passed', fail: 'Tests failed' },
  },
  { match: '\\b(tsc|(npm|pnpm|yarn) run (tsc|typecheck))\\b', kind: 'check', label: 'typecheck', toast: { ok: 'Types clean', fail: 'Type errors' } },
  { match: '\\b(eslint|(npm|pnpm|yarn) run lint)\\b', kind: 'check', label: 'lint', toast: { ok: 'Lint clean', fail: 'Lint errors' } },
]

/** Kinds that make up the "checks" progress stage. */
export const CHECK_KINDS: ReadonlySet<string> = new Set(['test', 'e2e', 'check'])

export type MatchedRule = NfRule & { label: string }

/** The first rule (repo rules, then built-ins) whose pattern matches the command. */
export const matchRule = (command: string, repoRules: readonly NfRule[]): MatchedRule | null => {
  for (const rule of [...repoRules, ...BUILTIN_RULES]) {
    if (new RegExp(rule.match).test(command)) return { ...rule, label: rule.label ?? rule.kind ?? 'command' }
  }
  return null
}

/** The toast text for a phase, or null for none. A plain string toast only fires on success. */
export const toastFor = (rule: NfRule, phase: 'start' | 'ok' | 'fail'): string | null => {
  if (rule.toast === undefined) return null
  if (typeof rule.toast === 'string') return phase === 'ok' ? rule.toast : phase === 'fail' ? `${rule.toast} (failed)` : null
  return rule.toast[phase] ?? null
}

/** A one-line summary of a command for the activity feed. */
export const shortCommand = (command: string, max = 60): string => {
  const one = command.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export type BrowserEvent = { kind: 'navigate'; url: string } | { kind: 'close' } | { kind: 'screenshot'; file: string | null }

/** A Playwright MCP call (any server named *playwright*) as a browser moment, or null. */
export const browserEventOf = (tool: string, input: Readonly<Record<string, unknown>>): BrowserEvent | null => {
  const match = /^mcp__[^_]*playwright[^_]*__browser_(\w+)$/i.exec(tool)
  if (!match) return null
  const action = match[1]
  if (action === 'navigate') return { kind: 'navigate', url: typeof input.url === 'string' ? input.url : '' }
  if (action === 'close') return { kind: 'close' }
  if (action === 'take_screenshot') return { kind: 'screenshot', file: typeof input.filename === 'string' ? input.filename : null }
  return null
}
