// Secrets: the pure part. The vault's shape, names, placeholders and shell quoting, which programs and hosts a
// command reaches, the .env parser, and the redaction that keeps secret values out of what the model reads.
// No `$` here, so all of it is unit-tested directly.
//
// What this protects against: ACCIDENTAL exposure (a value echoed in output, a key in a file the model reads,
// a token pasted into a prompt). It does not stop a deliberately hostile or prompt-injected model, which can
// always transform a value in a way no masking anticipates. See docs/secrets.md.

// ─── the vault ───────────────────────────────────────────────────────────────────────────────────

/**
 * One secret: its value, the commands and hosts it may be used with (nothing until the user allows), whether
 * it may be written into files at all (git-ignored ones), and into files git tracks too (both off by
 * default). Only the pane sets these, and a change made anywhere else is not trusted (see `narrowPolicy`).
 */
export type Entry = { value: string; allow: string[]; allowTracked?: true; allowFiles?: true; source?: Source }
/** Where a secret came from, for the pane: imported by Claude from a file (its path), when. */
export type Source = { kind: 'agent-import'; path: string; at: number }
export type Scope = 'project' | 'global'
/** What `$.store` holds under VAULT_KEY: secrets for every project (by root folder) and for all projects. */
export type VaultStore = { global: Record<string, Entry>; projects: Record<string, Record<string, Entry>> }
/** A flat name → value view, as substitution and masking read it. */
export type Vault = Readonly<Record<string, string>>

export const VAULT_KEY = 'secrets.vault'
export const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/
export const PASTED_PREFIX = 'PASTED_'
/** The placeholder, or escaped with a backslash in front to mean the literal text. */
export const PLACEHOLDER_RE = /(\\?)\{\{secret:([A-Za-z0-9_]{1,64})\}\}/g
/** Vault values shorter than this are not masked by value (too many false hits); patterns still apply. */
export const MIN_VALUE_LENGTH = 6
export const REDACTED_MARK = '«redacted:'
const PLACEHOLDER_HEAD = '{{secret:'

export const placeholder = (name: string): string => `${PLACEHOLDER_HEAD}${name}}}`
export const redactedMark = (kind: string): string => `${REDACTED_MARK}${kind}»`

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

const sourceOf = (raw: unknown): Source | null =>
  isRecord(raw) && raw.kind === 'agent-import' && typeof raw.path === 'string' && typeof raw.at === 'number' ? { kind: 'agent-import', path: raw.path, at: raw.at } : null

/** The pane's label for where a secret came from, or null when the store does not say. */
export const sourceLabel = (source: Source | undefined): string | null =>
  source ? `imported by Claude from ${source.path} · ${new Date(source.at).toISOString().slice(0, 10)}` : null

const entriesOf = (raw: unknown): Record<string, Entry> => {
  if (!isRecord(raw)) return {}
  const out: Record<string, Entry> = {}
  for (const [name, v] of Object.entries(raw)) {
    if (!isValidName(name)) continue
    // The first shape (never released) was name → value.
    if (typeof v === 'string') out[name] = { value: v, allow: [] }
    else if (isRecord(v) && typeof v.value === 'string') {
      out[name] = {
        value: v.value,
        allow: Array.isArray(v.allow) ? v.allow.filter((a): a is string => typeof a === 'string') : [],
        ...(v.allowTracked === true ? { allowTracked: true as const } : {}),
        ...(v.allowFiles === true ? { allowFiles: true as const } : {}),
        ...(sourceOf(v.source) ? { source: sourceOf(v.source)! } : {}),
      }
    }
  }
  return out
}

/** Reads whatever the store holds into the current shape. */
export const parseVaultStore = (raw: unknown): VaultStore => {
  if (!isRecord(raw)) return { global: {}, projects: {} }
  if (!('global' in raw) && !('projects' in raw)) return { global: entriesOf(raw), projects: {} }
  const projects: Record<string, Record<string, Entry>> = {}
  if (isRecord(raw.projects)) for (const [root, entries] of Object.entries(raw.projects)) projects[root] = entriesOf(entries)
  return { global: entriesOf(raw.global), projects }
}

/** The secrets a session in `root` may use: all-projects ones, overridden by the project's own. */
export const effectiveEntries = (store: VaultStore, root: string | null): Record<string, Entry> => ({
  ...store.global,
  ...(root ? (store.projects[root] ?? {}) : {}),
})

export const valuesOf = (entries: Readonly<Record<string, Entry>>): Record<string, string> =>
  Object.fromEntries(Object.entries(entries).map(([name, e]) => [name, e.value]))

/** Every value in the store as [name, value], for masking (another project's value is masked too). */
export const allValues = (store: VaultStore, root: string | null): Array<[string, string]> => {
  const pairs: Array<[string, string]> = []
  for (const [other, entries] of Object.entries(store.projects)) if (other !== root) for (const [n, e] of Object.entries(entries)) pairs.push([n, e.value])
  for (const [n, e] of Object.entries(store.global)) pairs.push([n, e.value])
  if (root) for (const [n, e] of Object.entries(store.projects[root] ?? {})) pairs.push([n, e.value])
  // A value held twice keeps the last name: the session's own project's.
  return [...new Map(pairs.map(([n, v]) => [v, n])).entries()].map(([v, n]) => [n, v])
}

// ─── policy: what the user allowed, and what the store says ──────────────────────────────────────

/** What a secret may be used for: its Allow list, files, tracked files. */
export type Policy = { allow: string[]; allowTracked: boolean; allowFiles: boolean }

export const NO_POLICY: Policy = { allow: [], allowTracked: false, allowFiles: false }

