import assert from "node:assert/strict";
import { test } from "node:test";
import { actionAt, ARCHIVE_AFTER_MS, buildRows, electReporters, type Git, labelOf, lastPrompt, parseGit, type Row, rowClicks, type Session, lua, shown, spins, stageOf, statusId, toggleCollapsed, unknownCwds, windowOf, withSelf } from "./tree.ts";

const NOW = 1_000 * ARCHIVE_AFTER_MS;
const s = (id: string, cwd: string, ageMs: number, extra: Partial<Session> = {}): Session => ({ id, path: `/s/${id}.jsonl`, cwd, created: NOW - ageMs, modified: NOW - ageMs, ...extra });
const GIT: Record<string, Git> = {
  "/r/app": { commonDir: "/r/app/.git", gitDir: "/r/app/.git", top: "/r/app" },
  "/r/app/sub": { commonDir: "/r/app/.git", gitDir: "/r/app/.git", top: "/r/app" },
  "/w/app-2": { commonDir: "/r/app/.git", gitDir: "/r/app/.git/worktrees/app-2", top: "/w/app-2" },
};
const show = (rows: Row[]) =>
  rows.map((r) => {
    const pad = "  ".repeat(r.depth);
    if (r.kind === "folder") return `${pad}${r.open ? "v" : ">"} ${r.icon}${r.label}`;
    if (r.kind === "new") return `${pad}+ ${r.cwd}`;
    return `${pad}${r.fork ? "fork " : ""}${r.session.id}`;
  });
const none = { collapsed: new Set<string>(), archived: new Set<string>() };

test("unknownCwds lists each dir the git cache has never seen, non-git dirs included once known", () => {
  const sessions = [s("a", "/r/app", 0), s("b", "/r/app", 0), s("c", "/tmp/x", 0), s("d", "/w/app-2", 0)];
  assert.deepEqual(unknownCwds(sessions, {}), ["/r/app", "/tmp/x", "/w/app-2"]);
  assert.deepEqual(unknownCwds(sessions, { "/r/app": GIT["/r/app"], "/tmp/x": null }), ["/w/app-2"]);
});

test("spins only for another shown session that is working, never for this Pi's own", () => {
  const rows = buildRows([s("self", "/tmp/x", 0), s("other", "/tmp/x", 0)], () => undefined, none, NOW);
  assert.equal(spins(rows, "self", (id) => id === "self"), false, "this Pi working does not redraw it");
  assert.equal(spins(rows, "self", (id) => id === "other"), true);
  const collapsed = buildRows([s("other", "/tmp/x", 0)], () => undefined, { ...none, collapsed: new Set(["dir:/tmp/x"]) }, NOW);
  assert.equal(spins(collapsed, "self", () => true), false, "a collapsed folder shows no dots");
});

test("rowClicks: a press and a release on one row is a click, even when the pointer moves between", () => {
  const click = rowClicks();
  assert.equal(click("press", 3), undefined);
  assert.equal(click("drag", 3), undefined, "a one-cell move on the row");
  assert.equal(click("release", 3), 3);
  click("press", 3);
  assert.equal(click("release", 4), undefined, "a release on another row is no click");
  assert.equal(click("release", 4), undefined, "nor is a release with no press");
});

test("buildRows puts live sessions first in their folder and under their parent, then newest first", () => {
  const parent = s("p", "/tmp/x", 9);
  const sessions = [s("new", "/tmp/x", 1), s("old-live", "/tmp/x", 5), parent, s("fork-new", "/tmp/x", 2, { parentPath: parent.path }), s("fork-live", "/tmp/x", 4, { parentPath: parent.path })];
  const live = new Set(["old-live", "p", "fork-live"]);
  assert.deepEqual(show(buildRows(sessions, () => undefined, { ...none, live }, NOW)), ["v \uf07bx", "  old-live", "  p", "    fork fork-live", "    fork fork-new", "  new", "  + /tmp/x"]);
});

test("buildRows groups repo, worktree, and plain dirs: top-level folders by name, the rest newest first", () => {
  const sessions = [s("a", "/r/app", 5), s("b", "/r/app/sub", 1), s("c", "/w/app-2", 3), s("d", "/tmp/x", 0), s("e", "/q/Beta", 0)];
  assert.deepEqual(show(buildRows(sessions, (cwd) => GIT[cwd], none, NOW)), [
    "v \uea62app",
    "  v app-2",
    "    c",
    "    + /w/app-2",
    "  b",
    "  a",
    "  + /r/app",
    "v \uf07bBeta",
    "  e",
    "  + /q/Beta",
    "v \uf07bx",
    "  d",
    "  + /tmp/x",
  ]);
});

