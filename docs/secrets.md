# Secrets: values Claude uses without seeing

<sub>[nanoflow](../README.md) by [nanosite.ai](https://nanosite.ai)</sub>

nanoflow keeps a vault of secrets (API keys, tokens, passwords) that you can store, view, copy and insert
easily. Claude never reads the values. It knows the names and writes a placeholder where a value goes.

## Using it

**`/secrets`** opens the Secrets pane:

| In the pane | What it does |
|---|---|
| **Add a secret** | Type a name (`STRIPE_SECRET_KEY`; lowercase and `-` are turned into `UPPER_SNAKE_CASE`), then the value and Enter. Both fields are cleared after a save. |
| **Import a .env file** | A path (absolute, `~/…`, or relative to the session's folder). Every `KEY=VALUE` line is stored (`export`, quotes and comments handled). The pane lists only the names it imported. |
| **📋 Copy** | Puts the value on your clipboard. |
| **👁 Reveal** | Shows the value in the pane for 10 seconds, then hides it. |
| **✏️ Rename** / **🗑 Delete** | Delete asks first, in the pane. |

Each row shows a name and the value's length. It never shows a masked prefix or suffix. When the vault
has entries, the status line shows `🔐 <count>`.

**In a prompt**, ask for what you need by name: *"call the Stripe API with STRIPE_SECRET_KEY"*. Claude
writes `{{secret:STRIPE_SECRET_KEY}}` in the command.

**If you paste a secret into a prompt** by accident, it's stored before Claude sees it. The prompt then
reads `{{secret:PASTED_1}}` and a toast says *Stored as PASTED_1 — rename in /secrets*. A value that's
already in the vault is replaced with its existing name.

## How it works

| Moment | Hook | What happens |
|---|---|---|
| Every request | `prompt.compose` | A short system section (`nanoflow:secrets`, session scope) tells Claude to never print, echo or ask for a value, to use `{{secret:NAME}}` in Bash/PowerShell commands and Write/Edit content, and to ask you to add a missing one via `/secrets`. It lists the available names, never a value. |
| A tool runs | `tool.call` (Bash, PowerShell, Write, Edit) | `{{secret:NAME}}` in `command`, `content`, `old_string` or `new_string` is replaced with the value, and the call goes on with `next({ ...e, input })`. An unknown name is denied with *secret NAME isn't in the vault; ask the user to add it with /secrets*. Because Edit's `old_string` is filled in too, Claude can edit a line it read as a placeholder. |
| Any row enters the conversation | `session.append` | Text blocks and every `tool_result` (any tool: Read, Grep, Bash, WebFetch, MCP tools, an Agent's result, and the rows inside a subagent's own loop) are masked before they're stored. Vault values, including their base64 and URL-encoded forms, become `{{secret:NAME}}`. Known formats become `«redacted:<kind>»`. |
| The engine injects context | `prompt.attachment` | Mentioned files, changed-file diffs and hook context are masked the same way. |
| A message leaves | `session.send` | A message to another agent or session is masked. |
| You submit a prompt | `prompt.submit`, `command.run` | Secrets are vaulted as `PASTED_<n>` and replaced by placeholders, in a slash command's arguments too. |

**Detected formats:** PEM private keys, JWTs (`eyJ….….…`), GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`,
`github_pat_`), npm (`npm_`), Stripe (`sk_live_`, `sk_test_`, `rk_`, `whsec_`), Slack (`xoxa/b/p/r/s-`),
AWS access keys (`AKIA`, `ASIA`), Google API keys (`AIza`), `ndv_` tokens. Assignment lines whose key says
`SECRET`, `TOKEN`, `KEY`, `PASSWORD`, `PASS`, `PEPPER`, `PRIVATE` or `CREDENTIAL` are also detected, in
`.env`, YAML and JSON forms. For those, the key is kept and only the value is masked
(`DB_PASSWORD=«redacted:value»`). References such as `process.env.X`, `${VAR}` and `{{secret:X}}`, numbers
and booleans are left alone.

### Why mask at `session.append` and not in `tool.call`'s result

`tool.call` offers two ways to change what the model reads after `next(e)`, and both are worse for this
job:

- **`{ deny: redactedText }`** makes the model read *"<tool> ran, and a plugin withheld its result: …"*.
  Every masked result then looks like an error. The model tends to retry the call or work around it, and
  the result's normal shape and `is_error` meaning are lost.
- **`{ result }`** is validated against each tool's own output schema and mapped by that tool's own
  mapper. A generic rewrite would have to know every built-in and MCP tool's result shape.

`session.append` is the single place every row enters a conversation, whatever produced it: every tool,
every subagent's loop, deliveries, hook context and compaction. What it stores is exactly what the next
request sends. Rewriting a row's text blocks and `tool_result` content works the same way for every tool.
The screen's own record of a tool result is stored as made, so **you** still see the real output while
the model gets the masked copy. If the hook ever fails, its `.catch` still masks every known format
(only vault lookups are lost).

## Limits

- **The vault is local plaintext**, like a `.env` file. It's a JSON file in Claude Code's config
  directory (the plugin's `$.store`), readable by your user account. An OS keychain backend may come later.
- **The add field shows what you type** on your own screen, because the pane's input has no password
  mode. The value never reaches the model.
- **Pattern detection can miss unusual formats**: a vendor-specific token shape it doesn't know, a
  password under a key that doesn't say secret, or a value split across lines. Put such secrets in the
  vault, and they're masked by value.
- Vault values shorter than 6 characters aren't masked by value (too many false hits); format and
  assignment detection still apply to them.
- A `«redacted:<kind>»` mark can't be turned back into the value, so Claude can't `Edit` a line it only saw
  masked by format. Put the secret in the vault, and it round-trips as `{{secret:NAME}}`.
- A secret that a command uses still exists in that process. A program that sends it elsewhere (logs, a
  remote service) isn't something nanoflow can see.