export const policyOf = (e: Entry): Policy => ({ allow: [...e.allow], allowTracked: e.allowTracked === true, allowFiles: e.allowFiles === true })

/** The key a secret's trusted policy is kept under: its scope, project and name. */
export const trustKey = (scope: Scope, root: string | null, name: string): string => (scope === 'global' || !root ? `g:${name}` : `p:${root}:${name}`)

/** The trust key of the entry `name` resolves to in a session in `root` (the project's own wins). */
export const trustKeyIn = (store: VaultStore, root: string | null, name: string): string =>
  trustKey(root && store.projects[root]?.[name] ? 'project' : 'global', root, name)

/** Every entry's policy by trust key: what a session trusts when it first reads the store. */
export const policiesOf = (store: VaultStore): Record<string, Policy> => {
  const out: Record<string, Policy> = {}
  for (const [name, e] of Object.entries(store.global)) out[trustKey('global', null, name)] = policyOf(e)
  for (const [root, entries] of Object.entries(store.projects)) for (const [name, e] of Object.entries(entries)) out[trustKey('project', root, name)] = policyOf(e)
  return out
}

/**
 * The policy in force: the store's, but no wider than what the user set in the pane (`trusted`, kept by the
 * host for the session, which no tool call can write). The store is a plain file an agent could edit.
 */
export const narrowPolicy = (stored: Policy, trusted: Policy | undefined): Policy => {
  const t = trusted ?? NO_POLICY
  return { allow: stored.allow.filter(a => t.allow.includes(a)), allowTracked: stored.allowTracked && t.allowTracked, allowFiles: stored.allowFiles && t.allowFiles }
}

/** What the store allows beyond `trusted`: changes made outside the pane, for the pane to show. */
export const widenedBy = (stored: Policy, trusted: Policy | undefined): string[] => {
  const t = trusted ?? NO_POLICY
  return [
    ...stored.allow.filter(a => !t.allow.includes(a)),
    ...(stored.allowFiles && !t.allowFiles ? ['files'] : []),
    ...(stored.allowTracked && !t.allowTracked ? ['tracked files'] : []),
  ]
}

// ─── names ───────────────────────────────────────────────────────────────────────────────────────

export const isValidName = (name: string): boolean => NAME_RE.test(name)

/** Uppercase, non-name characters to `_`; null when nothing usable is left. */
export const normalizeName = (raw: string): string | null => {
  const name = raw.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 64)
  return isValidName(name) ? name : null
}

/** Bits of entropy per character. */
export const entropy = (text: string): number => {
  if (!text) return 0
  const counts = new Map<string, number>()
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let bits = 0
  for (const n of counts.values()) {
    const p = n / text.length
    bits -= p * Math.log2(p)
  }
  return bits
}

// ─── patterns ────────────────────────────────────────────────────────────────────────────────────

/**
 * A known secret format. The whole match is the secret, unless the regex has a named group `s`: then only
 * that part is, and the groups `pre` / `post` around it are kept. `high` formats are unambiguous tokens (a
 * pasted one is vaulted); `context` ones are masked but never vaulted.
 */
export type SecretPattern = { kind: string; re: RegExp; confidence: 'high' | 'context' }

export const PATTERNS: readonly SecretPattern[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, confidence: 'high' },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, confidence: 'high' },
  { kind: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, confidence: 'high' },
  { kind: 'openai', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, confidence: 'high' },
  { kind: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g, confidence: 'high' },
  { kind: 'gitlab', re: /\bglpat-[A-Za-z0-9_-]{20,}/g, confidence: 'high' },
  { kind: 'npm', re: /\bnpm_[A-Za-z0-9]{30,}/g, confidence: 'high' },
  { kind: 'stripe', re: /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|rk_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{20,})/g, confidence: 'high' },
  { kind: 'slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, confidence: 'high' },
  { kind: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, confidence: 'high' },
  { kind: 'google', re: /\bAIza[0-9A-Za-z_-]{35}/g, confidence: 'high' },
  { kind: 'huggingface', re: /\bhf_[A-Za-z0-9]{30,}/g, confidence: 'high' },
  { kind: 'sendgrid', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, confidence: 'high' },
  { kind: 'ndv', re: /\bndv_[A-Za-z0-9_-]{16,}/g, confidence: 'high' },
  { kind: 'bearer', re: /(?<pre>\bAuthorization:\s*Bearer\s+)(?<s>[A-Za-z0-9._~+/=-]{16,})/gi, confidence: 'context' },
  { kind: 'basic-auth', re: /(?<pre>\bBasic\s+)(?<s>[A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/g, confidence: 'context' },
  { kind: 'url-password', re: /(?<pre>\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"`]{1,128}:)(?<s>[^\s@/'"`]{1,256})(?<post>@)/gi, confidence: 'context' },
]

const matchesPattern = (text: string): boolean => PATTERNS.some(p => new RegExp(p.re.source, p.re.flags.replace('g', '')).test(text))

/** Text typed as a NAME that is really a value: a known token format, or long and random. */
export const looksLikeValue = (raw: string): boolean => {
  const text = raw.trim()
  if (matchesPattern(text)) return true
  if (/[^A-Za-z0-9_\- ]/.test(text) && text.length >= 12) return true
  if (!/\d/.test(text) || !/[A-Za-z]/.test(text)) return false
  if (text.length >= 20 && entropy(text) >= 3.5) return true
  // A name has words between separators and one case; 16+ random characters without a separator are a value.
  const mixedCase = /[a-z]/.test(text) && /[A-Z]/.test(text)
  return text.length >= 16 && !/[_\- ]/.test(text) && entropy(text) >= (mixedCase ? 3.0 : 3.5)
}

/** A name for what the person typed, or why not (never echoing what they typed). */
export const checkName = (raw: string): { name: string } | { error: string } => {
  if (looksLikeValue(raw)) return { error: 'That looks like a secret value, not a name: paste it in Value, and give it a name like STRIPE_SECRET_KEY.' }
  const name = raw.trim().toUpperCase().replace(/[\s-]+/g, '_')
  return isValidName(name) ? { name } : { error: 'Names use A-Z, 0-9 and _, start with a letter, and are at most 64 characters.' }
}

/**
 * `NAME=value`, `NAME: "value"`, `"apiKey": "value"`: a key that says secret, then a value. Groups: 1 the key
 * with its separator (kept), 2 the bare key, 3 the quote, 4 the value (masked only when it looks like a real
 * secret). Bounded so a long run of word characters cannot backtrack for long. Never inside a placeholder.
 * The value is on the key's line or on an indented next one (YAML, pretty JSON); a next line that starts at
 * column 0 is not a value, so grep's `path:14:` prefix after `- secretRef:` is left alone (#39).
 */
const ASSIGNMENT_RE =
  /(?<!\{\{)(?<![A-Za-z0-9_])(([A-Za-z0-9_]{0,40}(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|PASS|PEPPER|PRIVATE|CREDENTIAL)[A-Za-z0-9_]{0,40})["']?[ \t]*[:=][ \t]*(?:\r?\n[ \t]+)?)(["']?)([^\s"'`,;)}\]]{1,512})\3/gi

