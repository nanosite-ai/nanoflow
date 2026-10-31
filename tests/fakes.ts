// Fake secrets for the secrets tests, one per pattern kind, assembled at run time so the repository holds
// no complete token (no scanner trips on it, and nothing here was ever a real value).
export const fake = (n: number): string => 'FAKE'.repeat(n)

const pemLabel = ['RSA', 'PRIVATE', 'KEY'].join(' ')

export const FAKES: Readonly<Record<string, string>> = {
  'private-key': `-----BEGIN ${pemLabel}-----
MIIE${fake(8)}
-----END ${pemLabel}-----`,
  jwt: ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiJGQUtFIn0', fake(5)].join('.'),
  github: ['ghp', fake(9)].join('_'),
  githubPat: ['github', 'pat', fake(6)].join('_'),
  npm: ['npm', fake(9)].join('_'),
  stripe: ['sk', 'test', fake(6)].join('_'),
  stripeRestricted: ['rk', 'live', fake(6)].join('_'),
  slack: ['xox' + 'b', '0000', fake(3)].join('-'),
  aws: 'AKIA' + fake(4),
  google: 'AIza' + 'F'.repeat(35),
  ndv: ['ndv', fake(5)].join('_'),
}