test("buildRows nests forks under their parent and hides archived and stale sessions", () => {
  const sessions = [
    s("p", "/tmp/x", 9),
    s("f", "/other", 1, { parentPath: "/s/p.jsonl" }),
    s("old", "/tmp/x", ARCHIVE_AFTER_MS + 1),
    s("gone", "/tmp/x", 1),
    s("orphan", "/tmp/x", 2, { parentPath: "/s/old.jsonl" }),
  ];
  const rows = buildRows(sessions, () => undefined, { collapsed: new Set(), archived: new Set(["gone"]) }, NOW);
  assert.deepEqual(show(rows), ["v \uf07bx", "  orphan", "  p", "    fork f", "  + /tmp/x", "> \uf187Archived"]);
});

test("buildRows sorts sessions and forks by creation time, not by last activity", () => {
  const sessions = [
    s("old-busy", "/tmp/x", 1, { created: NOW - 50 }),
    s("new-idle", "/tmp/x", 40, { created: NOW - 40 }),
    s("fork-old", "/tmp/x", 1, { created: NOW - 30, parentPath: "/s/new-idle.jsonl" }),
    s("fork-new", "/tmp/x", 20, { created: NOW - 20, parentPath: "/s/new-idle.jsonl" }),
  ];
  assert.deepEqual(show(buildRows(sessions, () => undefined, none, NOW)), ["v \uf07bx", "  new-idle", "    fork fork-new", "    fork fork-old", "  old-busy", "  + /tmp/x"]);
});

test("labelOf shows the session title, else the short ID, never a prompt", () => {
  // UUIDv7: the first 8 hex digits are the timestamp, so sessions of one minute share them.
  const [a, b] = ["01a1c5fe-23d6-7a60-bf3a-3c10dbf01146", "01a1c5fe-9f00-7b11-8e2e-486a05189ba8"];
  assert.equal(labelOf(s(a, "/x", 0, { name: " Fix login " })), "Fix login");
  assert.equal(labelOf(s(a, "/x", 0, { name: "  " })), "dbf01146");
  assert.equal(labelOf(s(b, "/x", 0)), "05189ba8", "two sessions of one minute get distinct short IDs");
});

test("lastPrompt returns the last user message text", () => {
  const msg = (role: string, content: unknown) => JSON.stringify({ type: "message", message: { role, content } });
  const jsonl = [
    JSON.stringify({ type: "session", id: "x" }),
    msg("user", [{ type: "text", text: "first" }]),
    msg("user", [{ type: "image" }, { type: "text", text: " second " }]),
    msg("assistant", [{ type: "text", text: "reply" }]),
    '{"type":"message","message":{"role":"user"', // torn write
  ].join("\n");
  assert.equal(lastPrompt(jsonl), "second");
  assert.equal(lastPrompt(msg("user", "plain")), "plain");
  assert.equal(lastPrompt(""), undefined);
});

test("buildRows hides the children of a collapsed folder", () => {
  const rows = buildRows([s("a", "/r/app", 1)], (cwd) => GIT[cwd], { collapsed: new Set(["repo:/r/app/.git"]), archived: new Set() }, NOW);
  assert.deepEqual(show(rows), ["> \uea62app"]);
});

test("buildRows lists pinned sessions on top and in the tree, and archived ones in a section that starts collapsed", () => {
  const sessions = [s("a", "/tmp/x", 2), s("b", "/tmp/x", 1), s("old", "/tmp/x", ARCHIVE_AFTER_MS + 1), s("z", "/tmp/x", 3)];
  const state = { collapsed: new Set<string>(), archived: new Set(["z"]), pinned: new Set(["b", "old"]) };
  const rows = show(buildRows(sessions, () => undefined, state, NOW));
  assert.deepEqual(rows, ["v \uf08dPinned", "  b", "  old", "v \uf07bx", "  b", "  a", "  old", "  + /tmp/x", "> \uf187Archived"]);
  const open = show(buildRows(sessions, () => undefined, { ...state, collapsed: new Set(["archived"]) }, NOW));
  assert.deepEqual(open.slice(-2), ["v \uf187Archived", "  z"]);
});

