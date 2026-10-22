# Glossary

The 术语表 page edits the global correction list used before topic analysis: literal `wrong → right` replacements applied to the transcript and passed to the model as hints. Edits are debounced (400 ms) and persist every row whose two columns are non-empty, with source 手工 and the row's last modification time.

## Sub-features

- `glossary-list` shows every entry with 识别结果, 正确写法, 来源, 修改时间.
- `glossary-add` appends an empty draft row; it is not written until both columns have text.
- `glossary-edit` saves after typing pauses; rows still missing a column stay local and are not sent.
- `glossary-remove` deletes the row (操作 column) and persists the remaining list immediately.
- `glossary-persist` writes the list to `<notesRoot>/corrections.json`.

## How to get to it (user POV)

- Click 术语表 in the sidebar (`nav-glossary`).
- The page is available with an empty library; it does not require a video.

## Driving it with verify.ts

Preconditions:

- A running instance from `verify.ts up` with an empty isolated home; `doctor` healthy.
- No video or model is needed for this journey.

- **Empty state.** Run `$V click-text '术语表'` and `$V wait "document.querySelector('[data-testid=glossary-add]') !== null"`. The table has zero `glossary-row` elements and the page advertises 填完两列后自动保存.
- **Add a row.** Run `$V click '[data-testid=glossary-add]'` and `$V wait "document.querySelectorAll('[data-testid=glossary-row]').length === 1"`.
- **Fill one column.** Run `$V fill '[data-testid=glossary-wrong]' 'sherpa'`. The draft row is not submitted: after the debounce window there is no toast and `<home>/corrections.json` still does not exist (or keeps its previous content).
- **Fill both columns.** Run `$V fill '[data-testid=glossary-right]' 'sherpa-onnx'`.
- **Wait for the write.** Run `$V wait "window.vnote.listGlossary().then(v => v.length === 1 && v[0].wrong === 'sherpa' && v[0].right === 'sherpa-onnx')" --timeout 10000`. The write happens one debounce window after the last keystroke, so read state, never sleep.
- **Read the side effect.** `cat <home>/corrections.json` contains the entry with `"source": "manual"` and the `updatedAt` stamped when the row was added.
- **Edit an existing entry.** Run `$V fill '[data-testid=glossary-right]' 'sherpa-onnx v1'`; the file's `right` becomes `sherpa-onnx v1`, the row count stays 1. `updatedAt` is not restamped by an edit.
- **Remove an entry.** Run `$V click '[data-testid=glossary-remove]' --index 0`. The row disappears immediately (removal flushes, it does not wait for the debounce) and `listGlossary()` returns the remaining list; removing the only row leaves `[]` in `corrections.json`.
- **Simulate a real save failure.** Fill both columns, then `chmod 555 <home>` and edit a cell again. Exactly one 保存失败 toast appears for the whole edit (typing does not stack toasts); `chmod 755 <home>` and edit again to prove the retry lands. Restore permissions before teardown.
- **Proof.** Wait for toasts to clear: `$V wait "document.querySelector('[data-testid=toast-host]') === null" --timeout 10000`. Then `$V shot glossary-proof`, `$V snapshot glossary-proof`, and keep `corrections.json` plus the command transcript in the run directory.

## Gotchas

- Saving is debounced, not per keystroke. After `$V fill` the write lands within ~0.5 s; wait on `listGlossary()` instead of screenshotting instantly.
- Incomplete rows (either column blank or whitespace-only) are filtered out of the request. They stay on screen as drafts, so a row visible in the table is not proof it was persisted — read `corrections.json`.
- Only a genuine write failure (permissions, disk) shows 保存失败, once per attempt. There is no success toast any more; a clean save is silent.
- `fill` must be used instead of assigning `input.value`: React's value tracker ignores direct DOM assignment, so the save never fires.
- Empty `wrong` or `right` is invalid at the IPC boundary too (the main process rejects the whole list). Clearing an existing row's text removes it from the next save.
- `corrections.json` at `<notesRoot>/corrections.json` is the **global** list. Per-video entries live in `<outputDir>/corrections.json` and are edited from the library card, not here. Video-specific entries win on conflicting `wrong` values.
- Replacement is literal: case, spacing and punctuation must match the transcript exactly. Do not expect fuzzy matching.
- Removing the last row writes an empty array file, not a deleted file.
