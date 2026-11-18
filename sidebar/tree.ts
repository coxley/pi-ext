import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// Files shared by every Pi and the refresher.
export const STATE_DIR = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "pi-sidebar");
export const STATE_FILE = join(STATE_DIR, "state.json");
export const SNAPSHOT_FILE = join(STATE_DIR, "snapshot.json");
export const LOCK_FILE = join(STATE_DIR, "refresher.pid");
// ALIVE_FILE is touched by every Pi whose sidebar is open, on each sync; the refresher exits when it goes stale.
export const ALIVE_FILE = join(STATE_DIR, "alive");
// RELIST_FILE is touched by a Pi that renames its session; the refresher then lists sessions on its next poll.
export const RELIST_FILE = join(STATE_DIR, "relist");

// Session is the part of Pi's SessionInfo the sidebar draws. created is the header timestamp.
export type Session = { id: string; path: string; cwd: string; name?: string; created: number; modified: number; parentPath?: string };
// Git is `git rev-parse --git-common-dir --git-dir --show-toplevel` for one cwd, as absolute paths.
export type Git = { commonDir: string; gitDir: string; top: string };
export type Row =
  | { kind: "folder"; depth: number; key: string; icon: string; label: string; open: boolean; cwd?: string }
  | { kind: "session"; depth: number; session: Session; fork: boolean }
  | { kind: "new"; depth: number; cwd: string };
// live holds the ids of sessions a Pi runs now; they sort first and draw brighter. pinned
// sessions also show in a section on top. The Archived section starts collapsed: its key in
// collapsed means open.
export type TreeState = { collapsed: ReadonlySet<string>; archived: ReadonlySet<string>; pinned?: ReadonlySet<string>; live?: ReadonlySet<string> };

export const ARCHIVE_AFTER_MS = 14 * 24 * 3600 * 1000;
export const REPO_ICON = "\uea62";
export const DIR_ICON = "\uf07b";
export const FORK_ICON = "\ue725";
export const PIN_ICON = "\uf08d";
export const ARCHIVE_ICON = "\uf187";
export const CLOSE_ICON = "\uf011";
export const TERM_ICON = "\u{F018D}";

// ACTION_SLOT is the width of one action slot: two spaces, then the icon.
export const ACTION_SLOT = 3;
// actionAt maps column x of a row width columns wide to the index of one of n action slots, drawn
// right-aligned, or undefined when x is left of them.
export const actionAt = (x: number, width: number, n: number) => (x >= width - ACTION_SLOT * n && x < width ? Math.floor((x - (width - ACTION_SLOT * n)) / ACTION_SLOT) : undefined);

// toggleCollapsed opens or closes folder key (flips it when open is undefined) in a collapsed
// list. The Archived section starts collapsed: its key in the list means open.
export function toggleCollapsed(collapsed: string[], key: string, open?: boolean): string[] {
  const inverted = key === "archived";
  const want = open ?? collapsed.includes(key) !== inverted;
  const rest = collapsed.filter((k) => k !== key);
  return want === inverted ? [...rest, key] : rest;
}

type Folder = { key: string; icon: string; label: string; cwd: string; sessions: Session[]; subs: Map<string, Folder> };

// parseGit reads the three lines of rev-parse output; anything else means "not a git dir".
export function parseGit(stdout: string): Git | undefined {
  const [commonDir, gitDir, top] = stdout.trim().split("\n");
  return commonDir && gitDir && top ? { commonDir, gitDir, top } : undefined;
}

// repoRoot is the main worktree of a repo: the parent of `<repo>/.git`, or a bare repo itself.
const repoRoot = (commonDir: string) => (basename(commonDir) === ".git" ? dirname(commonDir) : commonDir);

// labelOf is the session's title (`/name`, `--name`, or setSessionName), else its short ID: the
// random tail of its UUIDv7, since the head is a timestamp that nearby sessions share.
export const labelOf = (s: Session) => s.name?.trim() || s.id.slice(-8);

// lastPrompt is the text of the last user message in a session file's JSONL.
export function lastPrompt(jsonl: string): string | undefined {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"role":"user"')) continue;
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      const content = entry.message.content;
      const text = typeof content === "string" ? content : (content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
      if (text.trim()) return text.trim();
    } catch {
      // A torn last line is skipped.
    }
  }
  return undefined;
}

