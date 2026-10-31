// The Secrets pane: this project's secrets and the ones for all projects, by name (a value only while the
// person reveals it, for a few seconds), what each may be used with, Copy / Reveal / Rename / Delete, an add
// form and an .env import. Pure: every handler is passed in. What it draws is the person's screen alone;
// none of it reaches the model.
import type { NfSecret, NfSecretScope, NfSecretsNote } from '../../types'
import { COLOR, type PaneElements, Row } from '../ui'

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
  /** The user's setting lets every secret be written into tracked files. */
  trackedForAll: boolean
}

export type SecretsHandlers = {
  copy: (id: string, surface: string) => void
  reveal: (id: string) => void
  hide: () => void
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

const baseName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path

const SecretRow = (el: PaneElements, s: NfSecret, data: SecretsData, on: SecretsHandlers) => {
  const { Box, Text, Button, Input } = el
  const k = (what: string) => `secret-${what}-${s.id}`
  const revealed = data.revealed?.id === s.id ? data.revealed.value : null
  return (
    <Box key={`secret-${s.id}`} flexDirection="column">
      {Row(el, k('row'), [
        <Text key="name" bold>{`🔐 ${s.name}`}</Text>,
        <Text key="len" dimColor>{`${s.length} chars`}</Text>,
        <Button key={k('copy')} label="📋 Copy" onPress={press => on.copy(s.id, press.surface)} />,
        revealed === null
          ? <Button key={k('reveal')} label="👁 Reveal" onPress={() => on.reveal(s.id)} />
          : <Button key={k('hide')} label="🙈 Hide" onPress={on.hide} />,
        <Button key={k('rename')} label="✏️ Rename" onPress={() => on.startRename(s.id)} />,
        <Button key={k('delete')} label="🗑 Delete" onPress={() => on.askDelete(s.id)} />,
      ])}
      {revealed !== null && <Text key={k('value')} color={COLOR.wait}>{`  ${revealed}`}</Text>}
      {s.allow.length === 0
        ? <Text key={k('nothing-allowed')} color={COLOR.wait}>{'  ⚠ Not allowed anywhere yet: Claude cannot use it until you allow a command (kubectl) or a host (api.example.com).'}</Text>
        : Row(el, k('allowed'), [
            <Text key="label" dimColor>Allowed:</Text>,
            ...s.allow.map(item => <Button key={`secret-unallow-${s.id}-${item}`} plain label={`${item} ✕`} onPress={() => on.unallow(s.id, item)} />),
          ], { indent: true })}
      {s.changed.length > 0 &&
        Row(el, k('changed-row'), [
          <Text key="changed" color={COLOR.bad}>{`⚠ Changed outside this pane, not in force: ${s.changed.join(', ')}`}</Text>,
          <Button key={k('accept')} plain label="[ accept ]" onPress={() => on.acceptChange(s.id)} />,
          <Button key={k('revert')} plain label="[ undo ]" onPress={() => on.revertChange(s.id)} />,
        ], { indent: true })}
      {Row(el, k('files-row'), [
        <Text key="label" color={s.allowFiles ? COLOR.wait : undefined} dimColor={!s.allowFiles}>
          {s.allowFiles ? '📄 May be written into git-ignored files' : '📄 Never written into files'}
        </Text>,
        <Button key={k('files')} plain label={s.allowFiles ? '[ disallow ]' : '[ allow writing into files ]'} onPress={() => on.toggleFiles(s.id)} />,
      ], { indent: true })}
      {!s.allowFiles ? null : data.trackedForAll
        ? <Text key={k('tracked-all')} dimColor>{'  📝 Tracked files: allowed for every secret (the secretsAllowTrackedWrites setting)'}</Text>
        : Row(el, k('tracked-row'), [
            <Text key="label" color={s.allowTracked ? COLOR.wait : undefined} dimColor={!s.allowTracked}>
              {s.allowTracked ? '📝 May be written into files git tracks' : '📝 Written only into git-ignored files'}
            </Text>,
            <Button key={k('tracked')} plain label={s.allowTracked ? '[ disallow ]' : '[ allow writing into tracked files ]'} onPress={() => on.toggleTracked(s.id)} />,
          ], { indent: true })}
      {Input && (
        <Box paddingLeft={2}>
          <Input key={`${k('allow')}-${data.form}`} label="Allow" placeholder="kubectl, npm, api.example.com" submitLabel="allow" onSubmit={text => on.allow(s.id, text)} />
        </Box>
      )}
      {data.confirm === s.id &&
        Row(el, k('confirm-row'), [
          <Text key="ask" color={COLOR.bad}>{`Delete ${s.name}?`}</Text>,
          <Button key={k('confirm')} label="Delete" variant="primary" onPress={() => on.confirmDelete(s.id)} />,
          <Button key={k('cancel')} label="Cancel" onPress={on.cancel} />,
        ], { indent: true })}
      {data.renaming === s.id && Input && (
        <Box paddingLeft={2}>
          <Input key={k('rename-input')} label="New name" placeholder="UPPER_SNAKE_CASE" submitLabel="Rename" autoFocus onSubmit={to => on.rename(s.id, to)} />
        </Box>
      )}
    </Box>
  )
}

export const SecretsView = (el: PaneElements, data: SecretsData, on: SecretsHandlers) => {
  const { Box, Text, Button, Input } = el
  const project = data.secrets.filter(s => s.scope === 'project')
  const global = data.secrets.filter(s => s.scope === 'global')
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>{'Claude sees only the names and writes {{secret:NAME}} where a value goes. Each secret works only with the commands and hosts you allow. This guards against accidents, not against a deliberately hostile agent.'}</Text>
      {data.note && <Text key="secrets-note" color={TONE[data.note.tone]}>{data.note.text}</Text>}
      {data.pasted.length > 0 &&
        Row(el, 'secret-pasted-row', [
          <Text key="pasted" color={COLOR.wait}>{`Stored from your prompt: ${data.pasted.join(', ')}`}</Text>,
          <Button key="secret-undo-pasted" label="↩ Undo" onPress={on.undoPasted} />,
        ])}
      {data.root !== null && (
        <Box flexDirection="column">
          <Text bold>{`📁 This project · ${baseName(data.root)}`}</Text>
          {project.length === 0 && <Text dimColor>None yet.</Text>}
          {project.map(s => SecretRow(el, s, data, on))}
        </Box>
      )}
      <Box flexDirection="column">
        <Text bold>🌐 All projects</Text>
        {global.length === 0 && <Text dimColor>None yet.</Text>}
        {global.map(s => SecretRow(el, s, data, on))}
      </Box>
      {Input ? (
        <Box flexDirection="column">
          <Text bold>➕ Add a secret</Text>
          {data.root !== null &&
            Row(el, 'secret-scope-row', [
              <Text key="to" dimColor>Save to:</Text>,
              <Button key="secret-scope-project" label="This project" variant={data.addScope === 'project' ? 'primary' : 'secondary'} onPress={() => on.setAddScope('project')} />,
              <Button key="secret-scope-global" label="All projects" variant={data.addScope === 'global' ? 'primary' : 'secondary'} onPress={() => on.setAddScope('global')} />,
            ])}
          <Input key={`secret-add-name-${data.form}`} label="Name" placeholder="STRIPE_SECRET_KEY" submitLabel="next" onInput={on.draftName} onSubmit={on.draftName} />
          <Input key={`secret-add-value-${data.form}`} label="Value" placeholder="paste, then Enter (shown only to you)" submitLabel="save" onSubmit={on.add} />
          <Text bold>📥 Import a .env file</Text>
          <Input key={`secret-import-${data.form}`} label="Path" placeholder=".env, ~/project/.env.local" submitLabel="import" onSubmit={on.importEnv} />
        </Box>
      ) : (
        <Text dimColor>Add or import secrets from a terminal or the desktop app.</Text>
      )}
    </Box>
  )
}
