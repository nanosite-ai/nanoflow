# Provider contract (version 1)

<sub>[nanoflow](../README.md) by [nanosite.ai](https://nanosite.ai)</sub>

The dashboard reads one JSON document: a snapshot of every worktree and the open tickets. `nanoflow flow
--json` prints it. If your team already has a dev CLI, make it print the same shape and point the plugin
at it:

```json
"provider": { "snapshot": ["mycli", "flow", "--json"], "local": ["mycli", "flow", "--json", "--local"] }
```

- `snapshot` runs every `poll.githubSeconds` and after GitHub moments (PR opened, CI…).
- `local` (optional) runs every `poll.localSeconds`: skip GitHub there and answer in well under a second.
  The plugin keeps tickets, PRs and the board from the last full snapshot.
- Exit 0 with the JSON on stdout. On failure, the plugin warns once and falls back to its own `git` + `gh` scan.

The contract only grows: fields are added, never renamed or removed.

```ts
type Snapshot = {
  version: 1
  generatedAt: string            // ISO time
  mainRoot: string               // the main checkout's path
  current: string | null         // path of the worktree the command ran in
  worktrees: Worktree[]
  board: Ticket[] | null         // tickets up next / in flight; null when not read (e.g. --local)
}

type Worktree = {
  name: string                   // folder name
  path: string
  branch: string | null
  isMain: boolean
  isCurrent: boolean
  slot: number | null
  dirty: number                  // changed files
  ahead: number                  // commits not on the main branch
  services: { name: string; port: number; url: string; isUp: boolean }[]
  ticket: Ticket | null
  pr: { number: number; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; ci: 'pass' | 'fail' | 'pending' | 'none'; ciUrl: string | null } | null
}

type Ticket = {
  number: number
  title: string | null
  url: string
  state: string | null           // OPEN | CLOSED
  status: string | null          // board column, e.g. "In progress"
  worktree: string | null        // name of the worktree working on it
}
```

`ciUrl` is the first failing check's page when CI is red, else the first pending one.
