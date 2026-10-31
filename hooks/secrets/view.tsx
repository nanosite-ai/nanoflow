// The Secrets pane: this project's secrets and the ones for all projects, one line each (name, where it came
// from, length, a compact policy badge), the open one's details below it (what it may be used with, the
// file switches, Copy / Reveal / Rename / Delete), one summary line for what needs attention, then the add
// and import forms, folded until wanted. Pure: every handler is passed in. What it draws is the person's
// screen alone; none of it reaches the model.
import type { NfSecret, NfSecretScope, NfSecretsNote } from '../../types'
import { COLOR, Fold, type Look, Mark, type PaneElements, Row } from '../ui'

export type SecretsForm = 'add' | 'import' | 'none'

export type SecretsData = {
  secrets: readonly NfSecret[]
  /** This session's project folder, or null when only all-projects secrets apply. */
  root: string | null
  /** The revealed secret (by id) and its value, while it shows. */
  revealed: { id: string; value: string } | null
  confirm: string | null
  renaming: string | null
  note: NfSecretsNote | null
  /** The form's generation: its fields' keys, so a save draws them empty. */
  form: number
  addScope: NfSecretScope
  /** Names the last prompt stored on its own, offered for Undo. */
  pasted: readonly string[]
  /** The file those names came from, when Claude imported them (null: the person's prompt). */
  pastedFrom: string | null
  /** The user's setting lets every secret be written into tracked files. */
  trackedForAll: boolean
  /** The secret (by id) whose details are open. */
  open: string | null
  /** The form the person opened or closed; null until they do (the add form opens on an empty vault). */
  forms: SecretsForm | null
}

export type SecretsHandlers = {
  copy: (id: string, surface: string) => void
  reveal: (id: string) => void
  hide: () => void
  /** Opens one secret's details (null closes them). */
  setOpen: (id: string | null) => void
  /** Opens a form, or closes it when it is the one shown. */
  toggleForm: (form: 'add' | 'import', shown: SecretsForm) => void
  askDelete: (id: string) => void
  confirmDelete: (id: string) => void
  cancel: () => void
  startRename: (id: string) => void
  rename: (id: string, to: string) => void
  allow: (id: string, text: string) => void
  unallow: (id: string, item: string) => void
  draftName: (name: string) => void
  add: (value: string) => void
  setAddScope: (scope: NfSecretScope) => void
  importEnv: (path: string) => void
  undoPasted: () => void
  toggleTracked: (id: string) => void
  toggleFiles: (id: string) => void
  /** Puts in force a wider policy the store got outside this pane. */
  acceptChange: (id: string) => void
  /** Writes the policy in force back over one the store got outside this pane. */
  revertChange: (id: string) => void
}

const TONE = { error: COLOR.bad, success: COLOR.ok, warning: COLOR.wait, info: undefined } as const

/** A secret's policy at a glance, as the collapsed row shows it. */
const POLICY_LOOK = {
  nowhere: { icon: '🔒 ', color: COLOR.wait },
  allowed: { icon: '✓ ', color: COLOR.ok },
  files: { icon: '📄 ', color: COLOR.wait },
  tracked: { icon: '📝 ', color: COLOR.wait },
  changed: { icon: '⚠ ', color: COLOR.bad },
} as const satisfies Record<string, Look>

/** How many allowed uses the collapsed row names before `+n`. */
const SHOWN_USES = 2

const baseName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** `curl, api.stripe.com +2`. */
const usesShort = (allow: readonly string[]): string =>
  allow.length <= SHOWN_USES ? allow.join(', ') : `${allow.slice(0, SHOWN_USES).join(', ')} +${allow.length - SHOWN_USES}`

const tracked = (s: NfSecret, data: SecretsData): boolean => s.allowFiles && (s.allowTracked || data.trackedForAll)

/** What needs the person: secrets allowed nowhere, and policies the store widened outside the pane. */
const attention = (secrets: readonly NfSecret[]) => ({
  nowhere: secrets.filter(s => s.allow.length === 0),
  changed: secrets.filter(s => s.changed.length > 0),
})

/** One line above the list for everything that needs a look, with a button to the first such secret. */
const SummaryBar = (el: PaneElements, data: SecretsData, on: SecretsHandlers) => {
  const { Text, Button } = el
  const { nowhere, changed } = attention(data.secrets)
  if (nowhere.length === 0 && changed.length === 0) return null
  const parts = [
    nowhere.length ? `${plural(nowhere.length, 'secret is', 'secrets are')} allowed nowhere` : '',
    changed.length ? `${plural(changed.length, 'policy', 'policies')} changed outside the pane` : '',
  ].filter(Boolean)
  const first = (changed[0] ?? nowhere[0])!
  return Row(el, 'secret-summary', [
    <Text key="text" color={changed.length ? COLOR.bad : COLOR.wait}>{`⚠ ${parts.join(' · ')}`}</Text>,
    data.open === first.id ? null : <Button key="secret-review" plain label="[ review ]" onPress={() => on.setOpen(first.id)} />,
  ])
}

