# chips

Draws every Pi prompt paste marker as a chip. The label sits inside the marker's width, so cursor columns, copy, and pi-open-tui's frame rails stay aligned.

| Marker value | Chip | The model gets |
|---|---|---|
| one URL | `\uf0c1 <host>` | the URL |
| image: Ctrl+V of an image (Pi's temp file), or a pasted or dropped image path | `\uf03e image` | its absolute path |
| file: a pasted or dropped path to any other existing file | `\uf15b <basename>` (folder: `\ue5ff <name>/`) | `<path>abs</path>` |
| other text | `\uf0ea text N chars` | the text |
| annotation (from annotate, `chips:label` event) | `\uf075 annotation N` | the quote and the comment |
| pix-pretty prompt / skill, when pix-pretty is installed | `\uf0d0 <name>` / `\uf0ad $<skill>` | its tag |

- A paste that is exactly one http(s) URL, or one path to an existing file (quoted or backslash-escaped, as terminals drop it), becomes a chip.
- Pasting the same URL or file twice in a row gives one literal copy, as expand-paste does for text.
- Right-click a chip to expand it in place.
- A typed `@path` that names an existing file (relative to cwd) is underlined in magenta.

## How

chips patches pi-tui's `Editor.prototype`:

- `handleInput`: a URL or file paste becomes a chip.
- `insertTextAtCursor`: an image path that Pi inserts (Ctrl+V) becomes an image chip.
- `expandPasteMarkers`: file and image chips expand to what the model gets (table above). pi-tui itself expands only text.
- `render`: draws the chips and the `@path` underline.

With pix-pretty installed, its per-editor chip pass and expansion run above these patches. chips draws every marker first, so pix-pretty's pass finds none to shrink, and pix-pretty's expansion and insert handle the chips before chips' own patches see them.

Another extension names its own chips with `pi.events.emit("chips:label", (editor, value) => label | undefined)` from its `session_start`.

## Test

```sh
node --test chips/chips.test.ts annotate/annotate.test.ts
```