const EXAMPLE_VALUE_RE =
  /^(?:\$|\{\{|«|<.*>$|\[.*\]$|\*+$|\.{3}|x{3,}|(?:your|my|some|insert|enter|replace)[-_]|.*(?:changeme|change_me|example|placeholder|dummy|sample|redacted|todo|fixme|secret_here|key_here))/i
const WORDY_RE = /^[A-Za-z]+(?:[-_.](?:[A-Za-z]+|\d+|[A-Za-z]{1,2}\d{1,3}))+$/

/**
 * Keys that name something about a secret, not the secret: `KEY_ID`, `apiKeyName`, `tokenUrl`, `keyPath`,
 * `passwordField`, a reference to one (`secretRef`, `secretKeyRef`), and keys that are lookup keys (`storageKey`, `cacheKey`).
 */
export const isNotSecretKey = (key: string): boolean =>
  /[_-](?:id|name|field|path|url|uri|file|type|header|param|label|prefix|ttl)$/i.test(key) ||
  /[a-z0-9](?:Id|ID|Name|Field|Path|Url|URL|Uri|File|Type|Header|Param|Label|Prefix|Ttl)$/.test(key) ||
  // Kubernetes' references to a Secret object by name; `tokenRef` and the like may hold a token.
  /^secret(?:Key)?Ref$/.test(key) ||
  /(?:storage|cache|sort|primary|foreign|partition|idempotency|query|i18n|translation|row|item|list|map|lookup|hot)[_-]?key$/i.test(key)

/** Whether an assignment's value is a real-looking secret: 12+ characters, random, letters and digits, no example, no URL or path. */
export const looksSecret = (value: string): boolean => {
  if (value.length < 12 || EXAMPLE_VALUE_RE.test(value) || WORDY_RE.test(value)) return false
  if (value.includes('://') || /^(?:\.{0,2}\/|~\/|[A-Za-z]:[\\/])/.test(value)) return false
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return false
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?$/.test(value)) return false
  return entropy(value) >= 3.0
}

/** Files whose secrets are examples by name (`.env.example`, `config.sample.json`, `x.template`). */
export const isExampleFile = (path: string): boolean => /\.(?:example|sample|template|dist)(?:\.[A-Za-z0-9]+)?$/i.test(path)

/**
 * Whether written text puts a mark where a value goes: after `=` or `:`, or opening a quoted string. That is
 * a masked line being written back, which would replace the real value. Text that only mentions the mark
 * (prose, a code comment) passes, and so does any Markdown or plain-text file.
 */
export const writesMarkAsValue = (text: string, path: string): boolean =>
  !/\.(?:md|mdx|markdown|txt|rst)$/i.test(path) && new RegExp(`(?:[=:][ \\t]*(?:\\r?\\n[ \\t]+)?["'\`]?|["'])${escapeRe(REDACTED_MARK)}`).test(text)

// ─── forms a vault value travels in ──────────────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export const utf8 = (text: string): number[] => {
  const out: number[] = []
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

export const base64Bytes = (bytes: readonly number[]): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i]!, bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (b === undefined ? '=' : B64[(n >> 6) & 63]!) + (c === undefined ? '=' : B64[n & 63]!)
  }
  return out
}

export const base64 = (text: string): string => base64Bytes(utf8(text))

const decodeBase64 = (text: string): string | null => {
  const clean = text.replace(/=+$/, '')
  if (/[^A-Za-z0-9+/]/.test(clean)) return null
  let bits = 0
  let acc = 0
  const bytes: number[] = []
  for (const ch of clean) {
    acc = ((acc << 6) | B64.indexOf(ch)) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 255)
    }
  }
  return String.fromCharCode(...bytes)
}

/**
 * The value's base64 at each of the three byte alignments it can sit at inside a longer base64 text, each
 * trimmed to the characters that depend on the value alone.
 */
export const base64Forms = (value: string): string[] => {
  const bytes = utf8(value)
  return [0, 1, 2].map(k => {
    const encoded = base64Bytes([...Array<number>(k).fill(0), ...bytes]).replace(/=+$/, '')
    const head = [0, 2, 3][k]!
    const tail = (k + bytes.length) % 3 === 0 ? 0 : 2
    return encoded.slice(head, encoded.length - tail)
  })
}