/** The collapsed row: one line, pressed to open or close its details. */
const SecretRow = (el: PaneElements, s: NfSecret, data: SecretsData, on: SecretsHandlers) => {
  const { Text } = el
  const isOpen = data.open === s.id
  return Row(el, `secret-row-${s.id}`, [
    Fold(el, `secret-open-${s.id}`, isOpen, `🔐 ${s.name}`, () => on.setOpen(isOpen ? null : s.id)),
    <Text key="source" dimColor>{s.source}</Text>,
    <Text key="len" dimColor>{`${s.length} chars`}</Text>,
    s.changed.length > 0 ? Mark(el, 'changed', POLICY_LOOK.changed, 'changed') : null,
    s.allow.length === 0 ? Mark(el, 'nowhere', POLICY_LOOK.nowhere, 'nowhere') : Mark(el, 'uses', POLICY_LOOK.allowed, usesShort(s.allow)),
    s.allowFiles ? Mark(el, 'files', POLICY_LOOK.files, 'files') : null,
    tracked(s, data) ? Mark(el, 'tracked', POLICY_LOOK.tracked, 'tracked') : null,
  ])
}

/** The open secret: where it came from, what it may be used with and written into, and its actions. */
const SecretDetails = (el: PaneElements, s: NfSecret, data: SecretsData, on: SecretsHandlers) => {
  const { Box, Text, Button, Input } = el
  const k = (what: string) => `secret-${what}-${s.id}`
  const revealed = data.revealed?.id === s.id ? data.revealed.value : null
  return (
    <Box key={k('details')} flexDirection="column" paddingLeft={2}>
      <Text key={k('origin')} dimColor>{`${s.scope === 'project' ? '📁 This project' : '🌐 All projects'} · ${s.source}`}</Text>
      {s.allow.length === 0
        ? <Text key={k('nothing-allowed')} color={COLOR.wait}>{'⚠ Not allowed anywhere yet: Claude cannot use it until you allow a command (kubectl) or a host (api.example.com).'}</Text>
        : Row(el, k('allowed'), [
            <Text key="label" dimColor>Allowed:</Text>,
            ...s.allow.map(item => <Button key={`secret-unallow-${s.id}-${item}`} plain label={`${item} ✕`} onPress={() => on.unallow(s.id, item)} />),
          ])}
      {Input && <Input key={`${k('allow')}-${data.form}`} label="Allow" placeholder="kubectl, npm, api.example.com" submitLabel="allow" onSubmit={text => on.allow(s.id, text)} />}
      {s.changed.length > 0 &&
        Row(el, k('changed-row'), [
          <Text key="changed" color={COLOR.bad}>{`⚠ Changed outside this pane, not in force: ${s.changed.join(', ')}`}</Text>,
          <Button key={k('accept')} plain label="[ accept ]" onPress={() => on.acceptChange(s.id)} />,
          <Button key={k('revert')} plain label="[ undo ]" onPress={() => on.revertChange(s.id)} />,
        ])}
      {Row(el, k('files-row'), [
        <Text key="label" color={s.allowFiles ? COLOR.wait : undefined} dimColor={!s.allowFiles}>
          {s.allowFiles ? '📄 May be written into git-ignored files' : '📄 Never written into files'}
        </Text>,
        <Button key={k('files')} plain label={s.allowFiles ? '[ disallow ]' : '[ allow writing into files ]'} onPress={() => on.toggleFiles(s.id)} />,
      ])}
      {!s.allowFiles ? null : data.trackedForAll
        ? <Text key={k('tracked-all')} dimColor>{'📝 Tracked files: allowed for every secret (the secretsAllowTrackedWrites setting)'}</Text>
        : Row(el, k('tracked-row'), [
            <Text key="label" color={s.allowTracked ? COLOR.wait : undefined} dimColor={!s.allowTracked}>
              {s.allowTracked ? '📝 May be written into files git tracks' : '📝 Written only into git-ignored files'}
            </Text>,
            <Button key={k('tracked')} plain label={s.allowTracked ? '[ disallow ]' : '[ allow writing into tracked files ]'} onPress={() => on.toggleTracked(s.id)} />,
          ])}
      {Row(el, k('actions'), [
        <Button key={k('copy')} label="📋 Copy" onPress={press => on.copy(s.id, press.surface)} />,
        revealed === null
          ? <Button key={k('reveal')} label="👁 Reveal" onPress={() => on.reveal(s.id)} />
          : <Button key={k('hide')} label="🙈 Hide" onPress={on.hide} />,
        <Button key={k('rename')} label="✏️ Rename" onPress={() => on.startRename(s.id)} />,
        <Button key={k('delete')} label="🗑 Delete" onPress={() => on.askDelete(s.id)} />,
      ])}
      {revealed !== null && <Text key={k('value')} color={COLOR.wait}>{revealed}</Text>}
      {data.confirm === s.id &&
        Row(el, k('confirm-row'), [
          <Text key="ask" color={COLOR.bad}>{`Delete ${s.name}?`}</Text>,
          <Button key={k('confirm')} label="Delete" variant="primary" onPress={() => on.confirmDelete(s.id)} />,
          <Button key={k('cancel')} label="Cancel" onPress={on.cancel} />,
        ])}
      {data.renaming === s.id && Input && (
        <Input key={k('rename-input')} label="New name" placeholder="UPPER_SNAKE_CASE" submitLabel="Rename" autoFocus onSubmit={to => on.rename(s.id, to)} />
      )}
    </Box>
  )
}

