// nanoflow's state contract. The snapshot shape is also the PROVIDER CONTRACT (version 1): what a repo's
// `provider.snapshot` command prints as JSON (e.g. `ns flow --json`). Additive changes only.

export type NfCi = 'pass' | 'fail' | 'pending' | 'none'

export type NfService = { name: string; port: number; url: string; isUp: boolean }

export type NfTicket = {
  /** The issue number; for another tracker's key, the number inside it (712 for ED-712). */
  number: number
  /** The ticket key: "712", or "ED-712" when tickets live outside GitHub. Absent from older providers. */
  key?: string
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

export type NfSecretScope = 'project' | 'global'

/** A vault entry as the Secrets pane draws it: never its value. `id` is `<p|g>-<NAME>`. */
export type NfSecret = {
  id: string
  name: string
  scope: NfSecretScope
  length: number
  allow: string[]
  /** Whether it may be written into a file git tracks (the user's choice, off by default). */
  allowTracked: boolean
  /** Whether it may be written into files at all (git-ignored ones; the user's choice, off by default). */
  allowFiles: boolean
  /** What the store allows beyond what the user set in the pane (changed elsewhere, not in force). */
  changed: string[]
  /** Where it came from (`imported by Claude from .secrets/.env · 2026-10-31`, `pasted · auto-vaulted · …`), or `source unknown`. */
  source: string
}

/** What the user allowed a secret for, in the pane. */
export type NfSecretPolicy = { allow: string[]; allowTracked: boolean; allowFiles: boolean }

export type NfSecretsNote = { text: string; tone: NfTone }

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
      /** The worktree this session works in, from the paths its tool calls name; null until one does. */
      focus: string | null
      /** The vault's entries in reach of this session (names, lengths, allowed uses; values stay in $.store). */
      secrets: NfSecret[]
      /** Where this session's project secrets live: its git root (or folder), and the session's folder. */
      secretsProject: { root: string | null; cwd: string }
      /** The secret whose value the pane shows for a few seconds (by id), and when that began. */
      secretsReveal: { id: string; at: number } | null
      /** The secret (by id) a Delete waits to be confirmed for. */
      secretsConfirm: string | null
      /** The secret (by id) whose card is open in the pane; one at a time. */
      secretsOpen: string | null
      /** The open card (by id) whose ⚙ Options are unfolded. */
      secretsOptions: string | null
      /** Which of the pane's forms is open: `add`, `import`, `none`; null until the person picks (add, when the vault is empty). */
      secretsForms: 'add' | 'import' | 'none' | null
      /** The secret (by id) being renamed. */
      secretsRename: string | null
      secretsNote: NfSecretsNote | null
      /** Bumped after a save so the form's fields are drawn empty. */
      secretsForm: number
      /** The add form's name, typed so far (never a value: one that looks like a token is not kept). */
      secretsDraft: string
      /** Where the add form saves. */
      secretsAddScope: NfSecretScope
      /** The secrets the last prompt stored on its own, or Claude's last import (`from`: its file), for Undo. */
      secretsPasted: { names: string[]; scope: NfSecretScope; from?: string } | null
      /**
       * Each secret's policy as the user last set it in the pane (by scope, project and name), or null until the
       * store is first read. Held by the host for the session: no tool call can write it, so a wider policy
       * in the store file is not used until the user accepts it in the pane.
       */
      secretsTrusted: Record<string, NfSecretPolicy> | null
    }
  }
}
