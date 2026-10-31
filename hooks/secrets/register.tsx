// Secrets: values the person keeps in nanoflow's vault and the model never reads. The model writes
// {{secret:NAME}}; tool.call fills it in as the tool runs, only for the commands and hosts the person allowed
// for that secret (one simple command), quoted for the shell, and into files only when the person allowed
// that too (git-ignored ones, unless tracked ones as well). The policy in force is never wider than what the
// person set in the pane this session (held by the host, out of any tool's reach). What the model reads is masked on
// its way into the conversation (session.append), as are injected attachments and outgoing messages; a
// token pasted into a prompt is vaulted as PASTED_<n> first. A guard against accidents, not against a
// hostile agent: see docs/secrets.md. Wired from ../register, LAST, so its tool.call hook is the innermost
// of nanoflow's and nanoflow's own feed sees the placeholder.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { NfSecret, NfSecretScope, NfTone } from '../../types'
import {
  allValues, checkName, disallowedUse, effectiveEntries, firstProgram, importReport, isExampleFile, isInside, isStagingFile, NEVER_ALLOWED, normalizePath, sourceLabel, NO_POLICY, narrowPolicy, nextPastedName, parseAllow,
  parseEnv, parseVaultStore, placeholderNames, policiesOf, policyOf, redact, redactContent, SECTION_ID, sectionText, substitute, trustKey,
  trustKeyIn, valuesOf, VAULT_KEY, widenedBy, withoutConfigFiles, writesMarkAsValue, type Entry, type Policy, type Shell, type VaultStore,
} from './redact'
import { SecretsView, type SecretsHandlers } from './view'

type $ = EngineInterface

export const SECRETS_PANE = 'nanoflow-secrets'
export const SECRETS_COMMAND = 'secrets'
export const REVEAL_MS = 10_000
export const IMPORT_TOOL = 'secrets_import'
/** The import tool as the model calls it. */
export const IMPORT_TOOL_ID = `mcp__nanoflow__${IMPORT_TOOL}`

const IMPORT_SPEC = {
  name: IMPORT_TOOL,
  description:
    "Imports a .env file (KEY=VALUE lines) into nanoflow's secrets vault without you seeing the values: nanoflow reads the file itself and answers with the names and lengths only. The file must be inside this project (stage it as .secrets/.env). Imported secrets are allowed nowhere until the user allows them in /secrets; a name already in the vault is skipped. The file must be git-ignored. A file under .secrets/ is deleted once stored, unless deleteAfter is false; no other file is ever deleted.",
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The .env file, absolute or relative to the working directory, e.g. .secrets/.env' },
      scope: { type: 'string', enum: ['project', 'global'], description: 'project (default): this project only; global: every project' },
      deleteAfter: { type: 'boolean', description: 'false keeps a .secrets/ staging file after import (it is deleted by default); files elsewhere are never deleted' },
    },
    required: ['path'],
    additionalProperties: false,
  },
}

/** The tools whose input may carry a placeholder, the fields filled in, and the shell that reads them. */
export const FILLED: Readonly<Record<string, { fields: readonly string[]; shell: Shell }>> = {
  Bash: { fields: ['command'], shell: 'bash' },
  PowerShell: { fields: ['command'], shell: 'powershell' },
  Write: { fields: ['content'], shell: 'raw' },
  Edit: { fields: ['old_string', 'new_string'], shell: 'raw' },
}

/** The fields of a file write that must never carry a «redacted:…» mark. */
const WRITTEN: Readonly<Record<string, readonly string[]>> = { Write: ['content'], Edit: ['new_string'], NotebookEdit: ['new_source'] }

/**
 * Commands and paths that reach nanoflow's store file (where each secret's policy is kept) or the
 * secretsAllowTrackedWrites setting. A heuristic first line; the trusted policy below is what holds.
 */
const touchesSecretsConfig = (tool: string, input: Readonly<Record<string, unknown>>): boolean => {
  const str = (field: string): string => (typeof input[field] === 'string' ? input[field] : '')
  const storeRe = /plugins[\\/]+store|cc-plugin-nanoflow/i
  const settingsRe = /pluginConfigs|secretsAllowTrackedWrites/
  const command = str('command')
  if (command) return storeRe.test(command) || (/plugins/i.test(command) && /\bstore\b/i.test(command)) || (/settings(?:\.local)?\.json/i.test(command) && settingsRe.test(command))
  const paths = ['file_path', 'path', 'notebook_path'].map(str).filter(Boolean)
  if (paths.some(p => storeRe.test(p))) return true
  if (paths.some(p => /settings(?:\.local)?\.json$/i.test(p)) && (WRITTEN[tool] ?? []).some(f => settingsRe.test(str(f)))) return true
  return false
}