test("actionAt maps a column to the right-aligned icon slot under it", () => {
  // width 12, 3 slots: "  a" at 3-5, "  b" at 6-8, "  c" at 9-11.
  assert.deepEqual([2, 3, 5, 6, 9, 11, 12].map((x) => actionAt(x, 12, 3)), [undefined, 0, 0, 1, 2, 2, undefined]);
});

test("toggleCollapsed flips a folder, and the Archived section opens from its collapsed default", () => {
  assert.deepEqual(toggleCollapsed([], "repo:x"), ["repo:x"], "an open folder closes");
  assert.deepEqual(toggleCollapsed(["repo:x"], "repo:x"), []);
  assert.deepEqual(toggleCollapsed([], "archived"), ["archived"], "Archived opens");
  assert.deepEqual(toggleCollapsed(["archived"], "archived"), []);
  assert.deepEqual(toggleCollapsed([], "archived", false), [], "closing a closed Archived keeps it closed");
  assert.deepEqual(toggleCollapsed([], "repo:x", true), [], "opening an open folder keeps it open");
});

test("parseGit needs all three paths", () => {
  assert.deepEqual(parseGit("/r/.git\n/r/.git\n/r\n"), { commonDir: "/r/.git", gitDir: "/r/.git", top: "/r" });
  assert.equal(parseGit(""), undefined);
});

test("electReporters: same Rex session first, then the whole server, lowest block ID wins", () => {
  const b = (blockId: string, rexSession: string, sessionId: string, placed: boolean) => ({ blockId, rexSession, sessionId, placed });
  const out = electReporters([
    b("block:3", "rs:A", "s1", true),
    b("block:2", "rs:A", "s2", true),
    b("block:9", "rs:A", "d1", false),
    b("block:5", "rs:B", "d2", false),
    b("block:1", "rs:C", "s3", true),
    b("block:8", "rs:A", "s1", false), // a second, detached copy of a placed session reports nothing
  ]);
  assert.deepEqual(Object.fromEntries(out), { "block:2": ["d1"], "block:1": ["d2"] });
  assert.deepEqual(electReporters([b("block:1", "rs:A", "d", false)]).size, 0);
});

test("statusId fits the OSC 7501 id grammar", () => {
  assert.equal(statusId("01a1c5fe-23d6-7160-a2f6-8a770229c32a"), "session/01a1c5fe23d67160a2f68a770229c32a");
});

const VIEW = {
  windows: [
    {
      window_id: "w",
      label: "code",
      layers: [
        { layer_id: "t", kind: "tiled", blocks: [{ block_id: "A", label: "pi:a" }] },
        { layer_id: "f", kind: "floating", state: "normal", blocks: [{ block_id: "F" }] },
        { layer_id: "L", kind: "floating", state: "minimized", blocks: [{ block_id: "X" }] },
      ],
    },
    { window_id: "s", label: "__pi__", layers: [{ layer_id: "t2", kind: "tiled", blocks: [{ block_id: "S", label: "pi:s" }, { block_id: "H", label: "__pi__" }] }] },
  ],
};

test("stageOf finds the __pi__ tab, its placeholder, and the Pis left in it", () => {
  assert.deepEqual(stageOf(VIEW), { windowId: "s", anchor: "H", pis: ["S"] });
  assert.equal(stageOf({ windows: [VIEW.windows[0]] }), undefined);
});

test("lua writes values as a Lua table literal", () => {
  assert.equal(lua({ id: "block:1", rect: [0, 0.5], staged: false, old: [], layer: undefined }), '{["id"]="block:1",["rect"]={0,0.5},["staged"]=false,["old"]={},["layer"]=nil}');
});

test("shown is true only for a block outside the __pi__ tab and minimized layers", () => {
  assert.deepEqual(["A", "F", "X", "S", "detached"].map((id) => shown(VIEW, id)), [true, true, false, false, false]);
});

test("windowOf finds the window that holds a block", () => {
  assert.deepEqual(["A", "X", "S", "detached"].map((id) => windowOf(VIEW, id)), ["w", "w", "s", undefined]);
});

test("withSelf shows this Pi's session with its live name, listed or not", () => {
  const listed = [s("me", "/x", 5, { name: "old" }), s("other", "/x", 1)];
  const self = s("me", "/x", 0, { name: "new" });
  assert.deepEqual(withSelf(listed, self), [{ ...listed[0], name: "new" }, listed[1]], "the listed row keeps its times, takes the new name");
  assert.deepEqual(withSelf([listed[1]], self), [listed[1], self], "a session with no file yet is added");
});
