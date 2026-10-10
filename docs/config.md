# Configuration: `.claude/nanoflow.json`

<sub>[nanoflow](../README.md) by [nanosite.ai](https://nanosite.ai)</sub>

One file, committed to your repo, read by both the Claude Code plugin and the CLI. Every field is optional;
with no file at all, the plugin still shows your worktrees from plain `git` + `gh`.

**Where it's read from** (first hit wins): the current checkout's `.claude/nanoflow.json`, the main
checkout's, then a personal `~/.claude/nanoflow/<repo-folder-name>.json` (to try nanoflow on a repo without
committing anything).

`nf init` writes a starter from what your repo already has. The JSON schema
([nanoflow.schema.json](../nanoflow.schema.json)) gives your editor completion.

## Fields

| Field | Default | What it does |
|---|---|---|
| `mainBranch` | `"main"` | The branch PRs merge into; "ahead" counts and PR titles are taken against it. |
| `github.repo` | from the `origin` remote | `owner/name`, when the remote isn't GitHub or there are several. |
| `github.board` | none | `{ "owner": "acme", "number": 3 }`: your GitHub Project (v2). Its ids are looked up once and cached in `.git/nanoflow/board.json`. |
| `github.board.statuses` | `Backlog`, `Ready`, `In progress`, `In review`, `Done` | Your Status column names per step, e.g. `{ "in-progress": "Doing" }`. |
| `ticket.branchPattern` | `"(?:^\|/)(\\d+)-"` | Regex; its first group is the ticket number in a branch (`feat/712-x` → 712). |
| `ticket.urlTemplate` | GitHub issue URL | Ticket links for another tracker: `"https://acme.atlassian.net/browse/APP-{ticket}"`. |
| `ticket.types` | `feature`, `bug`, `chore`, `refactor` | What `--type` accepts. |
| `ticket.labels` | none | Label templates: `{ "type": "type:{type}", "area": "area:{area}" }`. |
| `ticket.sections` | Definition / Implementation plan / Test plan / Definition of Done; bugs: Symptom / Reproduction / Root cause / Fix / Testing | Body headings for `ticket new`; `--definition`, `--plan`, `--test-plan` fill the first three. |
| `slot.file` / `slot.key` | `.worktree.json` / `"slot"` | The per-worktree slot record (kept out of git via `.git/info/exclude`). |
| `slot.mainSlot` | `0` | The main checkout's slot. |
| `host` | `"localhost"` | Host in service URLs. |
| `services[]` | none | See below. |
| `env.export` | `{}` | Env for every process `nf up` starts. Values take placeholders. |
| `env.worktree` | `{}` | Like `export`, but only off the main slot (e.g. a queue prefix that must differ from main's). |
| `env.files` | `{}` | `{ "apps/api/.env": { "PORT": "{port:api}" } }`: keys written into a new worktree's files. |
| `worktree.dir` | `"../{repo}-{feature}"` | Where new worktrees go, relative to the main checkout. |
| `worktree.branch` | `"feat/{feature}"` | A new worktree's branch. |
| `worktree.copy` | `[".env"]` | Gitignored files copied from the main checkout (shared secrets, shared database). |
| `worktree.install` | none | Run in a new worktree, e.g. `"npm install"`. |
| `stack.before` | `[]` | Shell commands `nf up` runs first (e.g. build shared packages). |
| `stack.stateDir` | `".nanoflow"` | Per-checkout logs and pid of `nf up --bg`. |
| `stack.timeoutSeconds` | `180` | How long `nf up` waits for the services to answer. |
| `checks` | `{}` | `nf check`: `{ "typecheck": "npm run typecheck", "test": "npm test" }`. |
| `pr.conventional` | `true` | Refuse a PR title that isn't a Conventional Commit. |
| `pr.shotsBranch` | `"assets/pr-screenshots"` | Orphan branch for PR screenshots (created on first use). |
| `title.enabled` | `true` | Rename the Claude Code session and terminal tab at each step. |
| `title.format` | `"#{ticket} · {branch} · {short}"` | The title. |
| `teardown.checklist` | close the browser, delete local screenshots | Printed after every teardown, for what only the agent can do. |

### Plugin-only fields

| Field | Default | What it does |
|---|---|---|
| `provider.snapshot` / `provider.local` | none | A command printing the [provider contract](provider-contract.md) as JSON. With the CLI: `["nanoflow", "flow", "--json"]` and `[…, "--local"]`. Without one, the plugin scans with `git` + one `gh` GraphQL query. |
| `poll.localSeconds` | `15` | How often git state and ports are re-read. |
| `poll.githubSeconds` | `300` (min 60) | How often tickets, PRs and CI are re-read: one GraphQL query each time. |
| `rules[]` | none | Your own Bash command → toast rules, tried before the built-in ones. `{ "match": "\\bmake deploy\\b", "label": "deploy", "kind": "ship", "toast": { "ok": "Deployed 🚀", "fail": "Deploy failed" }, "rescan": "full", "important": true }` |
| `actions` | plain git / gh | The pane's buttons; see below. |

Personal settings (not in the repo) are in the plugin's options: `toasts` (`all` / `important` / `off`) and
`openPaneOnStart`.

## Services

```json
{ "name": "api", "base": 3001, "step": 10, "path": "/healthz", "start": { "run": "npm start", "cwd": "apps/api" } }
```

| Key | What it does |
|---|---|
| `name` | Shown in the pane, `nf env`, `nf logs <name>`, and as `{port:<name>}` in templates. |
| `base` / `step` | Port = `base + slot × step`. Leave `base` out for a process without a port (a worker). |
| `path` | Health path probed for "is it up"; any HTTP answer counts. Default `/`. |
| `open` | The service "Open app" links to. |
| `start.run` / `start.cwd` | How `nf up` starts it (a shell command, in `cwd` relative to the checkout). |
| `optional` | Only started with `nf up --with <name>`. |
| `ready` | `false` = `nf up` doesn't wait for it to answer. |

## Placeholders

Templates in `env`, `worktree`, `title.format` and `actions` take:

| Placeholder | Value |
|---|---|
| `{slot}` | the worktree's slot |
| `{port:<service>}`, `{origin:<service>}` | that service's port / `http://host:port` on this slot |
| `{host}` | `host` |
| `{repo}` | the main checkout's folder name |
| `{feature}`, `{ticket}`, `{slug}` | the worktree's name `712-site-offline`, and its parts |
| `{branch}`, `{short}` | in `title.format` |

In the plugin's `actions`: `{ticket}` `{title}` `{name}` `{feature}` `{path}` `{branch}` `{pr}` `{mainRoot}`.

An unknown placeholder is an error in the CLI, so a typo fails loudly instead of writing an empty port.

## Pane actions

```json
"actions": {
  "startDev":  { "label": "Start dev", "run": ["nanoflow", "up", "--bg"] },
  "stopDev":   { "label": "Stop", "run": ["nanoflow", "kill"], "confirm": true },
  "pickUp":    { "label": "Pick up", "prompt": "Pick up ticket #{ticket} ({title}) in the worktree at {path}: `nanoflow board set {ticket} in-progress`, then plan the work." },
  "teardown":  { "label": "Teardown", "run": ["nanoflow", "wt", "remove", "{feature}", "--delete-branch", "--yes"], "cwd": "main", "confirm": true },
  "startTask": { "label": "Start", "prompt": "Start ticket #{ticket} ({title}) with `nanoflow task start {ticket}`, then plan the work." },
  "newTicket": { "label": "Create", "run": ["nanoflow", "ticket", "new", "{title}"], "cwd": "main" }
}
```

`run` runs on your machine (no shell) in the selected worktree, or the main checkout with `"cwd": "main"`.
`prompt` hands the work to Claude instead. `confirm` asks first. `null` removes a button.
A worktree's buttons show when you expand its card; `pickUp` only while its ticket isn't In progress, In review or Done yet and has no PR.

## A full example

A monorepo with a web app, an API, a worker and a background queue:

```json
{
  "$schema": "https://raw.githubusercontent.com/nanosite-ai/nanoflow/main/nanoflow.schema.json",
  "github": { "board": { "owner": "acme", "number": 3 } },
  "ticket": { "labels": { "type": "type:{type}", "area": "area:{area}" } },
  "services": [
    { "name": "web", "base": 5173, "step": 10, "open": true, "start": { "run": "npm run dev", "cwd": "apps/web" } },
    { "name": "api", "base": 3001, "step": 10, "path": "/healthz", "start": { "run": "npm start", "cwd": "apps/api" } },
    { "name": "worker", "start": { "run": "npm run worker", "cwd": "apps/api" } }
  ],
  "env": {
    "export": { "VITE_PORT": "{port:web}", "VITE_API": "{origin:api}", "PORT": "{port:api}" },
    "worktree": { "QUEUE_PREFIX": "jobs-{feature}" },
    "files": { "apps/api/.env": { "PORT": "{port:api}", "APP_ORIGIN": "{origin:web}" } }
  },
  "worktree": { "copy": [".env", "apps/api/.env", "apps/web/.env"], "install": "npm install" },
  "stack": { "before": ["npm run build -w packages/shared"] },
  "checks": { "typecheck": "npm run typecheck", "lint": "npm run lint", "test": "npm test", "e2e": "npx playwright test" },
  "provider": { "snapshot": ["nanoflow", "flow", "--json"], "local": ["nanoflow", "flow", "--json", "--local"] }
}
```
