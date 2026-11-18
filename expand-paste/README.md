# expand-paste

A Pi extension for pastes, quotes and lists in the prompt editor. Pasting
the same collapsed content twice in a row expands the paste block, like
Claude, instead of adding a second `[paste #N]` marker. Pastes lose their
shared indentation, `> ` quotes carry across pasted and new lines, and list
items continue and nest.

## Behavior

- A large paste becomes a pill (`[paste #N]`, or a chip with `chips`), unchanged.
- Paste the same content again, with no other key between: that pill pair
  expands to one literal copy, ready to proofread and edit before sending.
  Every other pill in the editor stays a pill.
- Different content pasted next, a key between the pastes, or a paste that
  stays inline: normal Pi behavior.
- A multi-line paste loses the leading whitespace that all its non-blank lines
  share. Relative indentation stays. A single-line paste is unchanged.
- Quotes. When only a quote prefix (`> `, `> > `) comes before the cursor:
  - An inline paste quotes every pasted line.
  - A pill quotes every line when it expands. An unexpanded pill stays as is.
  - A trailing newline in the paste adds no empty quote line.
- A newline (`shift+enter`, `ctrl+j`) after a line that starts with a quote
  prefix starts the new line with that prefix. A newline on a second empty
  quote line in a row ends the quote: both empty lines become one blank line.
- Lists. A newline after a list item (`- `, `* `, `1. `, `a. `, `- [ ] `)
  starts the next item; a newline on a second empty item in a row ends the
  list. Anywhere on an item, tab nests it and shift+tab un-nests it. Tab after
  an `@path` still completes the path, and an open suggestion list keeps both
  keys.

## How

The extension wraps pi-tui's `Editor.prototype.handleInput`. Every Pi editor
(`CustomEditor`, pix-pretty chips, pi-open-tui) reaches it through `super`, so
the hook works even when an extension replaces the editor factory without
chaining it.

- Before a paste reaches the editor, `dedent` (`expand.ts`) rewrites its text.
- After the second paste lands, `expandPair` (`expand.ts`) deletes the two
  pills before the cursor and inserts the first pill's text once. Other
  extensions can import `expandPair` and `samePaste` from `expand.ts`.
- After an inline paste or a newline, the hook adds the quote prefix to the
  new rows in the same undo step.

## Limits

- Text pastes only. Image and file pastes do not go through bracketed paste.
- `expandPair` reads the editor's TS-private `pastes` map.
  A pi-tui change to that field stops expansion; pastes still work.
- Quoting reads and writes the editor's TS-private `state` and `pasteCounter`.
  A pi-tui change to those fields can stop quoting.

## Tests

```sh
node --test expand-paste/expand.test.ts
```

See the root README for how the tests find Pi.
