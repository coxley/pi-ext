# pi-ext

Prompt editor extensions for [Pi](https://pi.dev), and a session sidebar for Pi in Rex.

| Extension | What it does |
|---|---|
| [`chips`](chips/README.md) | Draws every paste marker as a labeled chip: URL, file, image, text, annotation. A pasted URL or file path, and a Ctrl+V image, become chips. Right-click a chip to expand it. Typed `@path`s that name a file are underlined. |
| `annotate` | Select transcript text with the mouse to add a comment. The quote and comment go in the prompt as an `annotation N` chip; click the chip to edit it. |
| [`expand-paste`](expand-paste/README.md) | The same paste twice in a row expands to editable text. Pastes lose shared indentation. `> ` quotes and list items (`- `, `1. `, `- [ ] `) continue on a new line; tab and shift+tab nest list items. |
| `md-prompt` | Styles markdown in the prompt as you type: headings, quotes, lists, code, bold, italic, links. |
| `editor-copy` | A mouse selection inside the prompt copies the prompt text: no frame characters, no wrap newlines, pastes as their content. A transcript selection (copy or annotate quote) joins soft-wrapped rows but keeps each list item, quote row, and code line on its own line. |
| [`sidebar`](sidebar/README.md) | A session tree left of the transcript (`ctrl+/`). It switches between Pis by swapping Rex blocks, shows their status, and starts Pis for cold sessions. Quitting a Pi leaves a shell in its pane. Needs Rex; without it, the tree shows but cannot switch. |
| `user-shell` | `!` commands run in `$SHELL` instead of bash. zsh sources `~/.zshrc` first, so aliases and functions work. The Shadowfax sandbox denies shell startup files: there, the command runs without them. |
| `rtk` | Prefixes known commands in the agent's bash calls with [`rtk`](https://github.com/rtk-ai/rtk), which compresses their output: `git add . && git push` runs as `rtk git add . && rtk git push`. A segment piped into another command, and any line with `<` or `>`, run unchanged. When `rtk` is not on `PATH` or in `~/.pi/agent/bin`, the first session downloads the latest release there and checks its SHA-256; `PI_OFFLINE` skips that. |
| `nudge` | Appends a `[nudge]` line to a tool result the model reads; the call still runs. A bash command that stands in for `read`, `ls`, `grep`, `find` or `edit` (`cat f`, `sed -n '1,9p' f`, `sed -i`), or a heredoc that writes a real file, names the tool to use, once per kind per session. Pipelines, redirects, and scratch files (`/tmp`, `$TMPDIR`, a `mktemp` variable) stay quiet. The same call, or the same cycle of up to 5 calls, with the same result 3 times in a row gets a loop warning. |
| `clock` | Each transcript block (prompt, reply, tool row, `!` command) shows its time, dim, at the right edge of its first line, as `14:32:05` in `America/New_York`, or `2026-11-01 14:32:05` from an earlier day; `/tz <zone>` changes the zone and keeps it in `~/.local/state/pi-clock/state.json`. A line with no room keeps its text and shows no time. While the agent works, the status reads `Working (1m 5s)`. |
| `todo` | A `todo` tool: the agent's checklist for a multi-step task, saved in the session so it survives compaction and restarts. On an ordered list, opening an item marks earlier ones done, and closing one warns about earlier open items. During a long agent run, every 25th tool result names the next open item; nothing joins your prompts or starts a turn. Reads lists saved by `@xynogen/pix-todo`. |
| `render` | Changes the expanded (ctrl+o) view of finished `bash` and `ls` results. `bash` output sits between two rules, green for exit 0 and red otherwise; `ls` lists entries as a tree with Nerd Font folder and file icons, followed by Pi's limit notices. Collapsed rows, such as `pi-minimum-sufficient-output`'s one line per tool, and running commands stay as they are. |
| `btw` | `/btw [--no-ctx] <question>` asks a side question while the agent keeps working. One model call, with the main session's model and thinking level and no tools, sees the last 10 user and assistant messages (`--no-ctx`: none). A line above the editor shows each running question; the answer lands as a card in the transcript that never enters the agent's context. |

`annotate` uses `chips` and `editor-copy`, and `chips` uses `editor-copy` and `md-prompt`, so the package loads all of them.

## Install

```sh
pi install git:github.com/coxley/pi-ext
```

Then `/reload`, or start Pi again. `pi update --extensions` pulls new commits. To try it for one session only: `pi -e git:github.com/coxley/pi-ext`.

## Requirements

- Pi in fullscreen mode (`"tuiMode": "fullscreen"`, Pi's default) for the mouse features: annotations, chip right-click, and prompt copy. The rest work in both modes.
- A [Nerd Font](https://www.nerdfonts.com) in the terminal for the chip icons.
- Tested with Pi 1.5.2. The extensions patch pi-tui editor internals. At startup, each one checks that the pi-tui methods it uses still exist. If a Pi update removed one, that extension stays off and shows a warning; the editor keeps working.

## Other extensions

- Works alone. With `@xynogen/pix-pretty` (pix-display) installed, chips also labels its prompt and skill chips, and pix-pretty's own expansion sends text pastes as `<paste>…</paste>`.
- Works with `pi-open-tui`'s editor frame, and with `pi-better-render` bullets (`• ◦ ▪ ☐ ☑`) and quote bars (`▎`).
- Replaces `pi-copy-soft-wrap`. Do not install both: it joins list items into one line.

What the model receives on submit:

| Chip | Without pix-pretty | With pix-pretty |
|---|---|---|
| URL | the URL | the URL |
| file | `<path>/abs/file</path>` | `<path>/abs/file</path>` |
| image | `/abs/image.png` | `<paste>/abs/image.png</paste>` |
| text | the text | `<paste>text</paste>` |
| annotation | the quote as `> ` lines, then the comment | the same, in `<paste>` |

## Tests

```sh
npm test
```

The tests import Pi's own modules from the local Pi installation (`test-host.ts`): `$PI_TEST_MODULES`, then Pi's managed install (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`), then the global npm root. Set `PI_TEST_MODULES` to the `node_modules` directory that holds `@earendil-works/pi-coding-agent` to test another installation. The `@path` completion test needs `fd` (`$FD`, Pi's copy, or `fd`/`fdfind` on `PATH`). The pix-pretty test runs only when pix-display is installed.