/** One scope's secrets under its heading: a line each, the open one's details below it. */
const SecretList = (el: PaneElements, key: string, title: string, secrets: readonly NfSecret[], data: SecretsData, on: SecretsHandlers) => {
  const { Box, Text } = el
  return (
    <Box key={key} flexDirection="column">
      <Text bold>{secrets.length ? `${title} (${secrets.length})` : title}</Text>
      {secrets.length === 0 && <Text dimColor>None yet.</Text>}
      {secrets.flatMap(s => [SecretRow(el, s, data, on), data.open === s.id ? SecretDetails(el, s, data, on) : null])}
    </Box>
  )
}

/** A form's heading: pressed to fold or unfold it. */
const FormToggle = (el: PaneElements, form: 'add' | 'import', label: string, shown: SecretsForm, on: SecretsHandlers) =>
  Fold(el, `secret-form-${form}`, shown === form, label, () => on.toggleForm(form, shown))

const AddForm = (el: PaneElements, data: SecretsData, on: SecretsHandlers, shown: SecretsForm) => {
  const { Box, Text, Button, Input } = el
  if (!Input) return null
  return (
    <Box key="secret-add" flexDirection="column">
      {FormToggle(el, 'add', '➕ Add a secret', shown, on)}
      {shown === 'add' && (
        <Box flexDirection="column" paddingLeft={2}>
          {data.root !== null &&
            Row(el, 'secret-scope-row', [
              <Text key="to" dimColor>Save to:</Text>,
              <Button key="secret-scope-project" label="This project" variant={data.addScope === 'project' ? 'primary' : 'secondary'} onPress={() => on.setAddScope('project')} />,
              <Button key="secret-scope-global" label="All projects" variant={data.addScope === 'global' ? 'primary' : 'secondary'} onPress={() => on.setAddScope('global')} />,
            ])}
          <Input key={`secret-add-name-${data.form}`} label="Name" placeholder="STRIPE_SECRET_KEY" submitLabel="next" onInput={on.draftName} onSubmit={on.draftName} />
          <Input key={`secret-add-value-${data.form}`} label="Value" placeholder="paste, then Enter (shown only to you)" submitLabel="save" onSubmit={on.add} />
        </Box>
      )}
    </Box>
  )
}

const ImportForm = (el: PaneElements, data: SecretsData, on: SecretsHandlers, shown: SecretsForm) => {
  const { Box, Text, Input } = el
  if (!Input) return null
  return (
    <Box key="secret-import" flexDirection="column">
      {FormToggle(el, 'import', '📥 Import a .env file', shown, on)}
      {shown === 'import' && (
        <Box flexDirection="column" paddingLeft={2}>
          {data.root !== null && <Text dimColor>{`Saves to ${data.addScope === 'project' ? 'this project' : 'all projects'}, as picked under Add.`}</Text>}
          <Input key={`secret-import-${data.form}`} label="Path" placeholder=".env, ~/project/.env.local" submitLabel="import" onSubmit={on.importEnv} />
        </Box>
      )}
    </Box>
  )
}

export const SecretsView = (el: PaneElements, data: SecretsData, on: SecretsHandlers) => {
  const { Box, Text, Button, Input } = el
  const project = data.secrets.filter(s => s.scope === 'project')
  const global = data.secrets.filter(s => s.scope === 'global')
  const shown: SecretsForm = data.forms ?? (data.secrets.length === 0 ? 'add' : 'none')
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>{'Claude sees only the names and writes {{secret:NAME}} where a value goes. Each secret works only with the commands and hosts you allow: a guard against accidents, not a hostile agent.'}</Text>
      {data.note && <Text key="secrets-note" color={TONE[data.note.tone]}>{data.note.text}</Text>}
      {data.pasted.length > 0 &&
        Row(el, 'secret-pasted-row', [
          <Text key="pasted" color={COLOR.wait}>
            {data.pastedFrom ? `Imported by Claude from ${data.pastedFrom}: ${data.pasted.join(', ')}` : `Stored from your prompt: ${data.pasted.join(', ')}`}
          </Text>,
          <Button key="secret-undo-pasted" label="↩ Undo" onPress={on.undoPasted} />,
        ])}
      {SummaryBar(el, data, on)}
      {data.root !== null && SecretList(el, 'secret-list-project', `📁 This project · ${baseName(data.root)}`, project, data, on)}
      {SecretList(el, 'secret-list-global', '🌐 All projects', global, data, on)}
      {Input
        ? [AddForm(el, data, on, shown), ImportForm(el, data, on, shown)]
        : <Text dimColor>Add or import secrets from a terminal or the desktop app.</Text>}
    </Box>
  )
}