const hex = (text: string): string => utf8(text).map(b => b.toString(16).padStart(2, '0')).join('')

/** A form to look for, and whether case is ignored (upper/lower/mixed case of the value, hex). */
export type Form = { text: string; ignoreCase: boolean }

/** The value and the common ways a command turns it into other text. */
export const formsOf = (value: string): Form[] => {
  if (value.length < MIN_VALUE_LENGTH) return []
  const forms: Form[] = [
    { text: value, ignoreCase: true },
    { text: [...value].reverse().join(''), ignoreCase: true },
    { text: hex(value), ignoreCase: true },
    ...base64Forms(value).map(text => ({ text, ignoreCase: false })),
    { text: base64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), ignoreCase: false },
    { text: JSON.stringify(value).slice(1, -1), ignoreCase: false },
    { text: encodeURIComponent(value), ignoreCase: false },
  ]
  const seen = new Set<string>()
  return forms.filter(f => {
    const key = f.ignoreCase ? `i${f.text.toLowerCase()}` : `s${f.text}`
    if (f.text.length < MIN_VALUE_LENGTH || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ─── redaction ───────────────────────────────────────────────────────────────────────────────────

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export type Redaction = { text: string; hits: string[] }

/** Name → value, or [name, value] pairs (two scopes may hold the same name). */
export type Values = Vault | ReadonlyArray<readonly [string, string]>

const pairsOf = (values: Values): ReadonlyArray<readonly [string, string]> =>
  Array.isArray(values) ? (values as ReadonlyArray<readonly [string, string]>) : Object.entries(values as Vault)

export type RedactOptions = {
  /** Called for a high-confidence token the vault lacks: a name to store it under, or null to mask it. */
  onUnknown?: (value: string, kind: string) => string | null
  /** Leave assignment lines alone (an example file). */
  skipAssignments?: boolean
}

/**
 * Masks every secret in `text`: vault values (and their transforms) become their placeholder; known formats
 * and real-looking assignments become `«redacted:<kind>»`, or the placeholder of the name `onUnknown` gives a
 * high-confidence token. `hits` lists what was masked, by name or kind; it never holds a value.
 */
export const redact = (text: string, values: Values, options: RedactOptions = {}): Redaction => {
  const hits: string[] = []
  let out = text
  const forms = pairsOf(values)
    .flatMap(([name, value]) => formsOf(value).map(form => ({ name, form })))
    .sort((a, b) => b.form.text.length - a.form.text.length)
  for (const { name, form } of forms) {
    const found = form.ignoreCase ? out.toLowerCase().includes(form.text.toLowerCase()) : out.includes(form.text)
    if (!found) continue
    out = out.replace(new RegExp(escapeRe(form.text), form.ignoreCase ? 'gi' : 'g'), placeholder(name))
    hits.push(name)
  }
  const mask = (value: string, pattern: SecretPattern): string => {
    if (value.startsWith(PLACEHOLDER_HEAD) || value.startsWith(REDACTED_MARK)) return value
    const name = pattern.confidence === 'high' ? (options.onUnknown?.(value, pattern.kind) ?? null) : null
    hits.push(name ?? pattern.kind)
    return name ? placeholder(name) : redactedMark(pattern.kind)
  }
  for (const pattern of PATTERNS) {
    out = out.replace(pattern.re, (match: string, ...args: unknown[]) => {
      const groups = args.at(-1)
      if (!groups || typeof groups !== 'object') return mask(match, pattern)
      const g = groups as Record<string, string | undefined>
      if (g.s === undefined) return mask(match, pattern)
      if (pattern.kind === 'basic-auth' && !(decodeBase64(g.s) ?? '').includes(':')) return match
      if (pattern.kind === 'url-password' && (EXAMPLE_VALUE_RE.test(g.s) || g.s.length < 3)) return match
      return `${g.pre ?? ''}${mask(g.s, pattern)}${g.post ?? ''}`
    })
  }
  if (!options.skipAssignments) {
    out = out.replace(ASSIGNMENT_RE, (whole, key: string, bareKey: string, quote: string, value: string) => {
      if (!looksSecret(value) || isNotSecretKey(bareKey)) return whole
      hits.push('value')
      return `${key}${quote}${redactedMark('value')}${quote}`
    })
  }
  return { text: out, hits }
}

// ─── placeholders and filling them in ────────────────────────────────────────────────────────────

/** Every unescaped placeholder in `text`, by name, once each. */
export const placeholderNames = (text: string): string[] =>
  [...new Set([...text.matchAll(PLACEHOLDER_RE)].filter(m => !m[1]).map(m => m[2]!))]

export type Shell = 'bash' | 'powershell' | 'raw'
export type QuoteContext = 'none' | 'single' | 'double'

/** The value written so `shell` reads it back exactly, given the quotes the placeholder sits inside. */
export const quoteFor = (shell: Shell, inside: QuoteContext, value: string): string => {
  if (shell === 'raw') return value
  if (shell === 'bash') {
    if (inside === 'single') return value.replace(/'/g, `'\\''`)
    if (inside === 'double') return value.replace(/[\\"$`]/g, '\\$&')
    return `'${value.replace(/'/g, `'\\''`)}'`
  }
  if (inside === 'single') return value.replace(/'/g, "''")
  if (inside === 'double') return value.replace(/[`"$]/g, '`$&')
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Fills each placeholder in `text` with its value, quoted for `shell` at that spot (raw for file content);
 * an escaped one (a backslash in front) becomes the literal placeholder text. `missing` lists names with no value.
 * A command that fills a value in must be one simple command (`commandWords`), where the quote at each spot is
 * certain; otherwise nothing is filled in and `refused` says why (a comment, `$(…)`, a heredoc… could each
 * change how the value is read).
 */
export const substitute = (text: string, vault: Vault, shell: Shell = 'raw'): { text: string; missing: string[]; refused?: string } => {
  if (shell !== 'raw' && placeholderNames(text).length > 0) {
    const parsed = commandWords(text, shell)
    if ('error' in parsed) return { text, missing: [], refused: parsed.error }
  }
  const missing = new Set<string>()
  const re = new RegExp(PLACEHOLDER_RE.source, 'g')
  const escapeChar = shell === 'powershell' ? '`' : '\\'
  let out = ''
  let inside: QuoteContext = 'none'
  let i = 0
  for (;;) {
    re.lastIndex = i
    const m = re.exec(text)
    const end = m ? m.index : text.length
    // Track the shell's quoting over the plain text up to the next placeholder.
    for (let j = i; j < end; j += 1) {
      const ch = text[j]!
      out += ch
      if (shell === 'raw') continue
      if (ch === escapeChar && inside !== 'single' && j + 1 < end) {
        out += text[j + 1]
        j += 1
      } else if (ch === "'" && inside !== 'double') inside = inside === 'single' ? 'none' : 'single'
      else if (ch === '"' && inside !== 'single') inside = inside === 'double' ? 'none' : 'double'
    }
    if (!m) break
    const [whole, escaped, name] = [m[0], m[1], m[2]!]
    if (escaped) out += whole.slice(1)
    else if (vault[name] === undefined) {
      missing.add(name)
      out += whole
    } else out += quoteFor(shell, inside, vault[name])
    i = m.index + whole.length
  }
  return { text: out, missing: [...missing] }
}

// ─── where a command goes: one simple command, its program and the hosts it names ────────────────

const PROGRAM_PREFIXES = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup', '&', '.'])

const programName = (word: string): string => (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '')

/** The first program a command runs (after `VAR=value` assignments and wrappers), lowercased, no path or .exe. For a toast. */
export const firstProgram = (command: string): string | null => {
  const words = command.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  for (const raw of words) {
    const word = raw.replace(/^["']|["']$/g, '')
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || PROGRAM_PREFIXES.has(word)) continue
    return programName(word) || null
  }
  return null
}

/** Stand-ins for a placeholder while a command is read: a real one, and an escaped (literal) one. */
const FILL = '\u0001'
const LITERAL = '\u0002'

/**
 * The words of ONE simple command, quotes removed, or what makes it more than that (or unclear): a chain or
 * pipe, a substitution, a variable, a redirection, a subshell or script block, a comment, a newline, an
 * unclosed quote. A placeholder reads as one character. PowerShell's `@{ … }` hashtable is allowed.
 */
export const commandWords = (command: string, shell: 'bash' | 'powershell'): { words: string[] } | { error: string } => {
  const text = command.replace(new RegExp(PLACEHOLDER_RE.source, 'g'), (_m, escaped: string) => (escaped ? LITERAL : FILL)).trim()
  const escapeChar = shell === 'powershell' ? '`' : '\\'
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: '' | "'" | '"' = ''
  let hashtables = 0
  const end = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    const next = text[i + 1] ?? ''
    if (quote === "'") {
      if (ch !== "'") word += ch
      else if (shell === 'powershell' && next === "'") {
        word += "'"
        i += 1
      } else quote = ''
      continue
    }
    if (ch === '$') return { error: 'a variable or substitution ($…)' }
    if (ch === '`' && shell === 'bash') return { error: 'a backtick substitution' }
    if (quote === '"') {
      // In bash's double quotes a backslash escapes only $ ` " \ and a newline; before anything else it stays.
      const escapes = shell === 'powershell' ? next !== '' : '$`"\\\n'.includes(next) && next !== ''
      if ((ch === escapeChar && escapes) || (ch === '"' && shell === 'powershell' && next === '"')) {
        word += next
        i += 1
      } else if (ch === '"') quote = ''
      else word += ch
      continue
    }
    if (ch === '\n' || ch === '\r') return { error: 'more than one line' }
    if (ch === escapeChar) {
      if (!next || next === '\n' || next === '\r') return { error: 'a line continuation' }
      word += next
      inWord = true
      i += 1
    } else if (ch === ' ' || ch === '\t') end()
    else if (ch === "'" || ch === '"') {
      quote = ch
      inWord = true
    } else if (ch === ';' || ch === '&' || ch === '|') return { error: `a chain or pipe (${ch})` }
    else if (ch === '<' || ch === '>') return { error: `a redirection (${ch})` }
    else if (ch === '(' || ch === ')') return { error: 'a subshell or subexpression' }
    else if (ch === '#' && !inWord) return { error: 'a comment (#)' }
    else if (ch === '{' && shell === 'powershell' && word === '@') {
      hashtables += 1
      word += ch
      end()
    } else if (ch === '}' && hashtables > 0 && !inWord) {
      hashtables -= 1
      words.push('}')
    } else if (ch === '{' || ch === '}') return { error: shell === 'powershell' ? 'a script block ({…})' : 'braces ({…})' }
    else {
      word += ch
      inWord = true
    }
  }
  if (quote) return { error: 'an unclosed quote' }
  end()
  return { words }
}

/** Programs that run other programs or code: a secret is never filled into them, whatever the Allow list says. */
export const NEVER_ALLOWED: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash', 'busybox', 'pwsh', 'powershell', 'cmd', 'wsl', 'start',
  'node', 'nodejs', 'deno', 'bun', 'tsx', 'ts-node', 'npx', 'bunx', 'pnpx', 'python', 'python2', 'python3', 'py', 'pypy',
  'ruby', 'irb', 'perl', 'php', 'lua', 'osascript', 'cscript', 'wscript', 'mshta', 'rundll32',
  'env', 'xargs', 'sudo', 'doas', 'su', 'runas', 'exec', 'eval', 'command', 'builtin', 'source', '.', 'nohup', 'time',
  'timeout', 'watch', 'nice', 'stdbuf', 'setsid', 'chroot', 'script', 'expect', 'parallel', 'find', 'awk', 'gawk', 'sed',
  'iex', 'invoke-expression', 'invoke-command', 'icm', 'start-process', 'saps', 'start-job',
])

/**
 * Options that send a request through another host, run a command, read settings from a file, or build the
 * URL from something the command does not show (curl's `--variable` / `--expand-*`, and `--next`).
 */
const REFUSED_OPTION_RE = /^--?(?:proxy|socks|preproxy|config|resolve|connect-to|doh-url|execute|input-file|upload-pack|receive-pack|exec|variable|expand-|next\b)/i
/**
 * `ProxyCommand=…` and the like, in every form ssh takes them (`-oKey=value`, `-o Key=value`, `-o "Key value"`),
 * a wget `-e` setting, and `*_PROXY=` settings.
 */
const REFUSED_SETTING_RE = /^(?:-o)?\s*(?:\w*proxy\w*|localcommand|permitlocalcommand|remotecommand)(?:\s*=|\s)/i
/** Short options with the same effect, per program (`-x` proxy and `-K` config for curl, `-e`/`-i` for wget…). */
const REFUSED_SHORT: Readonly<Record<string, string>> = { curl: 'xK', wget: 'ei', git: 'c', ssh: 'FJ', scp: 'FJ', sftp: 'FJ' }
/** Options whose next word is a local file, per program: that word is not a host. */
const FILE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  curl: ['-o', '--output', '-T', '--upload-file', '--cacert', '--cert', '-E', '--key', '--capath', '--netrc-file', '-b', '--cookie', '-c', '--cookie-jar', '-D', '--dump-header', '--trace', '--trace-ascii', '--stderr', '--output-dir'],
  wget: ['-O', '--output-document', '-o', '--output-file', '-a', '--append-output', '-P', '--directory-prefix', '--load-cookies', '--save-cookies', '--ca-certificate', '--certificate', '--private-key'],
  kubectl: ['-f', '--filename', '--kubeconfig'],
  'invoke-webrequest': ['-outfile', '-infile'],
  'invoke-restmethod': ['-outfile', '-infile'],
}
/** Programs where `name:path` names a host even without a dot (scp-style). */
const REMOTE_PATH_PROGRAMS: ReadonlySet<string> = new Set(['scp', 'rsync', 'sftp', 'ssh', 'git'])

const AMBIGUOUS = '\u0000ambiguous'
const HOST_RE = /^(?:(?:[a-z0-9_-]+\.)+[a-z][a-z0-9-]{1,62}\.?|localhost|(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){1,3}|\d{8,10}|0x[0-9a-f]{8}|\[[0-9a-f:.]+\])$/i

/** The host a word names, as a program would read it: a URL's, `user@host`, `host:port`, a bare host or IP. */
const hostOf = (raw: string, program: string): string | null => {
  const word = raw.trimStart().split(/\s/)[0] ?? ''
  if (/^[a-z][\w+.-]*::/i.test(word)) return AMBIGUOUS
  const url = /^([a-z][a-z0-9+.-]+):([\\/]+)([^/?#]*)/i.exec(word)
  if (url) {
    // A backslash where the host is read (`https://evil\@good`, `https:\\evil`) is read differently by each program.
    if (url[2] !== '//' || url[3]!.includes('\\')) return AMBIGUOUS
    const hostPort = url[3]!.slice(url[3]!.lastIndexOf('@') + 1)
    const host = hostPort.startsWith('[') ? hostPort.slice(0, hostPort.indexOf(']') + 1) : hostPort.replace(/:[^:]*$/, '')
    return host ? host.toLowerCase() : null
  }
  if (word.includes('\\')) return /^[a-z]:\\/i.test(word) ? null : AMBIGUOUS
  const afterAt = word.includes('@') ? word.slice(word.lastIndexOf('@') + 1) : null
  const candidate = (afterAt ?? word).split('/')[0]!
  if (/^[a-z]:$/i.test(candidate)) return null
  const name = candidate.startsWith('[') ? candidate.slice(0, candidate.indexOf(']') + 1) : candidate.replace(/:.*$/, '')
  if (HOST_RE.test(name)) return name.toLowerCase()
  // `user@box`, or `box:path` for a program that copies to remote paths: a host without a dot.
  if (/^[\w-]+$/.test(name) && (afterAt !== null || (candidate.includes(':') && REMOTE_PATH_PROGRAMS.has(program)))) return name.toLowerCase()
  return null
}

/** An allow item is a host when it has a dot or a colon, a command otherwise. */
export const isHostItem = (item: string): boolean => /[.:]/.test(item)

/** What the person typed in a secret's Allow field: lowercase, no scheme or path, deduplicated. */
export const parseAllow = (text: string): string[] =>
  [...new Set(text.split(/[\s,]+/).map(s => s.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '')).filter(Boolean))]

const hostAllowed = (host: string, hosts: readonly string[]): boolean => {
  const h = host.replace(/\.$/, '')
  return hosts.some(item => {
    const allowed = item.startsWith('[') ? item.slice(0, item.indexOf(']') + 1) : item.replace(/:\d+$/, '')
    return h === allowed || h.endsWith(`.${allowed}`)
  })
}

const shown = (text: string): string => text.replace(new RegExp(`[${FILL}${LITERAL}]`, 'g'), '…')

/**
 * Why a secret with this Allow list may not be filled into `command`, as the rest of a sentence that starts
 * with "secret NAME"; null when it may. Fails closed: one simple command only, run by name by a program on
 * the list (never a shell, interpreter or wrapper), no environment assignments, no proxy or config options,
 * and every host any word names is on the list (a host item covers its subdomains).
 */
export const disallowedUse = (allow: readonly string[], command: string, shell: 'bash' | 'powershell' = 'bash'): string | null => {
  const parsed = commandWords(command, shell)
  if ('error' in parsed) return `is filled into one simple command only, and this one has ${parsed.error}. Run the command that needs it on its own, with the host written out`
  const [first, ...rest] = parsed.words
  if (!first) return "isn't allowed for an empty command"
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return `isn't filled into a command that sets environment variables first (${shown(first.split('=')[0]!)}=…)`
  if (/[\\/]/.test(first)) return `isn't filled into a program run by its path (${shown(first)}); run it by name`
  const program = programName(first)
  if (NEVER_ALLOWED.has(program)) return `is never filled into ${program}: it runs other programs or code`
  const commands = allow.filter(a => !isHostItem(a))
  const hosts = allow.filter(isHostItem)
  if (!commands.includes(program)) return `isn't allowed for ${program}; the user can allow it in /secrets`
  const short = REFUSED_SHORT[program] ?? ''
  const fileOptions = FILE_OPTIONS[program] ?? []
  const isFileOption = (option: string) => fileOptions.includes(option.length === 2 ? option : option.toLowerCase())
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!
    const cluster = /^-([A-Za-z]+)/.exec(word)?.[1] ?? ''
    const refused =
      REFUSED_OPTION_RE.test(word) || REFUSED_SETTING_RE.test(word) || (!word.startsWith('--') && [...cluster].some(c => short.includes(c))) ||
      // curl: `-:` is `--next`, and `{{name}}` expands a variable (curl 8.3+) into a URL the command does not show.
      (program === 'curl' && (word === '-:' || word.includes('{{')))
    if (refused) {
      return `isn't filled into a command with ${shown(word.split(/[=\s]/)[0]!)}: it can send the request through another host, run a command or read settings from a file`
    }
    if (word.startsWith('@') || (i > 0 && isFileOption(rest[i - 1]!))) continue
    // `-opt=value`, and PowerShell's `-Param:value` too.
    const option = (shell === 'powershell' ? /^(-[^=:]+)[=:]([\s\S]*)$/ : /^(-[^=]+)=([\s\S]*)$/).exec(word)
    if (option && isFileOption(option[1]!)) continue
    const host = hostOf(word.startsWith('-') ? (option?.[2] ?? '') : word, program)
    if (host === AMBIGUOUS) return `isn't filled in: ${shown(word)} can be read as more than one host. Write the URL plainly`
    if (host !== null && !hostAllowed(host, hosts)) return `isn't allowed for ${shown(host)}; the user can allow it in /secrets`
  }
  return null
}

/** The option that makes a program skip its config files (`~/.curlrc`, `~/.wgetrc`), which can add a URL or a proxy. */
const NO_CONFIG: Readonly<Record<string, string>> = { curl: '-q', wget: '--no-config' }

/**
 * The command with its program told to read no config file, so a file written earlier cannot send the
 * request elsewhere: curl gets `-q` as its first argument (where curl requires it), wget `--no-config`.
 * PowerShell's `curl`/`wget` without `.exe` are Invoke-WebRequest aliases and read no such file.
 */
export const withoutConfigFiles = (command: string, shell: 'bash' | 'powershell'): string => {
  const parsed = commandWords(command, shell)
  if ('error' in parsed || !parsed.words[0]) return command
  const [first, second] = parsed.words
  if (shell === 'powershell' && !/\.exe$/i.test(first!)) return command
  const flag = NO_CONFIG[programName(first!)]
  if (!flag || second === flag || (flag === '-q' && second === '--disable')) return command
  return command.replace(/^(\s*\S+)/, `$1 ${flag}`)
}

// ─── .env ────────────────────────────────────────────────────────────────────────────────────────

/**
 * `KEY=VALUE` lines: `export ` allowed, comments and blanks skipped, quotes stripped; a quoted value may
 * span lines (a PEM key), and a double-quoted one reads `\n` as a newline. Names are normalized.
 */
export const parseEnv = (text: string): Array<{ name: string; value: string }> => {
  const out: Array<{ name: string; value: string }> = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*([\s\S]*)$/.exec(line)
    if (!match) continue
    const name = normalizeName(match[1]!)
    let value = match[2]!
    const quote = /^["'`]/.exec(value)?.[0]
    if (quote) {
      const closing = new RegExp(`(?<!\\\\)\\${quote}\\s*(?:#.*)?$`)
      let body = value.slice(1)
      // A quoted value runs to its closing quote, across lines if need be.
      while (!closing.test(body) && i + 1 < lines.length) {
        i += 1
        body += `\n${lines[i]}`
      }
      value = body.replace(closing, '')
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1')
    } else value = value.replace(/\s+#.*$/, '').trim()
    if (name && value) out.push({ name, value })
  }
  return out
}

/** The next free `PASTED_<n>` name. */
export const nextPastedName = (taken: Iterable<string>): string => {
  const names = new Set(taken)
  let n = 1
  while (names.has(`${PASTED_PREFIX}${n}`)) n += 1
  return `${PASTED_PREFIX}${n}`
}

// ─── Claude importing a .env file ────────────────────────────────────────────────────────────────

/** Forward slashes, `.` and `..` resolved, no trailing slash. */
export const normalizePath = (path: string): string => {
  const parts: string[] = []
  const slashed = path.replace(/\\/g, '/')
  const lead = /^(?:[A-Za-z]:)?\//.exec(slashed)?.[0] ?? ''
  for (const part of slashed.slice(lead.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${lead}${parts.join('/')}`.replace(/\/$/, '') || lead
}

/** Whether `path` lies inside one of the folders `roots` (case-insensitive, as on Windows and macOS). */
export const isInside = (path: string, roots: readonly string[]): boolean => {
  const p = normalizePath(path).toLowerCase()
  return roots.some(root => {
    const r = normalizePath(root).toLowerCase()
    return r !== '' && p.startsWith(`${r}/`)
  })
}

/** Whether a file is a staging file Claude's import deletes by default: one under a `.secrets/` folder. */
export const isStagingFile = (path: string): boolean => /(?:^|\/)\.secrets\//.test(normalizePath(path))

/** What the import tool answers the model: names and lengths, never a value. */
export const importReport = (o: {
  imported: ReadonlyArray<{ name: string; value: string }>
  skipped: readonly string[]
  scope: Scope
  shown: string
  /** The file: deleted, could not be deleted, kept because some names were skipped, or left as asked. */
  deleted: 'deleted' | 'failed' | 'kept' | null
}): string =>
  [
    o.imported.length
      ? `Imported ${o.imported.length} secret${o.imported.length === 1 ? '' : 's'} from ${o.shown} into the vault (${o.scope === 'project' ? 'this project' : 'all projects'}): ${o.imported.map(e => `${e.name} (${e.value.length} chars)`).join(', ')}.`
      : `Imported nothing from ${o.shown}.`,
    o.skipped.length ? `Skipped ${o.skipped.join(', ')}: already in the vault (the user replaces a value in /secrets).` : '',
    o.imported.length ? 'They are allowed nowhere yet: ask the user to allow the commands or hosts each is for in /secrets, then use {{secret:NAME}}. The user can undo this import with /secrets undo.' : '',
    o.deleted === 'deleted' ? `Deleted ${o.shown}.` : o.deleted === 'failed' ? `Could not delete ${o.shown}; ask the user to delete it.` : o.deleted === 'kept' ? `Kept ${o.shown}, as it still holds the skipped values.` : '',
  ].filter(Boolean).join(' ')

// ─── the model's instructions ────────────────────────────────────────────────────────────────────

export const SECTION_ID = 'nanoflow:secrets'

/** The system-prompt section: how to use secrets without seeing them, and the names available. */
export const sectionText = (names: readonly string[]): string =>
  [
    '# Secrets',
    "The user keeps secrets (API keys, tokens, passwords) in nanoflow's vault, out of your sight. Never print, echo, log, transform or ask the user to paste a secret value, and never try to read one back.",
    'Where a value is needed, write the placeholder {{secret:NAME}} in ONE simple Bash or PowerShell command (no ;, &&, ||, pipes, $(...), variables, redirections or comments), with the program and host written out. It is filled in when the tool runs, only for the programs and hosts the user allowed for that secret, never for a shell or interpreter. In the content of a Write or Edit it is filled in only when the user allowed that secret in files, and only into a git-ignored file (such as .env) unless they also allowed tracked files. A value that comes back in output shows as the placeholder again, or as «redacted:<kind>» for a secret the vault does not hold.',
    'Never write a «redacted:...» mark into a file: it stands for a value you never saw. To write the placeholder text itself (in docs or templates), escape it with a backslash: \\{{secret:NAME}}.',
    'To bring secrets in from a file, write them to a git-ignored .secrets/.env in the project and call the nanoflow secrets_import tool with its path: nanoflow reads the file itself, stores the values, deletes the file and tells you only the names. Never read that file back.',
    "Only the user changes what a secret may be used for, in the Secrets pane: never read or change nanoflow's store or its settings.",
    'If a secret you need is not in the vault, or not allowed for a command or host, ask the user to add or allow it with /secrets (the Secrets pane), naming it in UPPER_SNAKE_CASE.',
    names.length ? `Available secret names: ${names.join(', ')}.` : 'The vault is empty.',
  ].join('\n')

// ─── conversation rows ───────────────────────────────────────────────────────────────────────────

/** A content block as the Messages API spells it (`session.append`'s `message.content`). */
export type Block = { type: string; [field: string]: unknown }

/**
 * A row's blocks with every secret masked: text blocks and each tool_result's content (a string or its
 * text blocks). Results of tool calls in `exampleIds` (reads of `.env.example`-style files) keep their
 * assignment lines. Null when nothing needed masking, so the row passes untouched.
 */
export const redactContent = (
  content: readonly Block[],
  values: Values,
  exampleIds: ReadonlySet<string> = new Set(),
): { content: Block[]; hits: string[] } | null => {
  const pairs = pairsOf(values)
  const hits: string[] = []
  const text = (t: string, skipAssignments: boolean): string => {
    const r = redact(t, pairs, { skipAssignments })
    hits.push(...r.hits)
    return r.text
  }
  const out = content.map((block): Block => {
    if (block.type === 'text' && typeof block.text === 'string') return { ...block, text: text(block.text, false) }
    if (block.type !== 'tool_result') return block
    const skip = typeof block.tool_use_id === 'string' && exampleIds.has(block.tool_use_id)
    if (typeof block.content === 'string') return { ...block, content: text(block.content, skip) }
    if (Array.isArray(block.content)) {
      return { ...block, content: (block.content as Block[]).map(b => (b.type === 'text' && typeof b.text === 'string' ? { ...b, text: text(b.text, skip) } : b)) }
    }
    return block
  })
  return hits.length ? { content: out, hits } : null
}