/** Config files that can send an allowed program's request elsewhere: a URL, a proxy, a remote rewrite, a host alias. */
const PROGRAM_CONFIG_RE =
  /(?:^|[\\/\s'"=:])(?:\.curlrc|_curlrc|\.wgetrc|\.netrc|_netrc|\.npmrc|\.gitconfig)\b|\.ssh[\\/]+config\b|\.git[\\/]+config\b|\.config[\\/]+git[\\/]+config\b/i
/** `git config` setting a key that redirects a remote or runs a command (`url.<x>.insteadOf`, `core.sshCommand`…). */
const GIT_CONFIG_RE =
  /\bgit(?:\.exe)?(?:\s+-[Cc]\s+\S+|\s+--(?:git-dir|work-tree)\s+\S+|\s+-\S+)*\s+config\b.*(?:insteadof|sshcommand|proxy|askpass|credential\.|hookspath|alias\.|include)/i

/**
 * Commands and file writes that change a config file curl, wget, ssh, git or npm read: an earlier write there
 * could send a later allowed call to another host (filled-in curl and wget also get `-q` / `--no-config`).
 */
const touchesProgramConfig = (tool: string, input: Readonly<Record<string, unknown>>): boolean => {
  const command = typeof input.command === 'string' ? input.command : ''
  if (command) return PROGRAM_CONFIG_RE.test(command) || GIT_CONFIG_RE.test(command)
  if (!WRITTEN[tool]) return false
  return ['file_path', 'notebook_path'].some(field => typeof input[field] === 'string' && PROGRAM_CONFIG_RE.test(input[field]))
}

const listAtom = atom({ plugin: 'nanoflow', key: 'secrets' } as const, [])
const projectAtom = atom({ plugin: 'nanoflow', key: 'secretsProject' } as const, { root: null, cwd: '' })
const revealAtom = atom({ plugin: 'nanoflow', key: 'secretsReveal' } as const, null)
const confirmAtom = atom({ plugin: 'nanoflow', key: 'secretsConfirm' } as const, null)
const renameAtom = atom({ plugin: 'nanoflow', key: 'secretsRename' } as const, null)
const noteAtom = atom({ plugin: 'nanoflow', key: 'secretsNote' } as const, null)
const formAtom = atom({ plugin: 'nanoflow', key: 'secretsForm' } as const, 0)
const draftAtom = atom({ plugin: 'nanoflow', key: 'secretsDraft' } as const, '')
const addScopeAtom = atom({ plugin: 'nanoflow', key: 'secretsAddScope' } as const, 'project')
const pastedAtom = atom({ plugin: 'nanoflow', key: 'secretsPasted' } as const, null)
const trustedAtom = atom({ plugin: 'nanoflow', key: 'secretsTrusted' } as const, null)

/**
 * Module memory, reset by a reload: the last vault values read (so a hook that overran still masks them),
 * the tool calls that read an example file (their assignment lines are left alone), and the write queue.
 */
const M = {
  lastValues: [] as Array<[string, string]>,
  exampleIds: new Set<string>(),
  writing: Promise.resolve() as Promise<unknown>,
  /** The user's setting: every secret may be written into tracked files. */
  allowTrackedWrites: false,
}

/** The vault's size, for the status line (nanoflow redraws it on every poll). */
export async function secretCount($: $): Promise<number> {
  return (await read($, listAtom)).length
}

// ─── the vault ───────────────────────────────────────────────────────────────────────────────────

const idOf = (scope: NfSecretScope, name: string): string => `${scope === 'project' ? 'p' : 'g'}-${name}`
const fromId = (id: string): { scope: NfSecretScope; name: string } => ({ scope: id.startsWith('p-') ? 'project' : 'global', name: id.slice(2) })

async function projectRoot($: $): Promise<string | null> {
  return (await read($, projectAtom)).root
}

async function readStore($: $): Promise<VaultStore> {
  const store = parseVaultStore(await $.store.get(VAULT_KEY))
  M.lastValues = allValues(store, await projectRoot($))
  return store
}

/** The store for masking and filling in: never throws, so a store that cannot be read still leaves the patterns. */
async function storeOrEmpty($: $): Promise<VaultStore> {
  try {
    return await readStore($)
  } catch {
    return { global: {}, projects: {} }
  }
}

/** The values to mask with: all of the store's, or (when it cannot be read) the ones last read. */
async function maskValues($: $): Promise<Array<[string, string]>> {
  try {
    return allValues(await readStore($), await projectRoot($))
  } catch {
    return M.lastValues
  }
}

/**
 * The policies the user set in the pane, by trust key: held by the host for the session (no tool call can
 * write it). On the session's first read it starts as the store's policies as they stand.
 */
async function trustedPolicies($: $, store: VaultStore): Promise<Record<string, Policy>> {
  const held = await read($, trustedAtom)
  if (held) return held
  const baseline = policiesOf(store)
  // Nothing to trust yet (an empty or unreadable store): the first one read with entries becomes the baseline.
  if (Object.keys(baseline).length === 0) return baseline
  await update($, trustedAtom, current => current ?? baseline)
  return (await read($, trustedAtom)) ?? baseline
}

/** A secret's policy in force: the store's, no wider than the trusted one; and what the store adds beyond it. */
async function policyInForce($: $, store: VaultStore, root: string | null, name: string): Promise<{ policy: Policy; changed: string[] }> {
  const entry = effectiveEntries(store, root)[name]
  if (!entry) return { policy: NO_POLICY, changed: [] }
  const trusted = (await trustedPolicies($, store))[trustKeyIn(store, root, name)]
  return { policy: narrowPolicy(policyOf(entry), trusted), changed: widenedBy(policyOf(entry), trusted) }
}

async function publish($: $, store: VaultStore): Promise<void> {
  const root = await projectRoot($)
  const trusted = await trustedPolicies($, store)
  const row = (scope: NfSecretScope) => ([name, e]: [string, Entry]): NfSecret => {
    const t = trusted[trustKey(scope, root, name)]
    const p = narrowPolicy(policyOf(e), t)
    return {
      id: idOf(scope, name), name, scope, length: e.value.length, allow: p.allow, allowTracked: p.allowTracked, allowFiles: p.allowFiles,
      changed: widenedBy(policyOf(e), t),
      source: sourceLabel(e.source),
    }
  }
  const list = [
    ...(root ? Object.entries(store.projects[root] ?? {}).sort().map(row('project')) : []),
    ...Object.entries(store.global).sort().map(row('global')),
  ]
  await update($, listAtom, () => list)
}

/** The entries of one scope, created on demand. */
const scopeOf = (store: VaultStore, scope: NfSecretScope, root: string | null): Record<string, Entry> => {
  if (scope === 'global' || !root) return store.global
  store.projects[root] ??= {}
  return store.projects[root]
}

/**
 * Changes the vault: one change at a time in this session, each re-reading the store right before it writes
 * (another session may have written meanwhile). The one place the vault is written, and with the pane's
 * changes, the one place the trusted policies change.
 */
async function changeStore(
  $: $,
  change: (store: VaultStore, root: string | null, trusted: Record<string, Policy>) => void,
): Promise<VaultStore> {
  const run = M.writing.then(async () => {
    const store = await readStore($)
    const root = await projectRoot($)
    const trusted = structuredClone(await trustedPolicies($, store))
    change(store, root, trusted)
    await $.store.set(VAULT_KEY, store)
    await update($, trustedAtom, () => trusted)
    M.lastValues = allValues(store, root)
    await publish($, store)
    return store
  })
  M.writing = run.catch(() => undefined)
  return run
}

function note($: $, text: string, tone: NfTone = 'info') {
  return update($, noteAtom, () => ({ text, tone }))
}

/** Masks the secrets in a person's text; a token, a context secret or a cue-word value the vault lacks is stored as PASTED_<n>. */
async function vaultPasted($: $, text: string): Promise<{ text: string; stored: string[] } | null> {
  const values = await maskValues($)
  const store = await storeOrEmpty($)
  const root = await projectRoot($)
  const byValue = new Map(values.map(([name, value]) => [value, name]))
  const taken = Object.keys(effectiveEntries(store, root))
  const added: Record<string, string> = {}
  const result = redact(text, values, {
    // The person's own words: context finds and a bare value after a cue word are vaulted too.
    person: true,
    onUnknown: value => {
      const known = byValue.get(value)
      if (known) return known
      const name = nextPastedName([...taken, ...Object.keys(added)])
      added[name] = value
      byValue.set(value, name)
      return name
    },
  })
  if (result.hits.length === 0) return null
  const stored = Object.keys(added)
  if (stored.length) {
    const scope: NfSecretScope = root ? 'project' : 'global'
    await changeStore($, (s, r) => {
      const entries = scopeOf(s, scope, r)
      for (const [name, value] of Object.entries(added)) entries[name] = { value, allow: [] }
    })
    await update($, pastedAtom, () => ({ names: stored, scope }))
    $.ui.toast(`🔐 Stored as ${stored.join(', ')} — rename, allow or undo in /secrets`)
  }
  return { text: result.text, stored }
}

async function undoPasted($: $): Promise<string> {
  const pasted = await read($, pastedAtom)
  if (!pasted) return 'Nothing to undo.'
  await changeStore($, (s, r) => {
    const entries = scopeOf(s, pasted.scope, r)
    for (const name of pasted.names) delete entries[name]
  })
  await update($, pastedAtom, () => null)
  const text = pasted.from ? `↩ Undid the import from ${pasted.from}: removed ${pasted.names.join(', ')}.` : `↩ Removed ${pasted.names.join(', ')} from the vault.`
  await note($, text, 'success')
  return text
}

async function resolvePath($: $, raw: string): Promise<string> {
  const path = raw.trim().replace(/^["']|["']$/g, '')
  if (path.startsWith('~')) {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    return `${home.replace(/\\/g, '/')}${path.slice(1)}`
  }
  const { cwd } = await read($, projectAtom)
  if (/^([A-Za-z]:)?[\\/]/.test(path) || !cwd) return path
  return `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/${path}`
}

const dirOf = (path: string): string => path.replace(/\\/g, '/').replace(/\/[^/]*$/, '') || '/'

/**
 * Whether git ignores `path` and does not track it (or it is in no repository, so nothing commits it). A file
 * git tracks counts as tracked even when an ignore rule lists it: the next commit still takes it.
 */
async function isIgnored($: $, path: string): Promise<boolean> {
  try {
    const opts = { cwd: dirOf(path), timeoutMs: 10_000 }
    const tracked = await $.process.run(['git', 'ls-files', '--error-unmatch', '--', path], opts)
    if (tracked.exitCode === 0) return false
    if (tracked.exitCode === 128 && /not a git repository/i.test(tracked.stderr)) return true
    const { exitCode } = await $.process.run(['git', 'check-ignore', '-q', '--no-index', '--', path], opts)
    return exitCode === 0
  } catch {
    return false
  }
}

/** What git says about `path`, run in `dir` (a folder that exists): tracked, ignored, neither, in no repository, or unknown. */
async function gitState($: $, path: string, dir: string): Promise<'tracked' | 'ignored' | 'untracked' | 'no-repo' | 'unknown'> {
  try {
    const opts = { cwd: dir, timeoutMs: 10_000 }
    const tracked = await $.process.run(['git', 'ls-files', '--error-unmatch', '--', path], opts)
    if (tracked.exitCode === 0) return 'tracked'
    if (tracked.exitCode === 128 && /not a git repository/i.test(tracked.stderr)) return 'no-repo'
    if (tracked.exitCode !== 1) return 'unknown'
    const ignored = await $.process.run(['git', 'check-ignore', '-q', '--no-index', '--', path], opts)
    return ignored.exitCode === 0 ? 'ignored' : ignored.exitCode === 1 ? 'untracked' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Deletes an ignored file through git (which never removes a tracked one); whether it is gone. */
async function deleteUntracked($: $, path: string, dir: string): Promise<boolean> {
  try {
    await $.process.run(['git', 'clean', '-f', '-x', '-q', '--', path], { cwd: dir, timeoutMs: 10_000 })
    return !(await $.fs.exists(path))
  } catch {
    return false
  }
}

/** Where a path really lands (every link followed), or null when it leads nowhere. */
async function realPathOf($: $, path: string): Promise<string | null> {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => null)
  return stat?.realPath ? normalizePath(stat.realPath) : null
}

/** The path as the person and the model know it: relative to the session's folder when inside it. */
const shownPath = (path: string, cwd: string): string => (cwd && isInside(path, [cwd]) ? path.slice(normalizePath(cwd).length + 1) : path)

/**
 * The secrets_import tool: reads a git-ignored .env file inside the project (its real path, links followed),
 * stores each value under a name the session does not have yet (allowed nowhere), deletes a .secrets/ staging
 * file, and answers with names and lengths. Neither the answer nor a refusal ever holds a value.
 */
async function importForAgent($: $, input: Readonly<Record<string, unknown>>): Promise<{ result: string } | { deny: string }> {
  const raw = typeof input.path === 'string' ? input.path.trim() : ''
  if (!raw) return { deny: `${IMPORT_TOOL} needs the path of a .env file, e.g. .secrets/.env.` }
  const { root, cwd } = await read($, projectAtom)
  const path = normalizePath(await resolvePath($, raw))
  const shown = shownPath(path, cwd)
  const outside = { deny: `${IMPORT_TOOL} refused: ${shown} is outside this project. Stage the file inside it, as a git-ignored .secrets/.env.` }
  const folders = [root, cwd].filter((r): r is string => Boolean(r)).map(normalizePath)
  if (!isInside(path, folders)) return outside
  // A link inside the project can point anywhere: what counts is where it lands.
  const real = await realPathOf($, path)
  if (real === null) return { deny: `${IMPORT_TOOL}: could not read ${shown}.` }
  const realFolders = (await Promise.all(folders.map(async f => ({ f, real: await realPathOf($, f) })))).filter(x => x.real !== null && isInside(real, [x.real]))
  const home = realFolders[0]
  if (!home) return outside
  const state = await gitState($, real, home.f)
  if (state === 'tracked') return { deny: `${IMPORT_TOOL} refused: git tracks ${shown}, so its values may already be committed. Ask the user to rotate them and import a file git ignores, such as .secrets/.env.` }
  if (state === 'untracked') return { deny: `${IMPORT_TOOL} refused: git does not ignore ${shown}, so the next commit could take it. Add it (or .secrets/) to .gitignore first.` }
  if (state === 'unknown') return { deny: `${IMPORT_TOOL}: could not ask git whether ${shown} is tracked; try again, or ask the user to import it in /secrets.` }
  const text = await $.fs.read(real).catch(() => null)
  if (text === null) return { deny: `${IMPORT_TOOL}: could not read ${shown}.` }
  // A name given twice keeps its last value, as a shell reading the file would.
  const entries = [...new Map(parseEnv(text).map(e => [e.name, e] as const)).values()]
  if (entries.length === 0) return { deny: `${IMPORT_TOOL}: no KEY=VALUE lines in ${shown}.` }
  const scope: NfSecretScope = input.scope === 'global' || !root ? 'global' : 'project'
  const at = await $.clock.now()
  const imported: typeof entries = []
  const skipped: string[] = []
  await changeStore($, (s, r) => {
    // Any name this session already resolves is skipped: a project entry would hide an all-projects one.
    const taken = effectiveEntries(s, r)
    const target = scopeOf(s, scope, r)
    for (const e of entries) {
      if (taken[e.name] !== undefined || target[e.name] !== undefined) skipped.push(e.name)
      else {
        target[e.name] = { value: e.value, allow: [], source: { kind: 'agent-import', path: shown, at } }
        imported.push(e)
      }
    }
  })
  // Only a staging file under .secrets/ is ever deleted; deleteAfter: false keeps it.
  const wantDelete = isStagingFile(real) && input.deleteAfter !== false
  const deleted = !wantDelete ? null : skipped.length ? 'kept' : (await deleteUntracked($, real, home.f)) ? 'deleted' : 'failed'
  const names = imported.map(e => e.name)
  if (names.length) {
    await update($, pastedAtom, () => ({ names, scope, from: shown }))
    await update($, formAtom, n => n + 1)
    await note($, `📥 Claude imported ${names.join(', ')} from ${shown}. Allow what each is for, or undo.`, 'warning')
    $.ui.toast(`🔐 Claude imported ${names.join(', ')} from ${shown} — allow or undo in /secrets`)
  }
  return { result: importReport({ imported, skipped, scope, shown, deleted }) }
}

/** The trust key of the pane row `id` in a session in `root`. */
const trustKeyOf = (id: string, root: string | null): string => {
  const { scope, name } = fromId(id)
  return trustKey(scope, root, name)
}

const handlers = ($: $): SecretsHandlers => ({
  copy: (id, surface) => {
    void (async () => {
      const { scope, name } = fromId(id)
      const value = scopeOf(await readStore($), scope, await projectRoot($))[name]?.value
      if (value === undefined) return void (await note($, `${name} is no longer in the vault.`, 'error'))
      const copied = await $.ui.copy({ text: value, surface: surface as never })
      await note($, copied.isCopied ? `📋 Copied ${name}` : `Could not copy ${name} (${copied.reason ?? 'no clipboard'})`, copied.isCopied ? 'success' : 'error')
    })()
  },
  reveal: id => {
    void (async () => {
      const at = await $.clock.now()
      await update($, revealAtom, () => ({ id, at }))
      $.clock.after(REVEAL_MS, () => void update($, revealAtom, shown => (shown?.id === id && shown.at === at ? null : shown)))
    })()
  },
  hide: () => void update($, revealAtom, () => null),
  askDelete: id => void update($, confirmAtom, () => id),
  cancel: () => void update($, confirmAtom, () => null),
  confirmDelete: id => {
    void (async () => {
      const { scope, name } = fromId(id)
      await changeStore($, (s, r, trusted) => {
        delete scopeOf(s, scope, r)[name]
        delete trusted[trustKeyOf(id, r)]
      })
      await update($, confirmAtom, () => null)
      await update($, revealAtom, shown => (shown?.id === id ? null : shown))
      await note($, `🗑 Deleted ${name}`, 'success')
    })()
  },
  startRename: id => void update($, renameAtom, current => (current === id ? null : id)),
  rename: (id, to) => {
    void (async () => {
      const checked = checkName(to)
      if ('error' in checked) return void (await note($, checked.error, 'error'))
      const { scope, name: from } = fromId(id)
      const name = checked.name
      if (name !== from && scopeOf(await readStore($), scope, await projectRoot($))[name] !== undefined) return void (await note($, `${name} already exists.`, 'error'))
      await changeStore($, (s, r, trusted) => {
        const entries = scopeOf(s, scope, r)
        const entry = entries[from]
        if (!entry) return
        delete entries[from]
        entries[name] = entry
        const [fromKey, toKey] = [trustKey(scope, r, from), trustKey(scope, r, name)]
        if (trusted[fromKey]) trusted[toKey] = trusted[fromKey]
        else delete trusted[toKey]
        delete trusted[fromKey]
      })
      await update($, renameAtom, () => null)
      await note($, `✏️ Renamed ${from} to ${name}`, 'success')
    })()
  },
  allow: (id, text) => {
    void (async () => {
      const parsed = parseAllow(text)
      const refused = parsed.filter(item => NEVER_ALLOWED.has(item))
      const items = parsed.filter(item => !NEVER_ALLOWED.has(item))
      const why = refused.length ? `${refused.join(', ')} can't be allowed: ${refused.length === 1 ? 'it runs' : 'they run'} other programs or code, so the secret could go anywhere.` : ''
      if (items.length === 0) return void (why && (await note($, why, 'error')))
      const { scope, name } = fromId(id)
      await changeStore($, (s, r, trusted) => {
        const entry = scopeOf(s, scope, r)[name]
        if (!entry) return
        entry.allow = [...new Set([...entry.allow, ...items])]
        const key = trustKeyOf(id, r)
        const t = trusted[key] ?? NO_POLICY
        trusted[key] = { ...t, allow: [...new Set([...t.allow, ...items])] }
      })
      await update($, formAtom, n => n + 1)
      await note($, `✅ ${name} may now be used with ${items.join(', ')}${why ? `. ${why}` : ''}`, why ? 'warning' : 'success')
    })()
  },
  unallow: (id, item) => {
    void (async () => {
      const { scope, name } = fromId(id)
      await changeStore($, (s, r, trusted) => {
        const entry = scopeOf(s, scope, r)[name]
        if (entry) entry.allow = entry.allow.filter(a => a !== item)
        const key = trustKeyOf(id, r)
        if (trusted[key]) trusted[key] = { ...trusted[key], allow: trusted[key].allow.filter(a => a !== item) }
      })
    })()
  },
  draftName: raw => {
    void (async () => {
      const checked = checkName(raw)
      // A value pasted into the Name field is never kept, not even as a draft.
      if ('error' in checked && checked.error.startsWith('That looks like a secret value')) {
        await update($, draftAtom, () => '')
        return void (await note($, checked.error, 'error'))
      }
      await update($, draftAtom, () => raw)
    })()
  },
  add: value => {
    void (async () => {
      const checked = checkName(await read($, draftAtom))
      if ('error' in checked) return void (await note($, `Type a name first. ${checked.error}`, 'error'))
      if (!value) return void (await note($, 'The value is empty.', 'error'))
      const scope = await read($, addScopeAtom)
      await changeStore($, (s, r) => {
        const entries = scopeOf(s, scope, r)
        entries[checked.name] = { ...withoutSource(entries[checked.name]), value }
      })
      await forgetImported($, [checked.name])
      await update($, draftAtom, () => '')
      await update($, formAtom, n => n + 1)
      await note($, `🔐 Saved ${checked.name}. Allow the commands or hosts it is for, below its name.`, 'success')
    })()
  },
  setAddScope: scope => void update($, addScopeAtom, () => scope),
  importEnv: raw => {
    void (async () => {
      if (!raw.trim()) return
      const path = await resolvePath($, raw)
      const text = await $.fs.read(path).catch(() => null)
      if (text === null) return void (await note($, `Could not read ${path}.`, 'error'))
      const entries = parseEnv(text)
      if (entries.length === 0) return void (await note($, `No KEY=VALUE lines in ${path}.`, 'warning'))
      const scope = await read($, addScopeAtom)
      await changeStore($, (s, r) => {
        const target = scopeOf(s, scope, r)
        for (const e of entries) target[e.name] = { ...withoutSource(target[e.name]), value: e.value }
      })
      await forgetImported($, entries.map(e => e.name))
      await update($, formAtom, n => n + 1)
      await note($, `📥 Imported ${entries.length} from ${path}: ${entries.map(e => e.name).join(', ')}`, 'success')
    })()
  },
  undoPasted: () => void undoPasted($),
  toggleFiles: id => {
    void (async () => {
      const now = await toggleFlag($, id, 'allowFiles')
      const name = fromId(id).name
      await note($, now ? `📄 ${name} may now be written into git-ignored files (.env).` : `📄 ${name} is no longer written into files.`, now ? 'warning' : 'success')
    })()
  },
  toggleTracked: id => {
    void (async () => {
      const now = await toggleFlag($, id, 'allowTracked')
      const name = fromId(id).name
      await note($, now ? `📝 ${name} may now be written into files git tracks.` : `📝 ${name} is written only into git-ignored files again.`, now ? 'warning' : 'success')
    })()
  },
  acceptChange: id => {
    void (async () => {
      const { scope, name } = fromId(id)
      await changeStore($, (s, r, trusted) => {
        const entry = scopeOf(s, scope, r)[name]
        if (entry) trusted[trustKeyOf(id, r)] = policyOf(entry)
      })
      await note($, `✅ ${name}: the change made outside this pane is now in force.`, 'warning')
    })()
  },
  revertChange: id => {
    void (async () => {
      const { scope, name } = fromId(id)
      await changeStore($, (s, r, trusted) => {
        const entry = scopeOf(s, scope, r)[name]
        if (!entry) return
        const p = narrowPolicy(policyOf(entry), trusted[trustKeyOf(id, r)])
        entry.allow = p.allow
        setFlag(entry, 'allowTracked', p.allowTracked)
        setFlag(entry, 'allowFiles', p.allowFiles)
      })
      await note($, `↩ ${name}: the change made outside this pane is undone.`, 'success')
    })()
  },
})

/** An entry's policy without its source: a value the person saves in the pane is theirs. */
const withoutSource = (entry: Entry | undefined): Omit<Entry, 'value'> => {
  const { source: _source, value: _value, ...rest } = entry ?? { value: '', allow: [] }
  return rest
}

/** Takes names out of the pending undo once the person saved their own value under them. */
async function forgetImported($: $, names: readonly string[]): Promise<void> {
  await update($, pastedAtom, p => {
    if (!p) return p
    const left = p.names.filter(n => !names.includes(n))
    return left.length ? { ...p, names: left } : null
  })
}

const setFlag = (entry: Entry, flag: 'allowTracked' | 'allowFiles', on: boolean): void => {
  if (on) entry[flag] = true
  else delete entry[flag]
}

/** Flips a file permission from what is in force, in the store and in the trusted policy; answers the new state. */
async function toggleFlag($: $, id: string, flag: 'allowTracked' | 'allowFiles'): Promise<boolean> {
  const { scope, name } = fromId(id)
  let now = false
  await changeStore($, (s, r, trusted) => {
    const entry = scopeOf(s, scope, r)[name]
    if (!entry) return
    const key = trustKeyOf(id, r)
    now = !narrowPolicy(policyOf(entry), trusted[key])[flag]
    setFlag(entry, flag, now)
    trusted[key] = { ...(trusted[key] ?? NO_POLICY), [flag]: now }
  })
  return now
}

/** Call from the module's one `session.start` hook, after `next`: finds the project, registers /secrets. */
export async function startSecrets($: $, cwd: string): Promise<void> {
  let root: string | null = cwd ? cwd.replace(/\\/g, '/') : null
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeoutMs: 10_000 })
    // The main checkout's .git: every worktree of a repository shares its secrets.
    if (exitCode === 0 && stdout.trim()) root = stdout.trim().replace(/\\/g, '/').replace(/\/\.git\/?$/, '')
  } catch {
    // Not a git repository: the folder itself is the project.
  }
  await update($, projectAtom, () => ({ root, cwd }))
  await update($, revealAtom, () => null)
  if (!root) await update($, addScopeAtom, () => 'global')
  await $.command.register({
    name: SECRETS_COMMAND,
    description: 'nanoflow secrets: store, allow, copy and reveal secrets Claude uses without seeing them',
    argumentHint: '[undo]',
  })
  // The import tool is extra: a host that cannot register it still gets the vault.
  await $.tool.register(IMPORT_SPEC).catch(() => undefined)
  await publish($, await storeOrEmpty($))
}

export type SecretsOptions = {
  /** The user's `secretsAllowTrackedWrites` setting: every secret may be written into tracked files. */
  allowTrackedWrites: boolean
}

export const registerSecrets = (on: On, options: SecretsOptions): void => {
  M.allowTrackedWrites = options.allowTrackedWrites
  // ─── command, pane ─────────────────────────────────────────────────────────────────────────────

  on('command.run', { command: SECRETS_COMMAND }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'undo') return { text: await undoPasted($) }
    await update($, noteAtom, () => null)
    await publish($, await storeOrEmpty($))
    const opened = await $.ui.open({ id: SECRETS_PANE, title: 'Secrets', focus: true })
    if (!opened.isPlaced) return { text: `Secrets: the pane is open but not shown: ${opened.reason}` }
    return { text: 'Secrets pane opened.' }
  }).catch(() => ({ text: 'Secrets: that failed; run `claude --debug` for the reason.' }))

  on('ui.render', { component: 'Pane', requestId: SECRETS_PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const root = await projectRoot($)
    const shown = await read($, revealAtom)
    // A reveal outlives its timer across a reload: past its time it is drawn hidden.
    const fresh = shown && (await $.clock.now()) - shown.at < REVEAL_MS ? shown : null
    let value: string | undefined
    if (fresh) {
      const { scope, name } = fromId(fresh.id)
      value = scopeOf(parseVaultStore(await $.store.get(VAULT_KEY)), scope, root)[name]?.value
    }
    const pasted = await read($, pastedAtom)
    return SecretsView(el, {
      secrets: await read($, listAtom),
      root,
      revealed: fresh && value !== undefined ? { id: fresh.id, value } : null,
      confirm: await read($, confirmAtom),
      renaming: await read($, renameAtom),
      note: await read($, noteAtom),
      form: await read($, formAtom),
      addScope: root ? await read($, addScopeAtom) : 'global',
      pasted: pasted?.names ?? [],
      pastedFrom: pasted?.from ?? null,
      trackedForAll: M.allowTrackedWrites,
    }, handlers($))
  })

  // ─── Claude imports a .env file: the plugin reads it, the model gets the names ──────────────────

  on('tool.call', { tool: IMPORT_TOOL_ID }, ($, e) => importForAgent($, e as unknown as Record<string, unknown>))
    .catch(() => ({ deny: `${IMPORT_TOOL} failed; nothing was read back. Ask the user to import the file in /secrets.` }))

  // ─── the model's instructions: the names, never a value ─────────────────────────────────────────

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const names = Object.keys(effectiveEntries(await storeOrEmpty($), await projectRoot($))).sort()
    return { sections: [...composed.sections.filter(s => s.id !== SECTION_ID), { id: SECTION_ID, text: sectionText(names), scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  // ─── reads of example files keep their assignment lines (they hold no real secrets) ───────────────

  on('tool.call', { tool: 'Read' }, ($, e, next) => {
    if (isExampleFile(e.file_path)) M.exampleIds.add(e.tool_use_id)
    return next(e)
  }).catch(($, e, next) => next(e))

  // ─── the store and the settings that hold each secret's policy are the user's, changed in the pane ──

  on('tool.call', { tool: ['Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit', 'Read', 'Glob', 'Grep'] }, ($, e, next) => {
    const tool = String(e.tool)
    if (touchesSecretsConfig(tool, e as unknown as Record<string, unknown>)) {
      return { deny: `${tool} refused: this reaches nanoflow's secrets store or its settings, where each secret's value and policy are kept. Only the user changes those, in /secrets.` }
    }
    if (touchesProgramConfig(tool, e as unknown as Record<string, unknown>)) {
      return { deny: `${tool} refused: this changes or names a config file of curl, wget, ssh, git or npm (.curlrc, .wgetrc, .netrc, .npmrc, .gitconfig, .git/config, .ssh/config), which can send a request that uses a secret to another host. Ask the user to make that change.` }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'nanoflow secrets could not check this call; try again.' }))

  // ─── in: a placeholder filled in as the tool runs, only where the person allowed it ─────────────

  on('tool.call', { tool: ['Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit'] }, async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const text = (field: string): string => (typeof input[field] === 'string' ? input[field] : '')
    if ((WRITTEN[tool] ?? []).some(field => writesMarkAsValue(text(field), text('file_path') || text('notebook_path')))) {
      return { deny: `${tool} refused: the new content puts a «redacted:…» mark where a value goes; it stands for a secret value you never saw; writing it would replace the real value in the file. Leave that line as it is (edit around it), or ask the user to change it.` }
    }
    const spec = FILLED[tool]
    if (!spec || !spec.fields.some(field => text(field).includes('{{secret:'))) return next(e)
    const used = [...new Set(spec.fields.flatMap(field => placeholderNames(text(field))))]
    const isFile = spec.shell === 'raw'
    const target = isFile ? text('file_path') : text('command')
    const store = await storeOrEmpty($)
    const root = await projectRoot($)
    if (used.length > 0) {
      const entries = effectiveEntries(store, root)
      const missing = used.filter(name => entries[name] === undefined)
      if (missing.length) {
        const one = missing.length === 1
        return { deny: `secret ${missing.join(', ')} ${one ? "isn't" : "aren't"} in the vault; ask the user to add ${one ? 'it' : 'them'} with /secrets` }
      }
      // The policy in force: what the user set in the pane, even if the store file now says more.
      const policies: Policy[] = []
      for (const name of used) {
        const { policy, changed } = await policyInForce($, store, root, name)
        const blocked = isFile
          ? policy.allowFiles ? null : "isn't allowed in files; the user can allow writing it into git-ignored files in /secrets"
          : disallowedUse(policy.allow, target, spec.shell === 'powershell' ? 'powershell' : 'bash')
        if (blocked) {
          if (changed.length) {
            // The pane shows the change, to accept or undo.
            await publish($, store)
            $.ui.toast(`⚠ ${name}'s policy was changed outside /secrets; review it there`)
          }
          const why = changed.length ? ' (its policy in the store was widened outside the Secrets pane; that change is not used until the user accepts it in /secrets)' : ''
          return { deny: `secret ${name} ${blocked}${why}` }
        }
        policies.push(policy)
      }
      // Into a git-ignored file only, unless the user allowed tracked files for each secret used (or for all).
      const mayTrack = M.allowTrackedWrites || policies.every(p => p.allowTracked)
      if (isFile && !mayTrack && !(await isIgnored($, target))) {
        return { deny: `${tool} refused: won't write a real secret into a tracked file (${target} is not ignored by git); the user can allow this in /secrets. Otherwise write it to a git-ignored file such as .env, or, to write the placeholder text itself, escape it as \\{{secret:NAME}}.` }
      }
    }
    const vault = valuesOf(effectiveEntries(store, root))
    const filled: Record<string, unknown> = { ...input }
    for (const field of spec.fields) {
      if (typeof input[field] !== 'string') continue
      // A command that gets a value reads no config file (~/.curlrc, ~/.wgetrc could add a URL or a proxy).
      const source = spec.shell !== 'raw' && used.length > 0 ? withoutConfigFiles(input[field], spec.shell) : input[field]
      const out = substitute(source, vault, spec.shell)
      if (out.refused) return { deny: `${tool} refused: a secret is filled into one simple command only, and this one has ${out.refused}` }
      filled[field] = out.text
    }
    if (used.length > 0) {
      const where = isFile ? (target.split(/[\\/]/).pop() ?? target) : (firstProgram(target) ?? tool)
      $.ui.toast(`🔐 Used ${used.join(', ')} in ${where}`)
    }
    return next(filled as unknown as typeof e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'nanoflow secrets could not check this call; try again.' }))

  // ─── out: what the model reads is masked before it is kept ───────────────────────────────────────

  // session.append is where the rows of a running conversation enter it (tool results of every tool and
  // subagent loop, deliveries, hook context, compaction), and what it keeps is what the model is sent. The
  // screen's record of a tool result is stored as made. See docs/secrets.md for what it does not cover.
  on('session.append', async ($, e, next) => {
    const masked = redactContent(e.message.content, await maskValues($), M.exampleIds)
    return next(masked ? { ...e, message: { ...e.message, content: masked.content } } : e)
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // The hook failed or overran: mask with the values last read, and every known format.
    const masked = redactContent(e.message.content, M.lastValues, M.exampleIds)
    return next(masked ? { ...e, message: { ...e.message, content: masked.content } } : e)
  })

  // What the engine injects per request (a mentioned file, a changed file's diff, a hook's context).
  on('prompt.attachment', async ($, e, next) => {
    const injected = await next(e)
    if (!injected.text) return injected
    const masked = redact(injected.text, await maskValues($))
    return masked.hits.length ? { text: masked.text } : injected
  }).catch(async ($, e, next) => {
    const injected = await next(e)
    return injected.text ? { text: redact(injected.text, M.lastValues).text } : injected
  })

  // A message leaving for another agent or session.
  on('session.send', async ($, e, next) => {
    const masked = redact(e.text, await maskValues($))
    return next(masked.hits.length ? { ...e, text: masked.text } : e)
  }).catch(($, e, next) => (next.called ? next(e) : next({ ...e, text: redact(e.text, M.lastValues).text })))

  // ─── the person's own words: a pasted token is vaulted before the model reads it ─────────────────

  on('prompt.submit', async ($, e, next) => {
    // A slash command's line is masked at command.run; a hidden prompt that starts a turn takes no rewrite.
    if (e.command || (e.isMeta && !e.turnId)) return next(e)
    const masked = await vaultPasted($, e.text)
    return next(masked ? { ...e, text: masked.text } : e)
  }).catch(($, e, next) => {
    if (next.called || e.command || (e.isMeta && !e.turnId)) return next(e)
    return next({ ...e, text: redact(e.text, M.lastValues, { person: true }).text })
  })

  // Every command's arguments (a known limit: a command that takes a credential gets the placeholder).
  on('command.run', async ($, e, next) => {
    if (!e.args || e.command === SECRETS_COMMAND) return next(e)
    const masked = await vaultPasted($, e.args)
    return next(masked ? { ...e, args: masked.text } : e)
  }).catch(($, e, next) => (next.called ? next(e) : next({ ...e, args: redact(e.args, M.lastValues, { person: true }).text })))
}