// buildRows groups visible sessions as repo -> (worktree ->) sessions, or dir -> sessions, puts
// forks under their parent session, and flattens the tree to rows. Folders with the newest
// activity sort first; sessions and forks sort by creation time, newest first. Pinned sessions
// come first in their own section (and stay in the tree, even when stale); archived sessions
// come last in theirs.
export function buildRows(sessions: Session[], gitOf: (cwd: string) => Git | undefined, state: TreeState, now: number): Row[] {
  const pinned = state.pinned ?? new Set<string>();
  const shown = sessions.filter((s) => !state.archived.has(s.id) && (pinned.has(s.id) || now - s.modified <= ARCHIVE_AFTER_MS));
  const byPath = new Map(shown.map((s) => [s.path, s]));
  const children = new Map<string, Session[]>();
  const top = new Map<string, Folder>();
  const folder = (map: Map<string, Folder>, key: string, icon: string, label: string, cwd: string) => {
    const found = map.get(key) ?? { key, icon, label, cwd, sessions: [], subs: new Map() };
    map.set(key, found);
    return found;
  };
  for (const s of shown) {
    if (s.parentPath && byPath.has(s.parentPath)) {
      children.set(s.parentPath, [...(children.get(s.parentPath) ?? []), s]);
      continue;
    }
    const git = gitOf(s.cwd);
    if (!git) {
      folder(top, `dir:${s.cwd}`, DIR_ICON, basename(s.cwd) || s.cwd, s.cwd).sessions.push(s);
      continue;
    }
    const root = repoRoot(git.commonDir);
    const repo = folder(top, `repo:${git.commonDir}`, REPO_ICON, basename(root), root);
    if (git.gitDir === git.commonDir) repo.sessions.push(s);
    else folder(repo.subs, `wt:${git.gitDir}`, "", basename(git.top), git.top).sessions.push(s);
  }

  // latest is the newest activity in a folder, its sub-folders, and its forks.
  const latestOf = (s: Session): number => Math.max(s.modified, ...(children.get(s.path) ?? []).map(latestOf));
  const latest = (f: Folder): number => Math.max(0, ...f.sessions.map(latestOf), ...[...f.subs.values()].map(latest));
  const newestFirst = <T>(items: T[], at: (item: T) => number) => [...items].sort((a, b) => at(b) - at(a));
  // Live sessions first, then newest first.
  const order = (items: Session[]) => [...items].sort((a, b) => Number(!!state.live?.has(b.id)) - Number(!!state.live?.has(a.id)) || b.created - a.created);

  const rows: Row[] = [];
  const section = (key: string, icon: string, label: string, open: boolean, list: Session[]) => {
    if (!list.length) return;
    rows.push({ kind: "folder", depth: 0, key, icon, label, open });
    if (open) for (const s of list) rows.push({ kind: "session", depth: 1, session: s, fork: false });
  };
  section("pinned", PIN_ICON, "Pinned", !state.collapsed.has("pinned"), order(shown.filter((s) => pinned.has(s.id))));
  const addSession = (s: Session, depth: number, fork: boolean) => {
    rows.push({ kind: "session", depth, session: s, fork });
    for (const child of order(children.get(s.path) ?? [])) addSession(child, depth + 1, true);
  };
  const addFolder = (f: Folder, depth: number) => {
    const open = !state.collapsed.has(f.key);
    rows.push({ kind: "folder", depth, key: f.key, icon: f.icon, label: f.label, open, cwd: f.cwd });
    if (!open) return;
    for (const sub of newestFirst([...f.subs.values()], latest)) addFolder(sub, depth + 1);
    for (const s of order(f.sessions)) addSession(s, depth + 1, false);
    rows.push({ kind: "new", depth: depth + 1, cwd: f.cwd });
  };
  // Top-level folders sort by name, so opening a session never moves them; the key splits equal names.
  const byName = (a: Folder, b: Folder) => a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }) || (a.key < b.key ? -1 : 1);
  for (const f of [...top.values()].sort(byName)) addFolder(f, 0);
  section("archived", ARCHIVE_ICON, "Archived", state.collapsed.has("archived"), newestFirst(sessions.filter((s) => state.archived.has(s.id)), (s) => s.modified));
  return rows;
}

// PiBlock is a Rex block whose Pi labeled it `pi:<sessionId>`. placed means it shows: it is in a
// window and not in a minimized layer.
export type PiBlock = { blockId: string; rexSession: string; sessionId: string; placed: boolean };
// Rec is one OSC 7501 record as Rex's program_status returns it (msg is decoded text).
export type Rec = { id?: string; state: string; kind?: string; msg?: string };
export type Live = PiBlock & { windowId?: string; root?: Rec };
// Snapshot is the refresher's output. git caches every cwd ever seen (null: not a git dir).
export type Snapshot = { sessions: Session[]; git: Record<string, Git | null>; pis: Live[] };

// withSelf puts this Pi's own session into a listed snapshot with its live name, so a rename
// shows at once. A session with no file yet (no reply so far) is not listed: self is added.
export const withSelf = (sessions: Session[], self: Session) =>
  sessions.some((s) => s.id === self.id) ? sessions.map((s) => (s.id === self.id ? { ...s, name: self.name } : s)) : [...sessions, self];

