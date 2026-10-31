# Secrets: values Claude uses without seeing

<sub>[nanoflow](../README.md) by [nanosite.ai](https://nanosite.ai)</sub>

nanoflow keeps a vault of secrets (API keys, tokens, passwords). You can store, view, copy and insert them
easily. Claude knows the names, never the values, and writes a placeholder where a value goes.

> **What this protects against: accidents.** A key echoed in a command's output, a token in a file Claude
> reads, a password pasted into a prompt, a value written into a file you're about to commit. It does
> **not** stop a deliberately hostile or prompt-injected agent. A secret Claude may use with a program can
> be printed in a form no masking anticipates, and the masking only covers the forms listed below. The
> per-secret allowlist limits *where* a value can go. Give each secret only the uses it needs.

## Using it

**`/secrets`** opens the Secrets pane. It shows **This project** (the git repository's main checkout, shared
by its worktrees; the folder itself outside git) and **All projects**:

| In the pane | What it does |
|---|---|
| **Add a secret** | Pick *This project* or *All projects*, type a name (`STRIPE_SECRET_KEY`), then the value and Enter. Both fields clear after a save. If you paste a token into the Name field, it is refused and never kept. |
| **Allow** | The commands and hosts this secret may be used with, e.g. `kubectl, npm, api.example.com`. **A new secret is allowed nowhere**, and the pane says so until you allow something. |
| **📝 Tracked files** | Off by default: the secret is written only into git-ignored files. Turn it on per secret to allow writing it into files git tracks. |
| **Import a .env file** | Takes a path (absolute, `~/…`, or relative to the session's folder). Every `KEY=VALUE` is stored, including multi-line quoted values such as PEM keys. Only the names are shown. |
| **📋 Copy** · **👁 Reveal** (10 s) · **✏️ Rename** · **🗑 Delete** (asks first) | Shown per row. A row shows the name and the value's length, never a part of the value. |
| **↩ Undo** | Shown after a prompt stored a secret on its own; removes it. `/secrets undo` does the same. |

The status line shows `🔐 <count>` when the vault has entries.

**In a prompt**, ask by name: *"deploy with STRIPE_SECRET_KEY"*. Claude writes
`{{secret:STRIPE_SECRET_KEY}}` in the command, and each use raises a toast: *Used STRIPE_SECRET_KEY in curl*.

**Writing the placeholder literally** (docs, templates): escape it with a backslash. `\{{secret:NAME}}` is
written as `{{secret:NAME}}` and uses no secret.

**If you paste a token into a prompt**, a known token format (see below) is stored as `PASTED_<n>` before
Claude reads it. A toast says *Stored as PASTED_1 — rename, allow or undo in /secrets*. A value already in
the vault is replaced by its own name. Context-only finds (a `Bearer` header, a URL password, a
`PASSWORD=…` line) are masked but not stored.

## When a placeholder is filled in

| Tool | Filled into | Only when |
|---|---|---|
| Bash, PowerShell | `command` | The command's **first program** is in the secret's Allow list **and every host** it names (URLs, `user@host`, IPv4) is too (a host covers its subdomains). The value is quoted for the shell at that spot (bash `'…'` with `'\''`; inside `"…"` it escapes `\ " $` and backtick; PowerShell `'…'` with `''`, or backtick escapes inside `"…"`), so `$`, quotes, backticks and newlines stay data. |
| Write, Edit | `content`, `old_string`, `new_string` | The target is **git-ignored** (`git check-ignore`) or outside any repository, unless the user allowed tracked files for that secret or set `secretsAllowTrackedWrites`. |

Anything else is denied with a message the model can act on:

- *secret NAME isn't in the vault; ask the user to add it with /secrets*
- *secret NAME isn't allowed for curl; the user can allow it in /secrets* (or the host it lacks)
- *won't write a real secret into a tracked file (…); the user can allow this in /secrets*

**Tracked files.** The per-secret toggle and the `secretsAllowTrackedWrites` setting (plugin config, off by
default) are changed only by you, in the pane or in your settings. No tool call or hook path changes them.

A **Write, Edit or NotebookEdit whose new content holds a `«redacted:…»` mark** is refused. The mark stands
for a value Claude never saw, so writing it back would destroy the real value.

The secrets `tool.call` hook is registered **innermost** of nanoflow's hooks. nanoflow's own activity feed,
toasts and rules see the placeholder, never the value.

## What Claude reads is masked

| Path | Hook |
|---|---|
| Rows added to a running conversation: every tool result (built-in, MCP, an Agent's result, the rows of a subagent's own loop), deliveries, hook context, compaction | `session.append` rewrites text blocks and `tool_result` content before the row is kept, and what is kept is what the next request sends |
| Per-request injections: a mentioned file, a changed file's diff, a hook's context | `prompt.attachment` |
| Messages to another agent or session | `session.send` |
| Your prompt, and every slash command's arguments | `prompt.submit`, `command.run` |

**Vault values** become `{{secret:NAME}}`, in these forms: as is, upper/lower/mixed case, reversed, hex, base64
at any of the 3 byte alignments, base64url, JSON-escaped and URL-encoded. Values shorter than 6 characters
are not matched by value. Values from every project are masked, not only this one's.

**Known formats** become `«redacted:<kind>»`:
- PEM private keys and JWTs
- Anthropic (`sk-ant-`), OpenAI (`sk-`, `sk-proj-`), GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), GitLab (`glpat-`) and npm (`npm_`) tokens
- Stripe (`sk_live_`, `sk_test_`, `rk_`, `whsec_`), Slack (`xox[abprs]-`), AWS (`AKIA`, `ASIA`), Google (`AIza`), Hugging Face (`hf_`), SendGrid (`SG.…`) and `ndv_` tokens
- the token of an `Authorization: Bearer` header, a Basic-auth `user:password`, and the password in a URL (`scheme://user:pass@host`)

**Assignment lines** whose key says `SECRET`, `TOKEN`, `KEY`, `PASSWORD`, `PASS`, `PEPPER`, `PRIVATE` or
`CREDENTIAL` mask their value only when it looks real: 12+ characters, letters and digits, high entropy.
Example values (`changeme`, `xxx…`, `<…>`, `your-…`, `…example…`), references (`${VAR}`, `process.env.X`),
dotted identifiers and word-like names (`user_profile_v2_cache`) are left alone. So are the assignments in
files read as examples by name (`.env.example`, `*.sample`, `*.template`, `*.dist`).

If the masking hook fails or overruns its time, its fallback still masks the vault values last read (kept
in memory) and every known format.

## What is not covered

- **The system prompt and first-message context**: CLAUDE.md, memory, git status, MCP server instructions,
  other plugins' sections. They are not masked, so keep secrets out of them.
- **Loaded transcripts**: `--resume`, a teleport, a subagent's saved transcript. A load is not an append.
- **Rows already in context** before a value was added to the vault, or before nanoflow loaded. Run
  `/compact` or `/clear` after adding a secret that Claude has already seen.
- **Images, screenshots and PDFs**: media blocks cannot be rewritten, so a key visible in a screenshot goes
  through.
- **Transformed values** beyond the forms listed above: split, spaced, re-encoded, encrypted or partially
  printed values. That is the accident-vs-attack limit above.
- **The transcript file on disk**: `~/.claude/projects/*.jsonl` stores the structured tool result
  (`toolUseResult`) and attachment payloads as made, unmasked. So do the screen and remote views of a tool
  row. Only the model's copy is masked.
- **Hooks beneath**: other plugins' `tool.call` hooks registered beneath nanoflow, settings `PreToolUse`
  hooks and the permission dialog see the **filled** command. A "don't ask again" rule may record it.
- **Unusual token formats** that none of the patterns above know.
- **`command.run`** masks every slash command's arguments, so a command that legitimately takes a
  credential receives the placeholder instead.

## Limits of the vault itself

- **Local plaintext**, like a `.env` file: a JSON file in Claude Code's configuration directory (the
  plugin's `$.store`), readable by your user account and not `chmod 600`-ed by nanoflow. An agent with
  file access could read or edit that file directly. An OS keychain backend may come later.
- **The value field shows what you type** on your own screen, because the pane's input has no password
  mode. **Copy** puts the value in clipboard history (and OSC 52 in terminals that support it). **Reveal**
  shows it on every surface attached to the session.
- Writes are serialized within a session and re-read the store before each write. Two sessions writing at
  the same moment can still lose one change.
