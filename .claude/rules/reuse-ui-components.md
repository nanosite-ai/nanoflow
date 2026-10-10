# Reuse the pane's components: never hand-roll what already exists

For working on nanoflow itself (not shipped with the plugin).

Before drawing anything in the pane (`hooks/view.tsx`), check `hooks/ui.tsx` and use what's there. A
hand-written `<Box flexDirection="row" gap={1} flexWrap="wrap">` when `Row` exists is a defect, not a shortcut.

## The building blocks (`hooks/ui.tsx`)

- **`COLOR`**: semantic theme keys (`ok`, `bad`, `wait`, `merged`, `info`, `muted`, …). Never a raw color name.
- **`Row(el, key, children, { gap, indent, wrap })`**: every horizontal line of parts. `indent` lines it
  up under a card's title.
- **`Badge`** / **`StatusBadge`**: inverse text on a color; a board column in its own color (`statusColor`).
- **`Mark(el, key, look, text?)`**: a glyph in its color, from a `Look` table (`CI_LOOK`, `PR_LOOK`,
  `STAGE_LOOK`, `SERVICE_LOOK` in `view.tsx`). Add a row to a table rather than a one-off `<Text color>`.
- **`TicketLink`**: `🎫 #712`, linked.
- **`LinkOr(el, key, href, label, color?)`**: a link when there is somewhere to go, the same label as text otherwise.

## Rules

1. **Look first.** Scan `hooks/ui.tsx` before writing a `Box`/`Text`/`Link` by hand.
2. **Extend, don't fork.** If a piece is close but missing an option, add the option to it in `ui.tsx` so
   every tab benefits, instead of copying its markup.
3. **Repeated twice means it belongs in `ui.tsx`.** The second copy of any markup is the moment to extract it.
4. **Keep the idiom.** Pieces are plain functions that take the element table (`el`) and a `key`, not
   function components, because the surface hands us its own elements.
5. **Handlers too.** Shared host steps (copying to the clipboard, running an action) are one helper in
   `register.tsx` (`copy`, `runAction`), not repeated inline in each handler.
6. **Exceptions**: a one-off layout (a card's frame, the activity output box) can stay inline when no piece
   fits. Reusing a piece must not force the wrong look.

## Why

One look and one behavior across tabs, less markup to read, and a restyle happens once in `ui.tsx`.
