// The repo's .claude/nanoflow.json, merged over defaults. Pure: no `$` here.

export type NfServiceSpec = {
  name: string
  /** Port in the main checkout (slot 0). */
  base: number
  /** Added per slot: port = base + slot * step. */
  step: number
  /** Health path probed for liveness (any HTTP answer = up). */
  path?: string
  /** The service the "Open app" link goes to. */
  open?: boolean
}

export type NfToast = string | { start?: string; ok?: string; fail?: string }

export type NfRule = {
  /** Regular expression tested against each Bash command. */
  match: string
  /** Short name in toasts and the status line, e.g. "tests". */
  label?: string
  /** Checks of one kind feed one progress stage; test/check/e2e count as "checks". */
  kind?: 'test' | 'e2e' | 'check' | 'git' | 'github' | 'task' | 'ship' | 'other'
  toast?: NfToast
  /** Rescan after it ran: "local" (git, ports) or "full" (also tickets/PRs). */
  rescan?: 'local' | 'full'
  /** Toast even when the person chose "important" toasts only. */
  important?: boolean
}

/**
 * One button's command. Placeholders: {ticket} (the key: 712 or ED-712) {ref} (#712 or ED-712) {title}
 * {name} {feature} (the name without the main checkout's folder prefix) {path} {branch} {pr} {mainRoot}.
 */
export type NfAction = {
  label?: string
  /** Run on the host (no shell), e.g. ["ns", "up", "--bg"]. */
  run?: string[]
  /** Or queue a prompt for Claude, for flows that need the agent. */
  prompt?: string
  /** Where `run` runs: the selected worktree (default) or the main checkout. */
  cwd?: 'worktree' | 'main'
  confirm?: boolean
}

export const ACTION = {
  pickUp: 'pickUp',
  startDev: 'startDev',
  stopDev: 'stopDev',
  teardown: 'teardown',
  startTask: 'startTask',
  newTicket: 'newTicket',
} as const
export type NfActionKey = (typeof ACTION)[keyof typeof ACTION]

export const TRACKERS = ['github', 'jira'] as const
export type NfTracker = (typeof TRACKERS)[number]

/** A ticket key per tracker, unless ticket.keyPattern says otherwise. */
const KEY_PATTERNS: Record<NfTracker, string> = { github: '\\d+', jira: '[A-Z][A-Z0-9]+-\\d+' }

export type NfConfig = {
  mainBranch: string
  /** Commands that print a provider-contract snapshot as JSON; the built-in git/gh scanner otherwise. */
  provider: { snapshot: string[]; local?: string[] } | null
  ticket: {
    /** Where tickets live. "github": read their titles and the open ones with gh. "jira": key + link only. PRs and CI are GitHub's either way. */
    tracker: NfTracker
    /** Regex for one ticket key: `\d+` for GitHub issues, `[A-Z][A-Z0-9]+-\d+` for Jira. */
    keyPattern: string
    /** First capture group = the ticket key, read from the branch (then the worktree name). Default: built from keyPattern. */
    branchPattern: string
    /** For trackers other than GitHub Issues, e.g. "https://acme.atlassian.net/browse/{ticket}". */
    urlTemplate?: string
  }
  /** The GitHub repo (default: from the origin remote) and the Project board whose Status column tickets show. */
  github: { repo?: string; board: { owner: string; number: number; active: string[] } | null }
  slot: { file: string; key: string; mainSlot: number }
  host: string
  services: NfServiceSpec[]
  poll: { localSeconds: number; githubSeconds: number }
  rules: NfRule[]
  actions: Partial<Record<NfActionKey, NfAction>>
}

