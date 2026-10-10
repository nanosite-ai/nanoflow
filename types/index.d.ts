// nanoflow's state contract. The snapshot shape is also the PROVIDER CONTRACT (version 1): what a repo's
// `provider.snapshot` command prints as JSON (e.g. `ns flow --json`). Additive changes only.

export type NfCi = 'pass' | 'fail' | 'pending' | 'none'

export type NfService = { name: string; port: number; url: string; isUp: boolean }

export type NfTicket = {
  number: number
  title: string | null
  url: string
  state: string | null
  /** Board column, e.g. "In progress". */
  status: string | null
  /** Name of the worktree working on it. */
  worktree: string | null
}

export type NfPr = { number: number; url: string; state: string; ci: NfCi; ciUrl: string | null }

export type NfWorktree = {
  name: string
  path: string
  branch: string | null
  isMain: boolean
  isCurrent: boolean
  slot: number | null
  dirty: number
  ahead: number
  services: NfService[]
  ticket: NfTicket | null
  pr: NfPr | null
}

export type NfSnapshot = {
  version: 1
  generatedAt: string
  mainRoot: string
  current: string | null
  worktrees: NfWorktree[]
  board: NfTicket[] | null
}

export type NfTone = 'info' | 'success' | 'error' | 'warning'

/** `detail`: the full output of a command behind the entry, shown on demand. */
export type NfActivity = { at: number; icon: string; text: string; tone: NfTone; href?: string; detail?: string }

export type NfCheck = { label: string; ok: boolean; at: number }

export type NfTab = 'worktrees' | 'tickets' | 'activity'

export type NfSource = { config: string; provider: string | null; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    nanoflow: {
      snapshot: NfSnapshot | null
      activity: NfActivity[]
      checks: Record<string, NfCheck>
      browserOpen: boolean
      skill: string | null
      tab: NfTab
      selected: string | null
      /** The `at` of the activity entry whose output is open. */
      expanded: number | null
      busy: string | null
      source: NfSource
    }
  }
}
