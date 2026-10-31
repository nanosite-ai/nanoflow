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
by its worktrees; the folder itself outside git) and **All projects**, then the add and import forms.

**A slim card per secret**: one line with its name, where it came from, its length (never a part of the
value) and a compact policy badge:

```
╭─
│ ▸ 🔐 PLATFORM_JWT_SECRET  imported by Claude from .secrets/.env · 2026-10-31  64 chars  🔒 nowhere
╰─
╭─
│ ▾ 🔐 STRIPE_KEY  added in pane · 2026-10-30  32 chars  ✓ curl, api.stripe.com +1  📄 files
│ [📋 Copy] [👁 Reveal] [✏️ Rename] [🗑 Delete]
│ ▸ ⚙ Options
╰─
```

| Badge | Means |
|---|---|
| `🔒 nowhere` | Allowed with no command or host yet: Claude cannot use it. |
| `✓ curl, api.stripe.com +1` | The commands and hosts it may be used with (the first two, then how many more). |
| `📄 files` · `📝 tracked` | It may be written into git-ignored files; into files git tracks too. |
| `⚠ changed` | The store file allows more than you set here (see *Who changes a policy*). |

**Where it came from**: *imported by Claude from `<path>`* (the `secrets_import` tool), *imported from
`<path>`* (the pane's import), *pasted · auto-vaulted* (stored from a prompt on its own), *added in pane*,
each with its date. A secret stored before nanoflow kept this says *source unknown*.

**What needs a look is summed up once, at the top**: *⚠ 2 secrets are allowed nowhere · 1 policy changed
outside the pane*, with **[ review ]** to open the first one with its options. Rows carry only the badge; the explanation is in
the card's options.

**Press a name to open its card** (one at a time; press again to close). An open card shows **📋 Copy** ·
**👁 Reveal** (10 s) · **✏️ Rename** · **🗑 Delete** (asks first), and *⚠ Changed outside this pane* with
**accept** (puts the store's wider policy in force) and **undo** (writes your policy back) when that
happened. What the secret may be used with stays folded under **▸ ⚙ Options** until you press it:

| Under ⚙ Options | What it does |
|---|---|
| **Allow** | The commands and hosts this secret may be used with, e.g. `kubectl, npm, api.example.com`; each allowed item has a ✕ to remove it. **A new secret is allowed nowhere**, and the details say so until you allow something. Shells, interpreters and wrappers (`sh`, `bash`, `pwsh`, `cmd`, `node`, `python`, `env`, `xargs`, `sudo`, `iex`…) can never be allowed: they would run anything. |
| **📄 Files** | Off by default: the secret is never written into a file. Turn it on to let a Write or Edit fill it into git-ignored files (such as `.env`). |
| **📝 Tracked files** | Shown once Files is on. Off by default: the secret is written only into git-ignored files. Turn it on to allow writing it into files git tracks. |

**The forms come after the list, folded** (open on an empty vault):

| Form | What it does |
|---|---|
| **▸ ➕ Add a secret** | Pick *This project* or *All projects*, type a name (`STRIPE_SECRET_KEY`), then the value and Enter. Both fields clear after a save, and the saved secret's card opens; allow its uses under ⚙ Options. If you paste a token into the Name field, it is refused and never kept. |
| **▸ 📥 Import a .env file** | Takes a path (absolute, `~/…`, or relative to the session's folder) and saves where *Add* is set to. Every `KEY=VALUE` is stored, including multi-line quoted values such as PEM keys. Only the names are shown. |

**↩ Undo** shows at the top after a prompt stored a secret on its own, or after Claude imported a file;
it removes those secrets. `/secrets undo` does the same.

The status line shows `🔐 <count>` when the vault has entries.

**In a prompt**, ask by name: *"deploy with STRIPE_SECRET_KEY"*. Claude writes
`{{secret:STRIPE_SECRET_KEY}}` in the command, and each use raises a toast: *Used STRIPE_SECRET_KEY in curl*.

**Writing the placeholder literally** (docs, templates): escape it with a backslash. `\{{secret:NAME}}` is
written as `{{secret:NAME}}` and uses no secret.

**If you paste a secret into a prompt** (or a command's arguments), it is stored as `PASTED_<n>` before
Claude reads it, and Claude gets `{{secret:PASTED_n}}` in its place. A toast says *Stored as PASTED_1 —
rename, allow or undo in /secrets*. That covers:

- a known token format (see below);
- a `Bearer` header, a URL password, Basic auth, or a `PASSWORD=…` line;
- a bare random value right after a cue word: *"the staging db password is x7Gq…"*, *"use this token …"*,
  *"api key: …"*. The cue words are password, passphrase, passcode, pass, pw, pwd, token, secret, key, api
  key and credential, with up to four plain words in between. The value must look random (12+ characters,
  letters and digits); a git SHA, a UUID, a URL, a path, an ordinary word or a code identifier (`refreshOAuth2Token`) is left as typed. A rare random value that reads like an identifier is missed: paste such a secret with its name (`ADMIN_PASSWORD=…`) or add it in /secrets.

A value already in the vault is replaced by its own name. Like any stored secret, a pasted one is allowed
nowhere until you allow it. Text you paste is part of the prompt, so it is covered the same way; pasted
images and documents are not text and are not scanned. In what Claude reads from tools, a bare value after a
cue word is left alone (it may not be yours to store), and context finds are masked but never stored.

**Claude can import a `.env` file for you**, without seeing the values. Ask it to stage the secrets in a
git-ignored `.secrets/.env` inside the project, then it calls the `secrets_import` tool with that path.
nanoflow reads and parses the file itself, and Claude gets back the names and lengths only. The rules:

- The file must be inside the project (the main checkout or the session's worktree), where it really lands
  (a symlink to `~/.aws/credentials` is outside), and **git-ignored**. A tracked or merely untracked file, a
  path outside the project (a temp folder, `../..`) and a missing file are refused.
- Imported secrets go to *This project* (or `scope: "global"`), are **allowed nowhere**, and show
  *imported by Claude from .secrets/.env · <date>* on their row. A toast says so too.
- A name the session already has (in this project or all projects) is skipped: Claude never replaces or
  hides a value you stored. A name given twice in the file keeps its last value.
- Only a file under `.secrets/` is ever deleted, once stored (`deleteAfter: false` keeps it); it is kept if
  some names were skipped, so their values are not lost. Any other file (your own `.env`) is left alone.
- Saving your own value under an imported name in the pane makes it yours: it becomes *added in pane*, and undo leaves it.
- `/secrets undo` (or **↩ Undo** in the pane) removes what the last import stored.

## When a placeholder is filled in

| Tool | Filled into | Only when |
|---|---|---|
| Bash, PowerShell | `command` | The command is **one simple command**: no `;`, `&&`, `||`, `|`, `&`, newline, `$(…)`, backticks, `$VAR` or any `$`, redirection (`<`, `>`, `<<<`, heredocs), subshell, braces or script block (PowerShell's `@{ … }` hashtable is fine), comment or unclosed quote. Its **program** is run by name (not a path), is in the secret's Allow list, and is not a shell, interpreter or wrapper. It has no `VAR=value` prefix and no proxy, config or command option (`-x`, `--proxy*`, `--socks*`, `-K`/`--config`, `--resolve`, `--connect-to`, wget `-e`/`-i`, git `-c`/`--upload-pack`, ssh `-F`/`-J`/`ProxyCommand=`, PowerShell `-Proxy`), and no option that builds the URL out of sight (curl `--variable`, every `--expand-*`, `{{name}}` in any curl word, `--next`/`-:`). ssh settings are checked in every form (`-oKey=value`, `-o Key=value`, `-o "Key value"`): `ProxyCommand`, `ProxyJump`, `LocalCommand`, `PermitLocalCommand` and `RemoteCommand` are refused. PowerShell's `-Param:value` is read like `-Param value`. A filled-in curl gets `-q` as its first argument and wget `--no-config`, so `~/.curlrc` / `~/.wgetrc` cannot add a URL or a proxy. **Every word that names a host** is in the Allow list (a host covers its subdomains): a URL's host (after its last `@`), `user@host`, `host:port`, scp-style `host:path`, a bare `name.tld`, and IPv4/IPv6/decimal/hex addresses. A URL with a backslash where its host is read (`https://evil\@good`) is refused as ambiguous. Words after an option that takes a local file (`-o`, `-T`, `--cacert`, `-f`…) or starting with `@` are files, not hosts. The value is then quoted for the shell at that spot (bash `'…'` with `'\''`; inside `"…"` it escapes `\ " $` and backtick; PowerShell `'…'` with `''`, or backtick escapes inside `"…"`), so `$`, quotes, backticks and newlines stay data. |
| Write, Edit | `content`, `old_string`, `new_string` | The secret is allowed in **📄 Files**, and the target is **git-ignored and untracked** (`git ls-files --error-unmatch` fails and `git check-ignore` matches; a committed `.env` that `.gitignore` lists later still counts as tracked) or outside any repository, unless the user allowed tracked files for that secret or set `secretsAllowTrackedWrites`. |

Anything else is denied with a message the model can act on:

- *secret NAME isn't in the vault; ask the user to add it with /secrets*
- *secret NAME isn't allowed for curl; the user can allow it in /secrets* (or the host it lacks)
- *secret NAME is filled into one simple command only, and this one has a chain or pipe (&&)…*
- *secret NAME is never filled into bash: it runs other programs or code*
- *secret NAME isn't filled into a command with --proxy: …*
- *secret NAME isn't allowed in files; the user can allow writing it into git-ignored files in /secrets*
- *won't write a real secret into a tracked file (…); the user can allow this in /secrets*

### Who changes a policy

Each secret's Allow list, Files and Tracked files toggles are kept in the store, a plain JSON file an agent
with file access could edit. So the store is not what nanoflow trusts:

- **The policy in force is never wider than what you set in the pane.** When a session first reads the
  store, it remembers each secret's policy as it stands, in state the host holds for the session (no tool
  call can write it). Your changes in the pane update both. A policy the store widened anywhere else (an
  Allow item added, Files or Tracked files turned on) is not used: the call is denied, a toast says so,
  and the pane shows *⚠ Changed outside this pane* with **accept** and **undo**. Narrowing always applies.
- **Tool calls that reach the store or the setting are refused**: Bash, PowerShell, Read, Write, Edit,
  NotebookEdit, Glob and Grep naming `plugins/store`, the store file's name, or (for a `settings.json`)
  `pluginConfigs` / `secretsAllowTrackedWrites`. This is a heuristic first line; the trusted policy above is
  what holds.
- **Tool calls that change the config of an allowed program are refused**: a Write/Edit/NotebookEdit to, or a
  Bash/PowerShell command naming, `.curlrc`, `_curlrc`, `.wgetrc`, `.netrc`, `_netrc`, `.npmrc`, `.gitconfig`,
  `.git/config`, `~/.config/git/config` or `.ssh/config`, and a `git config` that sets a redirecting or
  command key (`insteadOf`, `sshCommand`, `proxy`, `askpass`, `credential.*`, `hooksPath`, `alias.*`,
  `include`). An earlier write there could otherwise send a later allowed call elsewhere.
- `secretsAllowTrackedWrites` (plugin config, off by default) is read when nanoflow loads. Your settings
  files are yours to guard.

A **Write, Edit or NotebookEdit that puts a `«redacted:…»` mark where a value goes** (after `=` or `:`, or
opening a quoted string) is refused: that is a masked line being written back, and it would replace the
real value. Text that only mentions the mark (prose, a code comment) is written, and so is any Markdown or
plain-text file (`.md`, `.mdx`, `.markdown`, `.txt`, `.rst`), which holds docs, not configuration.

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
dotted identifiers, word-like names (`user_profile_v2_cache`), URLs and paths (`https://…`, `/etc/…`,
`./…`, `C:\…`) are left alone, as are keys that name something about a secret rather than the secret
(`KEY_ID`, `apiKeyName`, `tokenUrl`, `keyPath`, `passwordField`) and lookup keys (`storageKey`, `cacheKey`).
So are the assignments in files read as examples by name (`.env.example`, `*.sample`, `*.template`, `*.dist`).

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
- **Single-label hosts**: `curl intranet-box -d …` names a host only your network resolves; a word without
  a dot is not read as a host (except `user@box` and, for scp, rsync, sftp, ssh and git, `box:path`).
- **Allowed programs that run project code**: git hooks and remotes from `.git/config`, npm lifecycle
  scripts, a Makefile. A secret allowed for `git` or `npm` reaches whatever code the repository gives them.
  Allow such programs only for secrets that need them.
- **False denials**: a file name passed where no known file option precedes it (`scp dump.sql …`) or a
  four-part version number (`1.2.3.4`) reads as a host. Fail closed; allow the host or write it differently.
- **`command.run`** masks every slash command's arguments, so a command that legitimately takes a
  credential receives the placeholder instead.

## Limits of the vault itself

- **Local plaintext**, like a `.env` file: a JSON file in Claude Code's configuration directory (the
  plugin's `$.store`), readable by your user account and not `chmod 600`-ed by nanoflow. An agent with
  file access could read that file directly (the guard above refuses the obvious ways). A policy it widens
  in a session that never loaded nanoflow, or before a session's first read of the store, becomes that
  session's starting point. An OS keychain backend may come later.
- **The value field shows what you type** on your own screen, because the pane's input has no password
  mode. **Copy** puts the value in clipboard history (and OSC 52 in terminals that support it). **Reveal**
  shows it on every surface attached to the session.
- Writes are serialized within a session and re-read the store before each write. Two sessions writing at
  the same moment can still lose one change.
