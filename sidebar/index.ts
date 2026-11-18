import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, HStack, matchesKey, type OverlayHandle, type OverlayOptions, type TuiMouseEvent, type TuiMouseEventResult, TuiAltScreen, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { actionAt, ALIVE_FILE, ARCHIVE_ICON, buildRows, CLOSE_ICON, electReporters, FORK_ICON, type Git, labelOf, lastPrompt, type Live, lua, PIN_ICON, refresherRuns, RELIST_FILE, type Row, rowClicks, type Session, shown, SNAPSHOT_FILE, type Snapshot, spins, STAGE, stageOf, STATE_FILE, statusId, TERM_ICON, toggleCollapsed, type View, windowOf, withSelf } from "./tree.ts";

// State is shared by every Pi, so a swapped-in Pi draws the same sidebar. seen holds when each
// session last got terminal focus, so a quitting Pi hands its slot to the most recently seen one.
type State = { open: boolean; width: number; collapsed: string[]; archived: string[]; pinned: string[]; seen: Record<string, number> };
const DEFAULT_STATE: State = { open: false, width: 34, collapsed: [], archived: [], pinned: [], seen: {} };
const REFRESHER = fileURLToPath(new URL("./refresher.ts", import.meta.url));
const PLACEHOLDER = fileURLToPath(new URL("./placeholder.sh", import.meta.url));

const SHELL = "com.superlogical.terminal.shell";
// PLACE_LUA runs a switch's Rex calls back to back in one script, so no other Pi's switch can
// interleave and no step is left half done by a slow process start. P is the switch: sid, me,
// target, anchor (the STAGE block to move target beside; nil: make the tab), staged (target is in
// STAGE already), old (other Pis left in STAGE).
const PLACE_LUA = `
rex.session.attach{ session_id = P.sid }
local function call(m, a)
  a.session_id = P.sid
  local r, e = rex.call(m, a)
  if e then error(m .. ": " .. e) end
  return r or {}
end
local anchor = P.anchor
if not anchor then
  local made = call("session.new_window", { window_label = "${STAGE}", focus = false, layout = { block = { flavor = "${SHELL}", label = "${STAGE}", options = { shell = "none", command = { "/bin/bash", "${PLACEHOLDER}" } } } } })
  anchor = made.block_ids[1]
end
if not P.staged then
  call("session.move_block", { block_id = P.target, anchor_block_id = anchor, direction = "horizontal", side = "after" })
end
call("session.swap_blocks", { block_id = P.me, other_block_id = P.target })
call("session.detach_block", { block_id = P.me })
for _, b in ipairs(P.old) do call("session.detach_block", { block_id = b }) end
call("session.focus_block", { block_id = P.target })
return {}
`;
const POLL_MS = 1500;
const SPIN_MS = 500;
const DOTS = ["   ", "•  ", "•• ", "•••", " ••", "  •"];

type Theme = { fg(token: string, s: string): string; bg(token: string, s: string): string; bold(s: string): string };
// SAFETY: pi-tui keeps these TS-private TuiAltScreen members as runtime properties.
type Screen = {
  layoutRoot?: Component;
  currentLayout?: unknown;
  terminal: { rows: number; columns: number; write(data: string): void; programStatus?: { state: string }; setProgramStatus(status: { state: string; app?: string }): void };
  requestRender(): void;
  getFocusedComponent(): Component | null;
  setFocus(component: Component | null): void;
  showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
};
type RawMouse = { x: number; y: number; button: number; release: boolean };
type ScreenProto = { doRender(this: Screen): void; handleMouseEvent(this: Screen, raw: RawMouse): void; handleViewportInput(this: Screen, data: string): unknown };