// unknownCwds lists the session dirs the git cache has never seen, each once.
export const unknownCwds = (sessions: Session[], git: Snapshot["git"]) => [...new Set(sessions.map((s) => s.cwd))].filter((cwd) => !(cwd in git));

// spins tells whether the sidebar shows another session that is working, so its dots animate.
export const spins = (rows: Row[], self: string | undefined, working: (sessionId: string) => boolean) =>
  rows.some((r) => r.kind === "session" && r.session.id !== self && working(r.session.id));

// rowClicks turns a press and a release on one row into a click on that row, even when the pointer
// moves in between: pi-tui's own click event is lost on a one-cell move.
export function rowClicks(): (type: string, row: number) => number | undefined {
  let pressed: number | undefined;
  return (type, row) => {
    if (type === "press") pressed = row;
    if (type !== "release") return undefined;
    const hit = pressed === row ? row : undefined;
    pressed = undefined;
    return hit;
  };
}

// LOCK_STALE_MS is how long a refresher may go without touching LOCK_FILE before another replaces it.
export const LOCK_STALE_MS = 10_000;
// refresherRuns tells whether a refresher touched LOCK_FILE recently. A heartbeat, unlike a pid
// check, also catches a hung refresher and a recycled pid.
export function refresherRuns(now = Date.now()): boolean {
  try {
    return now - statSync(LOCK_FILE).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

// electReporters maps each reporter block to the detached Pi sessions it reports. A placed Pi
// reports itself. A detached Pi is reported by the lowest-ID placed Pi in its Rex session, else
// by the lowest-ID placed Pi on the server. Only blocks of Pis with the sidebar open are passed in.
export function electReporters(blocks: PiBlock[]): Map<string, string[]> {
  const placed = blocks.filter((b) => b.placed).sort((a, b) => (a.blockId < b.blockId ? -1 : 1));
  const out = new Map<string, string[]>();
  const placedSessions = new Set(placed.map((b) => b.sessionId));
  for (const b of blocks) {
    if (b.placed || placedSessions.has(b.sessionId)) continue;
    const reporter = placed.find((p) => p.rexSession === b.rexSession) ?? placed[0];
    if (reporter) out.set(reporter.blockId, [...(out.get(reporter.blockId) ?? []), b.sessionId]);
  }
  return out;
}

// statusId is the OSC 7501 record id for a session: a segment holds 32 chars, a UUID without dashes fits.
export const statusId = (sessionId: string) => `session/${sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 32)}`;

// View is the part of Rex's session.view output a switch reads.
export type View = { windows?: { window_id: string; label?: string; layers?: { layer_id: string; kind: string; state?: string; blocks?: { block_id: string; label?: string }[] }[] }[] };

// STAGE labels the one tab per Rex session where a switch swaps Pis: an incoming Pi is moved in
// beside the placeholder, swapped across tabs, and the outgoing Pi is detached from it.
export const STAGE = "__pi__";

// stageOf finds the STAGE tab: its window, the block to move an incoming Pi beside (the
// placeholder, else any block), and the Pis left in it.
export function stageOf(view: View): { windowId: string; anchor: string; pis: string[] } | undefined {
  const w = view.windows?.find((x) => x.label === STAGE);
  const blocks = (w?.layers ?? []).flatMap((l) => l.blocks ?? []);
  if (!w || !blocks.length) return undefined;
  const pi = (b: { label?: string }) => b.label?.startsWith("pi:");
  return { windowId: w.window_id, anchor: (blocks.find((b) => !pi(b)) ?? blocks[0]).block_id, pis: blocks.filter(pi).map((b) => b.block_id) };
}

// shown tells whether blockId is in a window other than STAGE and not in a minimized layer.
export const shown = (view: View, blockId: string) =>
  (view.windows ?? []).some((w) => w.label !== STAGE && (w.layers ?? []).some((l) => l.state !== "minimized" && (l.blocks ?? []).some((b) => b.block_id === blockId)));

// windowOf returns the ID of the window that holds blockId, or undefined for a detached block.
export const windowOf = (view: View, blockId: string | undefined) =>
  view.windows?.find((w) => (w.layers ?? []).some((l) => (l.blocks ?? []).some((b) => b.block_id === blockId)))?.window_id;

// lua writes a JSON-like value as a Lua table literal; undefined and null become nil. Strings use
// JSON escapes, which Lua reads the same for the plain ASCII of Rex IDs.
export function lua(v: unknown): string {
  if (v === undefined || v === null) return "nil";
  if (Array.isArray(v)) return `{${v.map(lua).join(",")}}`;
  if (typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `[${JSON.stringify(k)}]=${lua(x)}`).join(",")}}`;
  return JSON.stringify(v);
}
