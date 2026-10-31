// The Secrets pane: the vault's names (never a value unless the person asks to reveal one, for a few
// seconds), Copy / Reveal / Rename / Delete per row, an add form and an .env import. Pure: every handler
// is passed in. What this pane draws is the person's screen alone; none of it reaches the model.
import type { NfSecret, NfSecretsNote } from '../../types'
import { COLOR, type PaneElements, Row } from '../ui'

export type SecretsData = {
  secrets: readonly NfSecret[]
  /** The revealed secret and its value, while it shows. */
  revealed: { name: string; value: string } | null
  confirm: string | null
  renaming: string | null
  note: NfSecretsNote | null
  /** The add form's generation: its fields' keys, so a save draws them empty. */
  form: number
}

export type SecretsHandlers = {
  copy: (name: string, surface: string) => void
  reveal: (name: string) => void
  hide: () => void
  askDelete: (name: string) => void
  confirmDelete: (name: string) => void
  cancel: () => void
  startRename: (name: string) => void
  rename: (from: string, to: string) => void
  draftName: (name: string) => void
  add: (value: string) => void
  importEnv: (path: string) => void
}

const TONE = { error: COLOR.bad, success: COLOR.ok, warning: COLOR.wait, info: undefined } as const

export const SecretsView = (el: PaneElements, data: SecretsData, on: SecretsHandlers) => {
  const { Box, Text, Button, Input } = el
  const k = (name: string, what: string) => `secret-${what}-${name}`
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>{'Values stay on this machine: Claude sees only the names, and writes {{secret:NAME}} where one goes.'}</Text>
      {data.note && <Text key="secrets-note" color={TONE[data.note.tone]}>{data.note.text}</Text>}
      <Box flexDirection="column">
        {data.secrets.length === 0 && <Text dimColor>No secrets yet. Add one below, or import a .env file.</Text>}
        {data.secrets.map(s => {
          const revealed = data.revealed?.name === s.name ? data.revealed.value : null
          return (
            <Box key={`secret-${s.name}`} flexDirection="column">
              {Row(el, `secret-row-${s.name}`, [
                <Text key="name" bold>{`🔐 ${s.name}`}</Text>,
                <Text key="len" dimColor>{`${s.length} chars`}</Text>,
                <Button key={k(s.name, 'copy')} label="📋 Copy" onPress={press => on.copy(s.name, press.surface)} />,
                revealed === null
                  ? <Button key={k(s.name, 'reveal')} label="👁 Reveal" onPress={() => on.reveal(s.name)} />
                  : <Button key={k(s.name, 'hide')} label="🙈 Hide" onPress={on.hide} />,
                <Button key={k(s.name, 'rename')} label="✏️ Rename" onPress={() => on.startRename(s.name)} />,
                <Button key={k(s.name, 'delete')} label="🗑 Delete" onPress={() => on.askDelete(s.name)} />,
              ])}
              {revealed !== null && <Text key={k(s.name, 'value')} color={COLOR.wait}>{`  ${revealed}`}</Text>}
              {data.confirm === s.name &&
                Row(el, k(s.name, 'confirm-row'), [
                  <Text key="ask" color={COLOR.bad}>{`Delete ${s.name}?`}</Text>,
                  <Button key={k(s.name, 'confirm')} label="Delete" variant="primary" onPress={() => on.confirmDelete(s.name)} />,
                  <Button key={k(s.name, 'cancel')} label="Cancel" onPress={on.cancel} />,
                ], { indent: true })}
              {data.renaming === s.name && Input && (
                <Box paddingLeft={2}>
                  <Input key={k(s.name, 'rename-input')} label="New name" placeholder="UPPER_SNAKE_CASE" submitLabel="Rename" autoFocus onSubmit={to => on.rename(s.name, to)} />
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
      {Input ? (
        <Box flexDirection="column">
          <Text bold>➕ Add a secret</Text>
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
