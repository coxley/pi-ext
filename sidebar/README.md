# Pi session sidebar

A Codex-style session navigator drawn inside Pi's fullscreen TUI, left of the transcript.
It switches between Pi sessions by swapping Rex blocks, so a session that is already running
shows up at once.

## Use

- `ctrl+/`: if the sidebar is closed, open it and focus it. If it is open, focus it. If it is focused, close it.
- `/sidebar` does the same. `/sidebar width N` sets the width (16 to 80 columns).
- When the sidebar has focus: `up`/`down` (or `k`/`j`) move. `enter` or `space` opens the row.
  `left`/`right` (or `h`/`l`) collapse and expand folders. `escape` gives focus back to the prompt.
- Session actions, as keys on the cursor row or icons at the right edge of the hovered (or focused cursor) row:
  - `p` / `\uf08d`: pin or unpin. Pinned sessions also show in a `Pinned` section on top, even when stale.
  - `a` / `\uf187`: archive or unarchive. Archived sessions move to an `Archived` section at the bottom, collapsed at first.
  - `x` / `\uf011`: close another session's live Pi. Its session file stays. A working or blocked Pi asks first.
  Pinning un-archives a session, and archiving un-pins it.
- Directory (repo, worktree, plain folder) action, in the pin's column: `t` / `\u{F018D}` opens a shell in the folder's directory, in a Rex split to the right of this Pi.
- A click on a row opens it, with or without focus. The mouse wheel scrolls the sidebar.
- Quitting a shown Pi (`ctrl+c` twice, `ctrl+d`, `/quit`) hands its pane to the most recently focused Pi at rest in the same Rex session.
  With none, the pane closes as usual.
- When the pointer is over a session row, a tooltip beside the sidebar shows the last prompt sent in that session.
  This needs hover (motion) mouse events. pi-tui turns them off under tmux, zellij, and screen; there, no tooltip shows.

Rows:

- `\uea62 repo`, then git worktrees by directory name, then sessions. A `\uf07b dir` is a directory outside git.
- A session row shows the session title (`/name`, `--name`, or `pi.setSessionName()`: the last `session_info` entry). With no title, the row shows the last 8 characters of the session ID (the first 8 are the UUIDv7 timestamp). It never shows a prompt.
- Sessions in a folder sort live first (a Pi runs them now), then by creation time (the header `timestamp`), newest first. Top-level folders sort by name (case-insensitive), so they never move; worktree folders in a repo sort by their newest activity.
- This Pi's session draws in the accent color, other live sessions in bold, and the rest dim.
- Forked sessions (`parentSession`) go under their parent with `\ue725`. They sort the same way.
- Each folder ends with `+ New`, which starts `pi` in that directory.
- Sessions with no activity for 14 days, and archived sessions, are hidden.
- Status at the right edge comes from Rex `program_status`: animated dots mean working, `!` means blocked or error, and a green `●` means done and not seen yet.
  A Pi with terminal focus marks its own `done` seen: it reports `idle` (OSC 7501 defines `done` as not yet seen).

## How it works

- Each Pi labels its Rex block `pi:<sessionId>`, after it first loads the session list.
  When Pi quits, it resets the label.
- One background `refresher.ts` per user, run while any sidebar is open, writes `snapshot.json`: the session list, git grouping, and every `pi:*` block on the server with its status.
  It polls Rex every 1.5 s with one `rex do -` Lua script. Pis read the snapshot only when its mtime changes.
- Pis at rest are detached blocks. Each Rex session has one `__pi__` tab, whose placeholder pane (`placeholder.sh`) draws a π.
- Opening a session in this Rex session, as one `rex do -` script:
  1. Move the target Pi into `__pi__` beside the placeholder (make the tab if it is missing).
  2. Swap this Pi with the target across tabs.
  3. Detach this Pi.
  4. Focus the target.
  A target that already shows is only focused. A Pi keeps its last size on screen, so a switch within one slot does not reflow.
- A block in another Rex session: a detached block first gets a new tab (with a stand-in block that closes again).
  Then `client.perform session.select` and `focus_block` run. This needs Rex Remote Control.
- With no live block, the sidebar starts this Pi's build (`process.execPath` + `argv[1]`, the same `-e` flags, and `--session <file>`) in a detached block, at this Pi's size.
  It waits until that Pi labels itself, then swaps it in.
- Status for a detached Pi has no tab, so Rex cannot show it. The sidebar reports it again as an OSC 7501 child record `session/<id-without-dashes>` from one visible Pi.
  That Pi is the lowest-ID placed Pi in the same Rex session, or else the lowest-ID placed Pi on the server.
  This happens only while the sidebar is open. A visible Pi's own status is Pi's built-in root record.
- Shared state (open, width, collapsed folders, archived IDs): `${XDG_STATE_HOME:-~/.local/state}/pi-sidebar/state.json`.
  Each Pi reads it again when its mtime changes, so all Pis draw the same sidebar.
- Layout: a patch on `TuiAltScreen.prototype.doRender` wraps Pi's layout root as `HStack([sidebar, root])` while the sidebar is open.
  If Pi sets a new root, it gets wrapped again. On `session_shutdown`, the patch becomes a pass-through and the root is unwrapped, so `/reload` is safe.

## Dev and test

```sh
cd ~/.pi/agent/extensions/sidebar
node --test *.test.ts

# Live: run Pi in your own Rex tab from a temp dir, with a separate state dir.
d=$(mktemp -d)
rex window new -s "$REX_SESSION" demo-sidebar-x -c "$d" --focus=false --keep-open --json -- \
  env XDG_STATE_HOME="$d" pi
rex block call -s "$REX_SESSION" -b <block> resize '{"columns":130,"rows":36}'   # unseen tabs start at 80x24
rex send-key -s "$REX_SESSION" -b <block> ctrl+/                               # open and focus
rex send -s "$REX_SESSION" -b <block> $'\e[<0;8;6M\e[<0;8;6m'                  # click column 8, row 6
rex capture -s "$REX_SESSION" -b <block> | tail -n 36                          # the screen is the last `rows` lines
rex api call -s "$REX_SESSION" session.list_blocks '{}' | jq -c '.blocks[] | {block_id,label,placement}'
```

Do not send `/commands` to test Pis with `rex send`: one such `/reload` went to the model as a prompt.
To simulate a working Pi without a model call, make a detached block that has a `pi:<id>` label and prints OSC 7501:

```sh
rex api call -s "$REX_SESSION" session.new_block '{"flavor":"com.superlogical.terminal.shell","label":"pi:<session-id>",
  "options":{"shell":"none","command":["/bin/sh","-c","printf \"\\033]7501;state=working:app=pi\\033\\\\\"; sleep 600"]}}'
```

## Files

- `index.ts`: the extension (layout patch, view, switching, OSC 7501 reporter, seen marking).
- `refresher.ts`: the background poller that writes `snapshot.json`.
- `placeholder.sh`: the π in the `__pi__` tab.
- `tree.ts`: pure helpers (tree rows and sort order, row labels, last prompt, git grouping, reporter election, record IDs, the `__pi__` tab, Lua literals). They are tested in `tree.test.ts`.