function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 10_000, maxBuffer: 8 << 20 }, (err, out) => (err ? reject(err) : resolve(out)));
    child.stdin?.end(input ?? "");
  });
}
const rexCall = async (method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const out = await run("rex", ["api", "call", method, JSON.stringify(args)]);
  return out.trim() ? JSON.parse(out) : {};
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (s: string) => Buffer.from(s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")).toString("base64");

// patch replaces obj[name] with make(original) and returns a restore. A restore under a later
// patch cannot unwire, so it turns the wrapper into a pass-through: after a reload, a buried
// wrapper must not touch its stale ctx. (Same as extensions/annotate.)
function patch<T, K extends keyof T>(obj: T, name: K, make: (original: T[K]) => T[K]): () => void {
  type Fn = (this: unknown, ...args: unknown[]) => unknown;
  const original = obj[name];
  const wrapped = make(original);
  let active = true;
  // SAFETY: every patched slot is a method, so original and wrapped are callable.
  const call = (fn: T[K], self: unknown, args: unknown[]) => (fn as unknown as Fn).apply(self, args);
  // SAFETY: patched has the slot's call signature; it forwards this and every argument.
  const patched = function (this: unknown, ...args: unknown[]) {
    return call(active ? wrapped : original, this, args);
  } as unknown as T[K];
  obj[name] = patched;
  return () => {
    active = false;
    if (obj[name] === patched) obj[name] = original;
  };
}

// devArgs are this Pi's -e flags, so a Pi the sidebar starts loads the same dev extensions.
function devArgs(): string[] {
  const argv = process.argv.slice(2);
  return argv.flatMap((a, i) => ((a === "-e" || a === "--extension") && argv[i + 1] ? [a, argv[i + 1]] : []));
}

// sidebar draws a Codex-style session navigator left of Pi's fullscreen layout. Rows come from
// Pi's session files and git; status and live blocks come from Rex. The refresher (refresher.ts)
// gathers all of it into one snapshot file; this extension only reads that file.
export default function sidebar(pi: ExtensionAPI): void {
  const rexSession = process.env.REX_SESSION;
  const rexBlock = process.env.REX_BLOCK;
  let ctx: ExtensionContext | undefined;
  let tui: Screen | undefined;
  let restore: (() => void)[] = [];
  let timers: ReturnType<typeof setInterval>[] = [];
  let state = DEFAULT_STATE;
  let stateMtime = -1;
  let sessions: Session[] = [];
  let git: Snapshot["git"] = {};
  let live = new Map<string, Live>();
  let snapMtime = -1;
  // placed is false while this Pi's block is detached: then the sidebar does no work.
  let placed = true;
  let reported = new Map<string, string>();
  // OSC 7501 `done` means "ready, and the user has not seen it". A Pi with terminal focus is seen,
  // so markSeen turns its done into idle. Pi's reporter sends done again after the next run.
  let focused = false;
  const markSeen = () => {
    if (focused && tui?.terminal.programStatus?.state === "done") tui.terminal.setProgramStatus({ state: "idle", app: "pi" });
  };
  let rows: Row[] = [];
  let cursor = 0;
  let top = 0;
  let frame = 0;
  let busy = false;
  const click = rowClicks();
  let returnFocus: Component | null = null;
  let piRoot: Component | undefined;
  let wrapped: { root: Component; width: number; stack: HStack } | undefined;

  const loadState = (): State => {
    try {
      const mtime = statSync(STATE_FILE).mtimeMs;
      if (mtime !== stateMtime) {
        state = { ...DEFAULT_STATE, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
        stateMtime = mtime;
      }
    } catch {
      // A missing or half-written file keeps the last state.
    }
    return state;
  };
  const saveState = (change: Partial<State>) => {
    const next = { ...loadState(), ...change };
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, STATE_FILE);
    state = next;
    stateMtime = statSync(STATE_FILE).mtimeMs;
    tui?.requestRender();
  };
  const notify = (msg: string, level: "info" | "warning" | "error" = "error") => ctx?.ui.notify(msg, level);

  const gitOf = (cwd: string): Git | undefined => git[cwd] ?? undefined;

  // startRefresher starts the background refresher unless one runs; its lock admits only one.
  const startRefresher = () => {
    if (refresherRuns()) return;
    // Pi's entry is dist/bundle/cli.js; SessionManager is exported from dist/index.js.
    const piIndex = join(dirname(dirname(realpathSync(process.argv[1]))), "index.js");
    spawn(process.execPath, [REFRESHER, piIndex], { detached: true, stdio: "ignore" }).unref();
  };

  // report re-emits detached Pis' status as child records of this terminal (OSC 7501), when
  // this Pi is their elected reporter. A record this Pi stops reporting is cleared.
  const report = (pis: Live[]) => {
    const next = new Map<string, string>();
    const mine = state.open && rexBlock ? (electReporters(pis).get(rexBlock) ?? []) : [];
    for (const sessionId of mine) {
      const rec = live.get(sessionId)?.root;
      if (!rec) continue;
      const id = statusId(sessionId);
      const found = sessions.find((s) => s.id === sessionId);
      const title = found ? labelOf(found) : sessionId;
      const pairs = [`state=${rec.state}`, `id=${id}`, "app=pi", `title=${b64(title.slice(0, 60))}`];
      if (rec.kind) pairs.push(`kind=${rec.kind}`);
      if (rec.msg) pairs.push(`msg=${b64(rec.msg.slice(0, 500))}`);
      next.set(id, `\x1b]7501;${pairs.join(":")}\x1b\\`);
    }
    for (const [id, seq] of next) if (reported.get(id) !== seq) tui?.terminal.write(seq);
    for (const id of reported.keys()) if (!next.has(id)) tui?.terminal.write(`\x1b]7501;state=clear:id=${id}\x1b\\`);
    reported = next;
  };

  // sync reads the refresher's snapshot when it changed. A closed sidebar reads nothing and clears
  // the records it reported.
  let syncing = false;
  const sync = async () => {
    if (syncing) return;
    if (!loadState().open) return reported.size ? report([]) : undefined;
    syncing = true;
    try {
      const now = new Date();
      try {
        utimesSync(ALIVE_FILE, now, now);
      } catch {
        writeFileSync(ALIVE_FILE, "");
      }
      startRefresher();
      const mtime = (await stat(SNAPSHOT_FILE)).mtimeMs;
      if (mtime === snapMtime) return;
      const snap: Snapshot = JSON.parse(await readFile(SNAPSHOT_FILE, "utf8"));
      snapMtime = mtime;
      ({ sessions, git } = snap);
      // A placed copy of a session wins over a detached one.
      live = new Map();
      for (const p of snap.pis) if (!live.get(p.sessionId)?.placed) live.set(p.sessionId, p);
      placed = snap.pis.find((p) => p.blockId === rexBlock)?.placed ?? true;
      report(snap.pis);
      if (placed) tui?.requestRender();
    } catch {
      // No snapshot yet, or a torn read: the next tick retries.
    } finally {
      syncing = false;
    }
  };

  // place swaps blockId into this Pi's slot through the STAGE tab:
  //  1. Move blockId into STAGE beside its placeholder. STAGE is never shown, so nothing shows.
  //  2. Swap this Pi with blockId across tabs.
  //  3. Detach this Pi, and any Pi a failed switch left in STAGE.
  //  4. Focus blockId.
  // A Pi keeps its last size on screen, and the slot is the same, so nothing reflows. A blockId
  // that already shows is only focused; in another tab, the Rex app is asked to show that tab.
  const place = async (blockId: string) => {
    const view = (await rexCall("session.view", { session_id: rexSession })) as View;
    // The snapshot lags a switch by up to a poll: only the view tells whether blockId shows now.
    if (shown(view, blockId)) {
      // The app shows the tab it selected, not the server's active window. With no app, focus is enough.
      const windowId = windowOf(view, blockId);
      if (windowId !== windowOf(view, rexBlock)) await showSession(rexSession as string, windowId).catch(() => {});
      return void (await rexCall("session.focus_block", { session_id: rexSession, block_id: blockId }));
    }
    await run("rex", ["do", "-", "--json"], placeScript(view, blockId));
  };
  // placeScript is the PLACE_LUA run that swaps blockId in for this Pi.
  const placeScript = (view: View, blockId: string) => {
    const stage = stageOf(view);
    const P = { sid: rexSession, me: rexBlock, target: blockId, anchor: stage?.anchor, staged: !!stage?.pis.includes(blockId), old: stage?.pis.filter((b) => b !== blockId) ?? [] };
    return `local P = ${lua(P)}\n${PLACE_LUA}`;
  };
  // handOff gives this Pi's slot to the most recently seen Pi at rest in this Rex session, so
  // quitting does not close the pane. It runs only while this Pi shows, and synchronously: Pi
  // exits right after its shutdown handlers.
  const handOff = () => {
    const call = (method: string, args: Record<string, unknown>) => JSON.parse(execFileSync("rex", ["api", "call", method, JSON.stringify(args)], { encoding: "utf8", timeout: 3000 }) || "{}");
    try {
      const view = call("session.view", { session_id: rexSession }) as View;
      if (!rexBlock || !shown(view, rexBlock)) return;
      const seen = loadState().seen;
      const blocks = call("session.list_blocks", { session_id: rexSession }).blocks as { block_id: string; label?: string }[];
      const rest = blocks.filter((b) => b.label?.startsWith("pi:") && b.block_id !== rexBlock && !shown(view, b.block_id));
      const next = rest.sort((a, b) => (seen[b.label?.slice(3) ?? ""] ?? 0) - (seen[a.label?.slice(3) ?? ""] ?? 0))[0];
      if (!next) return;
      execFileSync("rex", ["do", "-", "--json"], { input: placeScript(view, next.block_id), timeout: 3000 });
      // A shell that started this Pi stays behind in the now detached block: close it once Pi is gone.
      const args = JSON.stringify({ session_id: rexSession, block_id: rexBlock });
      spawn("sh", ["-c", `sleep 3; exec rex api call block.close '${args}'`], { detached: true, stdio: "ignore" }).unref();
    } catch {
      // Quitting must not fail on Rex.
    }
  };
  // showSession asks the user's Rex app to show another Rex session (needs Remote Control).
  const showSession = async (sessionId: string, windowId?: string) => {
    const list = (await rexCall("client.list", {})) as { clients?: { client_id: string; info?: { kind?: string }; session_ids?: string[] }[] };
    const app = list.clients?.find((c) => c.info?.kind === "app" && c.session_ids?.includes(sessionId)) ?? list.clients?.find((c) => c.info?.kind === "app");
    if (!app) throw new Error("no Rex app is connected");
    await rexCall("client.perform", { client_id: app.client_id, action: "session.select", args: { session_id: sessionId, ...(windowId ? { window_id: windowId } : {}) } });
  };
  // startPi starts this same Pi build with args in a detached block, waits until it labels
  // itself, then places it. A Pi that never comes up is closed, so no stray block is left.
  const startPi = async (cwd: string, args: string[]) => {
    const size = tui ? { columns: tui.terminal.columns, rows: tui.terminal.rows } : undefined;
    // The new Pi shares this Pi's state dir; Rex block options take no environment.
    const xdg = process.env.XDG_STATE_HOME ? ["/usr/bin/env", `XDG_STATE_HOME=${process.env.XDG_STATE_HOME}`] : [];
    const command = [...xdg, process.execPath, process.argv[1], ...devArgs(), ...args];
    // The login shell supplies the user's environment; the absolute command needs no PATH.
    const made = await rexCall("session.new_block", { session_id: rexSession, flavor: SHELL, label: "pi", options: { command, cwd, ...(size ? { size } : {}) } });
    const blockId = made.block_id as string;
    notify("Starting Pi…", "info");
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      const list = (await rexCall("session.list_blocks", { session_id: rexSession })) as { blocks?: { block_id: string; label?: string }[] };
      const b = list.blocks?.find((x) => x.block_id === blockId);
      if (!b) throw new Error("the new Pi exited");
      if (b.label?.startsWith("pi:")) return place(blockId);
    }
    await rexCall("block.close", { session_id: rexSession, block_id: blockId }).catch(() => {});
    throw new Error("the new Pi did not start in 20s");
  };
  const switchTo = async (s: Session) => {
    if (s.id === ctx?.sessionManager.getSessionId()) return;
    const target = live.get(s.id);
    if (!target) return startPi(s.cwd, ["--session", s.path]);
    if (target.rexSession === rexSession) return place(target.blockId);
    let windowId = target.windowId;
    if (!target.placed) {
      // A detached block needs a window: open one with a stand-in, move the block beside it, close the stand-in.
      const made = (await rexCall("session.new_window", { session_id: target.rexSession, layout: { block: { flavor: SHELL, options: { shell: "none", command: ["sleep", "30"] } } } })) as { window_id: string; block_ids: string[] };
      await rexCall("session.move_block", { session_id: target.rexSession, block_id: target.blockId, anchor_block_id: made.block_ids[0], side: "before" });
      await rexCall("block.close", { session_id: target.rexSession, block_id: made.block_ids[0] });
      windowId = made.window_id;
    }
    await showSession(target.rexSession, windowId);
    await rexCall("session.focus_block", { session_id: target.rexSession, block_id: target.blockId });
  };
  const act = (what: () => Promise<void>) => {
    if (!rexSession || !rexBlock) return notify("sidebar: switching needs Rex (REX_SESSION, REX_BLOCK)", "warning");
    if (busy) return notify("sidebar: still switching; try again in a moment", "info");
    busy = true;
    blur();
    what()
      .catch((err) => notify(`sidebar: ${err instanceof Error ? err.message : err}`))
      .finally(() => {
        busy = false;
        void sync();
      });
  };

  // Tooltip: the hovered session's last prompt, beside the sidebar. It needs hover (motion)
  // mouse events; without them no move event arrives and no tooltip shows.
  let hover: { path: string; row: number } | undefined;
  let tip: { path: string; row: number; handle: OverlayHandle } | undefined;
  const prompts = new Map<string, { mtime: number; text?: string }>();
  // ponytail: reads the whole session file once per change; read only its tail if big files make hover slow.
  const promptOf = async (path: string) => {
    const mtime = (await stat(path)).mtimeMs;
    const cached = prompts.get(path);
    if (cached?.mtime === mtime) return cached.text;
    const text = lastPrompt(await readFile(path, "utf8"));
    prompts.set(path, { mtime, text });
    return text;
  };
  const hideTip = () => {
    hover = undefined;
    tip?.handle.hide();
    tip = undefined;
  };
  const tipView = (text: string): Component => ({
    render(width: number): string[] {
      // SAFETY: Pi's theme accepts these token names; Theme only loosens their type.
      const theme = ctx?.ui.theme as unknown as Theme | undefined;
      const frame = (s: string) => (theme ? theme.fg("border", s) : s);
      const inner = Math.max(1, width - 4);
      const body = wrapTextWithAnsi(text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " "), inner);
      const shown = body.length > 6 ? [...body.slice(0, 5), "…"] : body;
      const rule = "─".repeat(Math.max(0, width - 2));
      return [frame(`╭${rule}╮`), ...shown.map((l) => `${frame("│")} ${l}${" ".repeat(Math.max(0, inner - visibleWidth(l)))} ${frame("│")}`), frame(`╰${rule}╯`)];
    },
    invalidate() {},
  });
  const hoverRow = (row: Row | undefined, screenRow: number) => {
    const path = row?.kind === "session" ? row.session.path : "";
    if (hover?.path === path && hover.row === screenRow) return;
    hideTip();
    if (!path) return;
    const want = { path, row: screenRow };
    hover = want;
    promptOf(path).then(
      (text) => {
        if (hover !== want || !text || !tui) return;
        const width = Math.min(60, tui.terminal.columns - state.width - 1);
        if (width < 12) return;
        tip = { ...want, handle: tui.showOverlay(tipView(text), { row: screenRow, col: state.width, width, nonCapturing: true }) };
      },
      () => {},
    );
  };
  const toggleFolder = (key: string, open?: boolean) => saveState({ collapsed: toggleCollapsed(loadState().collapsed, key, open) });
  const activate = (row?: Row) => {
    if (row?.kind === "folder") toggleFolder(row.key);
    else if (row?.kind === "session") act(() => switchTo(row.session));
    else if (row?.kind === "new") act(() => startPi(row.cwd, []));
  };

  // Row actions show at the right edge of the hovered row, and of the cursor row while focused.
  // Pinning a session un-archives it and archiving un-pins it, so it is never in both lists.
  const flip = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const pin = (id: string) => {
    const st = loadState();
    const pinned = flip(st.pinned, id);
    saveState({ pinned, archived: pinned.includes(id) ? st.archived.filter((x) => x !== id) : st.archived });
  };
  const archive = (id: string) => {
    const st = loadState();
    const archived = flip(st.archived, id);
    saveState({ archived, pinned: archived.includes(id) ? st.pinned.filter((x) => x !== id) : st.pinned });
  };
  // closePi closes another session's Pi block. Its session file stays, so the row stays. A run in
  // progress would be lost, so a working or blocked Pi asks first.
  const closePi = async (s: Session) => {
    const target = live.get(s.id);
    if (!target) return;
    const st = target.root?.state;
    if ((st === "working" || st === "blocked") && !(await ctx?.ui.confirm("Close Pi?", `${labelOf(s)} is ${st}. Closing it stops that run.`))) return;
    await rexCall("block.close", { session_id: target.rexSession, block_id: target.blockId });
    void sync();
  };
  // openShell opens a shell in cwd, in a split to the right of this Pi's block.
  const openShell = async (cwd: string) => {
    await rexCall("session.new_split", { session_id: rexSession, anchor_id: rexBlock, direction: "horizontal", side: "after", focus: true, layout: { block: { flavor: SHELL, options: { cwd } } } });
  };
  type Action = { icon: string; key: string; run: () => void };
  // actionsOf has a fixed slot per action, so icons keep their columns from row to row. The
  // close slot is empty for this Pi's own session and for sessions with no live Pi. A directory
  // folder opens a shell in it, from the pin's slot.
  const actionsOf = (row: Row | undefined): (Action | undefined)[] => {
    if (row?.kind === "folder") return row.cwd ? [{ icon: TERM_ICON, key: "t", run: () => act(() => openShell(row.cwd as string)) }, undefined, undefined] : [];
    if (row?.kind !== "session") return [];
    const s = row.session;
    return [
      { icon: PIN_ICON, key: "p", run: () => pin(s.id) },
      { icon: ARCHIVE_ICON, key: "a", run: () => archive(s.id) },
      live.has(s.id) && s.id !== ctx?.sessionManager.getSessionId()
        ? { icon: CLOSE_ICON, key: "x", run: () => void closePi(s).catch((err) => notify(`sidebar: ${err instanceof Error ? err.message : err}`)) }
        : undefined,
    ];
  };
  let hoverAt: number | undefined;
  let viewWidth = 0;

  const statusCell = (s: Session, theme: Theme): string => {
    if (s.id === ctx?.sessionManager.getSessionId()) return "   ";
    const rec = live.get(s.id)?.root;
    if (rec?.state === "working") return theme.fg("accent", DOTS[frame % DOTS.length]);
    if (rec?.state === "blocked") return theme.fg("warning", "  !");
    if (rec?.state === "error") return theme.fg("error", "  !");
    if (rec?.state === "done") return theme.fg("success", "  ●");
    return "   ";
  };
  const drawRow = (row: Row, width: number, theme: Theme, actions: boolean): string => {
    const pad = "  ".repeat(row.depth);
    let text: string;
    let status = "   ";
    if (row.kind === "folder") {
      text = `${pad}${row.open ? "▾" : "▸"} ${row.icon ? `${row.icon} ` : ""}${row.label}`;
      text = row.depth === 0 ? theme.bold(text) : text;
    } else if (row.kind === "new") {
      text = theme.fg("dim", `${pad}  + New`);
    } else {
      const label = `${pad}  ${row.fork ? `${FORK_ICON} ` : ""}${labelOf(row.session)}`;
      // This Pi's session in the accent color, other running ones bold, cold ones dim.
      if (row.session.id === ctx?.sessionManager.getSessionId()) text = theme.fg("accent", label);
      else text = live.has(row.session.id) ? theme.bold(label) : theme.fg("dim", label);
      status = statusCell(row.session, theme);
    }
    if (actions && actionsOf(row).length) status = theme.fg("muted", actionsOf(row).map((a) => `  ${a?.icon ?? " "}`).join(""));
    const right = visibleWidth(status);
    const left = truncateToWidth(text, Math.max(1, width - right), "…");
    return `${left}${" ".repeat(Math.max(0, width - right - visibleWidth(left)))}${status}`;
  };

  // view is the sidebar column. It takes keys only while focused (ctrl+/), and clicks always.
  const view: Component & { focused: boolean; capturesViewportInput: boolean } = {
    focused: false,
    capturesViewportInput: true,
    render(width: number): string[] {
      const st = loadState();
      // SAFETY: Pi's theme accepts these token names; Theme only loosens their type.
      const theme = ctx?.ui.theme as unknown as Theme | undefined;
      // This Pi's own row uses its live session name; the snapshot lists sessions every 10 s.
      const sm = ctx?.sessionManager;
      const self = sm && { id: sm.getSessionId(), path: sm.getSessionFile() ?? "", cwd: sm.getCwd(), name: sm.getSessionName(), created: Date.now(), modified: Date.now() };
      rows = buildRows(self ? withSelf(sessions, self) : sessions, gitOf, { collapsed: new Set(st.collapsed), archived: new Set(st.archived), pinned: new Set(st.pinned), live: new Set(live.keys()) }, Date.now());
      const height = tui?.terminal.rows ?? rows.length;
      cursor = Math.max(0, Math.min(cursor, rows.length - 1));
      if (cursor < top) top = cursor;
      if (cursor >= top + height) top = cursor - height + 1;
      top = Math.max(0, Math.min(top, rows.length - height));
      const inner = Math.max(4, width - 1);
      viewWidth = inner;
      const border = theme ? theme.fg("border", "│") : "│";
      const lines: string[] = [];
      for (let i = 0; i < height; i++) {
        const row = rows[top + i];
        const at = top + i;
        let line = row && theme ? drawRow(row, inner, theme, at === hoverAt || (this.focused && at === cursor)) : " ".repeat(inner);
        if (row && this.focused && top + i === cursor && theme) line = theme.bg("selectedBg", line);
        lines.push(`${line}${border}`);
      }
      return lines;
    },
    handleInput(data: string): void {
      const row = rows[cursor];
      if (matchesKey(data, "ctrl+/")) return toggle();
      if (matchesKey(data, "escape")) return blur();
      if (matchesKey(data, "up") || data === "k") cursor = Math.max(0, cursor - 1);
      else if (matchesKey(data, "down") || data === "j") cursor = Math.min(rows.length - 1, cursor + 1);
      else if (matchesKey(data, "enter") || data === " ") activate(row);
      else if (matchesKey(data, "right") || data === "l") row?.kind === "folder" && toggleFolder(row.key, true);
      else if (matchesKey(data, "left") || data === "h") {
        if (row?.kind === "folder" && row.open) toggleFolder(row.key, false);
        else for (let i = cursor - 1; i >= 0; i--) if (rows[i].kind === "folder" && rows[i].depth < (row?.depth ?? 0)) return void (cursor = i, tui?.requestRender());
      } else actionsOf(row).find((a) => a?.key === data)?.run();
      tui?.requestRender();
    },
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
      if (event.type === "move") {
        hoverRow(rows[top + event.y], event.screenY);
        const was = hoverAt;
        hoverAt = top + event.y;
        return { handled: true, render: hoverAt !== was };
      }
      hideTip();
      if (event.type === "wheel") top = Math.max(0, top + Math.sign(event.wheelDelta ?? 0) * 3);
      const hit = event.button === "left" ? click(event.type, top + event.y) : undefined;
      if (hit !== undefined) {
        cursor = hit;
        const row = rows[cursor];
        const actions = hit === hoverAt ? actionsOf(row) : [];
        const i = actionAt(event.x, viewWidth, actions.length);
        if (i !== undefined) actions[i]?.run();
        else activate(row);
      }
      return { handled: true };
    },
    invalidate(): void {},
  };

  const blur = () => {
    if (tui && view.focused) tui.setFocus(returnFocus);
    returnFocus = null;
  };
  const focus = () => {
    if (!tui || view.focused) return;
    returnFocus = tui.getFocusedComponent();
    const current = rows.findIndex((r) => r.kind === "session" && r.session.id === ctx?.sessionManager.getSessionId());
    if (current >= 0) cursor = current;
    tui.setFocus(view);
  };
  // toggle: closed -> open and focused; open -> focused; focused -> closed.
  function toggle() {
    const st = loadState();
    if (!st.open) {
      saveState({ open: true });
      void sync();
      return focus();
    }
    if (!view.focused) return focus();
    blur();
    saveState({ open: false });
  }

  pi.registerShortcut("ctrl+/", { description: "Toggle the session sidebar", handler: () => toggle() });
  pi.registerCommand("sidebar", {
    description: "Toggle the session sidebar; `/sidebar width N` sets its width",
    handler: async (args) => {
      const width = /^width\s+(\d+)$/.exec(args.trim())?.[1];
      if (width) return saveState({ width: Math.max(16, Math.min(80, Number(width))) });
      toggle();
    },
  });

  pi.on("session_start", (_event, c) => {
    for (const r of restore) r();
    restore = [];
    if (c.mode !== "tui") return;
    ctx = c;
    // SAFETY: the cast names a prototype slot of the public TuiAltScreen; Screen lists the private fields used.
    const screen = TuiAltScreen.prototype as unknown as ScreenProto;
    restore = [
      // Every frame: wrap Pi's root as HStack([sidebar, root]) while open, and re-wrap after Pi sets a new root.
      patch(screen, "doRender", (original) =>
        function (this: Screen) {
          tui = this;
          const current = this.layoutRoot;
          if (current !== wrapped?.stack) piRoot = current;
          const st = loadState();
          let want = piRoot;
          if (st.open && piRoot && this.terminal.columns >= st.width + 40) {
            if (wrapped?.root !== piRoot || wrapped.width !== st.width) {
              const stack = new HStack([
                { component: view, basis: st.width, shrink: 0 },
                { component: piRoot, basis: 0, grow: 1 },
              ]);
              wrapped = { root: piRoot, width: st.width, stack };
            }
            want = wrapped.stack;
          }
          if (current !== want) {
            if (!want || want === piRoot) blur();
            this.layoutRoot = want;
            this.currentLayout = undefined;
          }
          original.call(this);
        },
      ),
      // A pointer that leaves the sidebar drops the tooltip before the event reaches what is under it.
      patch(screen, "handleMouseEvent", (original) =>
        function (this: Screen, raw: RawMouse) {
          if (!state.open || raw.x >= state.width) {
            if (hover) hideTip();
            if (hoverAt !== undefined) {
              hoverAt = undefined;
              this.requestRender();
            }
          }
          original.call(this, raw);
        },
      ),
      // Focus reports (ESC[I, ESC[O) reach pi-tui here; it turns them on with the alt screen.
      patch(screen, "handleViewportInput", (original) =>
        function (this: Screen, data: string) {
          if (data === "\x1b[I" || data === "\x1b[O") {
            focused = data === "\x1b[I";
            markSeen();
            const id = ctx?.sessionManager.getSessionId();
            if (focused && id) saveState({ seen: { ...loadState().seen, [id]: Date.now() } });
          }
          return original.call(this, data);
        },
      ),
    ];
    // The label tells the sidebar this Pi is live. It is set after the first snapshot read, so a
    // Pi the sidebar starts is swapped in with its tree already drawn.
    void sync().then(() => {
      if (ctx !== c || !rexSession || !rexBlock) return;
      rexCall("session.set_block_label", { session_id: rexSession, block_id: rexBlock, label: `pi:${c.sessionManager.getSessionId()}` }).catch(() => {});
    });
    timers = [
      setInterval(() => void sync(), POLL_MS),
      // The dots animate only on screen, and only for another working session the sidebar shows.
      setInterval(() => {
        if (!state.open || !placed || !spins(rows, ctx?.sessionManager.getSessionId(), (id) => live.get(id)?.root?.state === "working")) return;
        frame++;
        tui?.requestRender();
      }, SPIN_MS),
    ];
  });

  // A run that settles while this Pi has focus is seen at once. Pi's reporter handles the same
  // event in its own listener; setImmediate runs after it.
  pi.on("agent_settled", () => void setImmediate(markSeen));

  // A rename pokes the refresher, so other Pis' sidebars show the new name on its next poll.
  pi.on("session_info_changed", () => {
    try {
      writeFileSync(RELIST_FILE, "");
    } catch {
      // No sidebar ever ran: there is no state dir and no refresher to poke.
    }
  });

  pi.on("session_shutdown", (event) => {
    for (const t of timers) clearInterval(t);
    timers = [];
    blur();
    hideTip();
    state = { ...state, open: false };
    report([]);
    for (const r of restore) r();
    restore = [];
    if (tui && tui.layoutRoot === wrapped?.stack) {
      tui.layoutRoot = piRoot;
      tui.currentLayout = undefined;
      tui.requestRender();
    }
    wrapped = undefined;
    // A shell left in this block after Pi quits must not look like a live Pi.
    if (event.reason === "quit" && rexSession && rexBlock) {
      handOff();
      try {
        execFileSync("rex", ["api", "call", "session.set_block_label", JSON.stringify({ session_id: rexSession, block_id: rexBlock, label: "" })], { timeout: 2000 });
      } catch {
        // Quitting must not fail on Rex.
      }
    }
    ctx = undefined;
  });
}