export const DEFAULT_CONFIG: NfConfig = {
  mainBranch: 'main',
  provider: null,
  ticket: { tracker: 'github', keyPattern: KEY_PATTERNS.github, branchPattern: '(?:^|/)(\\d+)-' },
  github: { board: null },
  slot: { file: '.worktree.json', key: 'slot', mainSlot: 0 },
  host: 'localhost',
  services: [],
  // GitHub's GraphQL budget (5,000/hr) is shared with every gh user on the machine: one query per 5 min.
  poll: { localSeconds: 15, githubSeconds: 300 },
  rules: [],
  actions: {
    [ACTION.teardown]: { label: 'Teardown', run: ['git', 'worktree', 'remove', '{path}'], cwd: 'main', confirm: true },
    [ACTION.pickUp]: {
      label: 'Pick up',
      prompt: 'Pick up ticket {ref} ({title}) in the worktree at {path}: move it to In progress, then read the ticket and plan the work.',
    },
    [ACTION.startTask]: {
      label: 'Start task',
      prompt: 'Start work on ticket {ref} ({title}): create a git worktree and a branch for it, then outline the plan.',
    },
    [ACTION.newTicket]: { label: 'Create', run: ['gh', 'issue', 'create', '--title', '{title}', '--body', ''], cwd: 'main' },
  },
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')

/** Merge a parsed nanoflow.json over the defaults; unknown or ill-typed fields are ignored. */
export const mergeConfig = (raw: unknown): NfConfig => {
  if (!isRecord(raw)) return DEFAULT_CONFIG
  const d = DEFAULT_CONFIG
  const ticket = isRecord(raw.ticket) ? raw.ticket : {}
  const slot = isRecord(raw.slot) ? raw.slot : {}
  const poll = isRecord(raw.poll) ? raw.poll : {}
  const provider = isRecord(raw.provider) && isStrings(raw.provider.snapshot) && raw.provider.snapshot.length > 0
    ? { snapshot: raw.provider.snapshot, ...(isStrings(raw.provider.local) ? { local: raw.provider.local } : {}) }
    : null
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v !== '' ? v : fallback)
  const num = (v: unknown, fallback: number, min = 0): number => (typeof v === 'number' && v >= min ? v : fallback)
  // `ticket.github: false` is 0.1.x's way of saying the tickets aren't GitHub issues.
  const tracker: NfTracker = (TRACKERS as readonly unknown[]).includes(ticket.tracker)
    ? (ticket.tracker as NfTracker)
    : ticket.github === false ? 'jira' : d.ticket.tracker
  const keyPattern = typeof ticket.keyPattern === 'string' && isValidRegex(ticket.keyPattern) ? ticket.keyPattern : KEY_PATTERNS[tracker]
  const github = isRecord(raw.github) ? raw.github : {}
  const board = isRecord(github.board) && typeof github.board.owner === 'string' && typeof github.board.number === 'number' ? github.board : null
  const statuses = board && isRecord(board.statuses) ? board.statuses : {}
  const column = (key: string, fallback: string): string => (typeof statuses[key] === 'string' ? (statuses[key] as string) : fallback)
  const services = Array.isArray(raw.services)
    ? raw.services.filter((s): s is NfServiceSpec => isRecord(s) && typeof s.name === 'string' && typeof s.base === 'number')
        .map(s => ({ ...s, step: typeof s.step === 'number' ? s.step : 0 }))
    : d.services
  const rules = Array.isArray(raw.rules)
    ? raw.rules.filter((r): r is NfRule => isRecord(r) && typeof r.match === 'string' && isValidRegex(r.match))
    : []
  const actions: NfConfig['actions'] = { ...d.actions }
  if (isRecord(raw.actions)) {
    for (const [key, value] of Object.entries(raw.actions)) {
      if (!(Object.values(ACTION) as string[]).includes(key)) continue
      if (value === null) delete actions[key as NfActionKey]
      else if (isRecord(value) && (isStrings(value.run) || typeof value.prompt === 'string')) actions[key as NfActionKey] = value as NfAction
    }
  }
  return {
    mainBranch: str(raw.mainBranch, d.mainBranch),
    provider,
    ticket: {
      tracker,
      keyPattern,
      branchPattern: typeof ticket.branchPattern === 'string' && isValidRegex(ticket.branchPattern) ? ticket.branchPattern : branchPatternFor(keyPattern),
      ...(typeof ticket.urlTemplate === 'string' ? { urlTemplate: ticket.urlTemplate } : {}),
    },
    github: {
      ...(typeof github.repo === 'string' ? { repo: github.repo } : {}),
      board: board ? { owner: board.owner as string, number: board.number as number, active: [column('ready', 'Ready'), column('in-progress', 'In progress'), column('in-review', 'In review')] } : null,
    },
    slot: { file: str(slot.file, d.slot.file), key: str(slot.key, d.slot.key), mainSlot: num(slot.mainSlot, d.slot.mainSlot) },
    host: str(raw.host, d.host),
    services,
    poll: { localSeconds: num(poll.localSeconds, d.poll.localSeconds, 5), githubSeconds: num(poll.githubSeconds, d.poll.githubSeconds, 60) },
    rules,
    actions,
  }
}

/** The branch pattern a key pattern implies: `<key>-` at the start or after a slash. */
export const branchPatternFor = (keyPattern: string): string => `(?:^|/)(${keyPattern})-`

const isValidRegex = (source: string): boolean => {
  try {
    new RegExp(source)
    return true
  } catch {
    return false
  }
}

/** Fill {placeholders}; unknown ones become empty. */
export const fillTemplate = (text: string, vars: Readonly<Record<string, string | number | null | undefined>>): string =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = vars[key]
    return value === null || value === undefined ? '' : String(value)
  })

/** A starter nanoflow.json for `/nanoflow init`, from what the repo already has. */
export const starterConfig = (found: { hasSlotFile: boolean; mainBranch: string; scripts: readonly string[] }): string => {
  const rules: NfRule[] = []
  if (found.scripts.includes('typecheck')) rules.push({ match: '\\bnpm run typecheck\\b', kind: 'check', label: 'typecheck' })
  const config = {
    $schema: 'https://raw.githubusercontent.com/nanosite-ai/nanoflow/main/nanoflow.schema.json',
    mainBranch: found.mainBranch,
    ticket: { tracker: 'github', branchPattern: DEFAULT_CONFIG.ticket.branchPattern },
    ...(found.hasSlotFile ? { slot: DEFAULT_CONFIG.slot } : {}),
    services: [{ name: 'app', base: 3000, step: 10, path: '/', open: true }],
    rules,
    actions: {},
  }
  return `${JSON.stringify(config, null, 2)}\n`
}
