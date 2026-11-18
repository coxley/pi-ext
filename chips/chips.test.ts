import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { agentDir, host } from "../test-host.ts";
import { atPathStyles, chipLabel, ICON, labelChips, pastedChip } from "./chips.ts";

const { Container, Editor, TuiAltScreen, visibleWidth } = await host("@earendil-works/pi-tui/dist/index.js");
const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
const here = import.meta.dirname;
// Optional: pix-display turns pix-pretty's chips on, for the coexistence test.
const pixDisplay = join(agentDir, "npm/node_modules/@xynogen/pix-display/src/index.ts");
const dir = mkdtempSync(join(tmpdir(), "chips-"));
for (const f of ["a b.txt", "shot.png", "notes.md"]) writeFileSync(join(dir, f), "x");
const theme = { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s };
const paste = (s: string) => `\x1b[200~${s}\x1b[201~`;
const tui = { requestRender() {}, terminal: { rows: 30, columns: 80 } };
const newEditor = () => new Editor(tui, { borderColor: (s: string) => s, selectList: {} });
const patched = () => [Editor.prototype.render, Editor.prototype.handleInput, Editor.prototype.insertTextAtCursor, Editor.prototype.expandPasteMarkers, TuiAltScreen.prototype.handleMouseEvent];

// rightClick right-clicks the first chip that shows icon, with editor drawn at screen rows 20-22
// (top border, the chips, bottom border).
function rightClick(editor: InstanceType<typeof Editor>, icon: string): void {
  const container = new Container();
  container.addChild(editor);
  const drawn = container.render(120);
  const box = { component: container, rect: { x: 0, y: 20, width: 120, height: drawn.length }, lineOffset: 0, children: [] };
  const screen = { currentLayout: { root: { component: {}, rect: { x: 0, y: 0, width: 120, height: 30 }, lineOffset: 0, children: [box] } }, previousScreen: [...Array(20).fill(""), ...drawn], requestRender() {} };
  TuiAltScreen.prototype.handleMouseEvent.call(screen, { x: drawn[1].indexOf(icon), y: 21, button: 2, release: false });
}

// load loads extensions and returns emit, which runs every handler for an event in load order.
async function load(paths: string[], ui: object = { theme }) {
  const { extensions, errors } = await loadExtensions(paths, dir);
  assert.deepEqual(errors, []);
  return async (type: string, event: object = {}) => {
    let result: unknown;
    for (const ext of extensions) for (const h of ext.handlers.get(type) ?? []) result = (await h({ type, ...event }, { mode: "tui", cwd: dir, ui })) ?? result;
    return result;
  };
}

test("chipLabel names each kind with its icon", () => {
  assert.equal(chipLabel("https://www.github.com/a?b=1"), `${ICON.url} www.github.com`);
  assert.equal(chipLabel("x".repeat(974)), `${ICON.text} text 974 chars`);
  assert.equal(chipLabel("x".repeat(1234)), `${ICON.text} text 1.2k chars`);
  assert.equal(chipLabel({ kind: "image", path: "/t/a.png" }), `${ICON.image} image`);
  assert.equal(chipLabel({ kind: "path", path: "/t/a.ts" }), `${ICON.file} a.ts`);
  assert.equal(chipLabel({ kind: "path", path: "/t/src/" }), `${ICON.dir} src/`);
  assert.equal(chipLabel({ kind: "skill", ref: "a/b@tdd" }), `${ICON.skill} $tdd`);
  assert.equal(chipLabel({ kind: "prompt", name: "plan-edit", body: "" }), `${ICON.prompt} edit`);
  for (const icon of Object.values(ICON)) assert.equal(icon.length, 1, "one UTF-16 unit, so labels pad by length");
});

test("pastedChip takes one URL or one path to an existing file, as terminals drop it", () => {
  assert.equal(pastedChip(" https://example.com/x \n", dir), "https://example.com/x");
  assert.deepEqual(pastedChip(`'${dir}/a b.txt'`, dir), { kind: "path", path: join(dir, "a b.txt") });
  assert.deepEqual(pastedChip(`${dir}/a\\ b.txt`, dir), { kind: "path", path: join(dir, "a b.txt") });
  assert.deepEqual(pastedChip("./notes.md", dir), { kind: "path", path: join(dir, "notes.md") });
  assert.deepEqual(pastedChip(`"${dir}/shot.png"`, dir), { kind: "image", path: join(dir, "shot.png") });
  for (const text of ["notes.md", "./missing.md", dir, "see https://example.com", "https://a.com\nhttps://b.com"]) assert.equal(pastedChip(text, dir), undefined, text);
});

test("labelChips draws same-length pills, cuts long labels, keeps the cursor and inner styles", () => {
  const style = (s: string) => `<${s}>`;
  const marker = "[paste #2 12 chars]"; // 19 long
  assert.equal(labelChips(`x ${marker} [paste #1 9 chars]`, (id) => (id === 2 ? "note 1" : undefined), style), `x <${" note 1 ".padEnd(19)}> [paste #1 9 chars]`);
  assert.equal(labelChips(marker, () => "a-very-long-file-name.ts", style), `< a-very-long-file… >`);
  const cursor = `\x1b_pi:c\x07\x1b_pi:fc\x07${marker}\x1b_pi:/fc\x07`;
  assert.equal(labelChips(cursor, () => "n", style), `\x1b_pi:c\x07\x1b[7m<${" n ".padEnd(19)}>\x1b[27m`);
  assert.equal(labelChips("[paste #2 \x1b[3m12 chars]", () => "n", style), `<${" n ".padEnd(19)}>\x1b[3m`);
});

test("atPathStyles marks @paths that name a file, without trailing punctuation", () => {
  const isFile = (p: string) => p === "a.ts";
  const [s] = atPathStyles(["see @a.ts, not @b.ts or x@a.ts"], isFile);
  assert.deepEqual([s.indexOf("4;35"), s.lastIndexOf("4;35")], [4, 8]);
});

test("alone: URL, file and image pastes and a Ctrl+V image become chips, send as text or tags, and expand on a right-click", async () => {
  const original = patched();
  const emit = await load([resolve(here, "index.ts")]);
  await emit("session_start");
  const editor = newEditor();
  editor.handleInput("see ");
  editor.handleInput(paste("https://github.com/earendil/pi"));
  editor.handleInput(paste(`'${dir}/a b.txt'`));
  editor.handleInput(paste(`${dir}/shot.png`));
  // Ctrl+V of an image: Pi writes a temp file and inserts its path.
  editor.insertTextAtCursor(`${dir}/shot.png`);
  // pi-tui itself collapses only a paste over 1000 chars or 10 lines.
  editor.handleInput(paste("y".repeat(1500)));
  assert.match(editor.getText(), /^see \[paste #1 30 chars\] \[paste #2 \d+ chars\] \[paste #3 \d+ chars\] \[paste #4 \d+ chars\] \[paste #5 1500 chars\]$/);
  const row = editor.render(120)[1];
  assert.doesNotMatch(row, /\[paste #/, "every marker is drawn as a chip");
  for (const label of [`${ICON.url} github.com`, `${ICON.file} a b.txt`, `${ICON.image} image`, `${ICON.text} text 1.5k chars`]) assert.ok(row.includes(label), label);
  assert.equal(row.split(`${ICON.image} image`).length, 3, "both images are chips");
  assert.equal(visibleWidth(row), 120);

  // The model gets the URL, the file as <path>, each image as its path, and the text.
  const sent = `see https://github.com/earendil/pi <path>${dir}/a b.txt</path> ${dir}/shot.png ${dir}/shot.png ${"y".repeat(1500)}`;
  assert.equal(editor.getExpandedText(), sent);
  assert.equal(await emit("input", { text: sent, images: [] }), undefined, "no pix-pretty tags to unwrap");

  rightClick(editor, ICON.image);
  assert.match(editor.getText(), new RegExp(String.raw`^see \[paste #1 30 chars\] \[paste #2 \d+ chars\] ${dir}/shot\.png \[paste #3 \d+ chars\] \[paste #4 1500 chars\]$`), "a right-click expands the image chip, and its path is not chipped again");
  rightClick(editor, ICON.file);
  assert.ok(editor.getText().startsWith(`see [paste #1 30 chars] ${dir}/a b.txt ${dir}/shot.png [paste #2 `), "and the file chip to its path");

  await emit("session_shutdown");
  assert.deepEqual(patched(), original);
});

test("with pix-pretty: chips draw before its pass, send as its tags, and expand on a right-click", { skip: !existsSync(pixDisplay) && "pix-display not installed" }, async () => {
  const original = patched();
  let factory: ((...args: unknown[]) => InstanceType<typeof Editor>) | undefined;
  const ui = { theme, getEditorComponent: () => undefined, setEditorComponent: (f: typeof factory) => (factory = f) };
  // pix-display turns pix-pretty's chips on; chips loads first, so the editor's render chain reaches it.
  const emit = await load([resolve(here, "index.ts"), pixDisplay], ui);
  await emit("session_start");
  assert.ok(factory, "pix-display installs its editor");
  const keys = { matches: () => false, getKeys: () => [] };
  const editor = factory(tui, { borderColor: (s: string) => s, selectList: {} }, keys);

  editor.handleInput("see ");
  editor.handleInput(paste("https://github.com/earendil/pi"));
  editor.handleInput(paste(`'${dir}/a b.txt'`));
  editor.handleInput(paste(`${dir}/shot.png`));
  editor.handleInput(paste("y".repeat(150)));
  assert.match(editor.getText(), /^see \[paste #1 30 chars\] \[paste #2 \d+ chars\] \[paste #3 \d+ chars\] \[paste #4 150 chars\] $/);
  const row = editor.render(120)[1];
  assert.doesNotMatch(row, /\[paste #/, "every marker is drawn, so pix-pretty's pass has none left");
  assert.doesNotMatch(row, /\u{F027F}|\u{F02E9}/u, "pix-pretty drew none of its own chips");
  for (const label of [`${ICON.url} github.com`, `${ICON.file} a b.txt`, `${ICON.image} image`, `${ICON.text} text 150 chars`]) assert.ok(row.includes(label), label);
  assert.equal(visibleWidth(row), 120);

  // pix-pretty sends text as <paste>…</paste>; the input hook unwraps a URL.
  const sent = editor.getExpandedText();
  assert.match(sent, new RegExp(`<paste>https://github.com/earendil/pi</paste> <path>${dir}/a b.txt</path> <paste>${dir}/shot.png</paste> <paste>y{150}</paste>`));
  const input = (await emit("input", { text: sent, images: [] })) as { text: string };
  assert.ok(input.text.startsWith("see https://github.com/earendil/pi <path>"), input.text);

  // Image first: expanding it leaves the file chip where it was.
  rightClick(editor, ICON.image);
  assert.ok(editor.getText().includes(` ${dir}/shot.png [paste #3 150 chars]`), "a right-click expands the image chip; pix-pretty does not chip the path again");
  rightClick(editor, ICON.file);
  assert.ok(editor.getText().startsWith(`see [paste #1 30 chars] ${dir}/a b.txt ${dir}/shot.png [paste #2 150 chars]`), "and the file chip to its path");

  await emit("session_shutdown");
  assert.deepEqual(patched(), original);
});

test("the same URL pasted twice is one literal copy, with expand-paste above or below", async () => {
  for (const order of [["chips", "expand-paste"], ["expand-paste", "chips"]]) {
    const paths = order.map((n) => (n === "chips" ? resolve(here, "index.ts") : resolve(here, "../expand-paste/index.ts")));
    const emit = await load(paths, { theme, notify() {} });
    await emit("session_start");
    const editor = newEditor();
    editor.handleInput("a ");
    for (let i = 0; i < 2; i++) editor.handleInput(paste("https://example.com/x"));
    assert.equal(editor.getText(), "a https://example.com/x", order.join(" over "));
    // expand-paste still quotes a multi-line paste on a quote line.
    editor.setText("> ");
    editor.handleInput("\x1b[F");
    editor.handleInput(paste("one\ntwo"));
    assert.equal(editor.getText(), "> one\n> two", order.join(" over "));
    await emit("session_shutdown");
  }
});

test("typed @paths that name a file are highlighted", async () => {
  const emit = await load([resolve(here, "index.ts")]);
  await emit("session_start");
  const editor = newEditor();
  editor.setText("read @notes.md and @missing.md");
  const row = editor.render(60)[1];
  assert.ok(row.includes("\x1b[4;35m@notes.md\x1b["), "an existing file is styled");
  assert.ok(row.includes(" @missing.md"), "a missing one is not");
  await emit("session_shutdown");
});

test("after a reload, a patch buried under another extension's patch never touches its stale ctx", async () => {
  // md-prompt also patches Editor.prototype.render; loaded second, it sits on top of chips.
  const paths = [resolve(here, "index.ts"), resolve(here, "../md-prompt/index.ts")];
  let stale = false;
  // Pi throws when a reloaded extension reads its old ctx.
  const oldUi = { get theme() { if (stale) throw new Error("stale ctx"); return theme; } };
  const { extensions } = await loadExtensions(paths, dir);
  const emit = async (type: string, ui: object) => {
    for (const ext of extensions) for (const h of ext.handlers.get(type) ?? []) await h({ type }, { mode: "tui", cwd: dir, ui });
  };
  const original = Editor.prototype.render;
  await emit("session_start", oldUi);
  await emit("session_shutdown", oldUi);
  stale = true;
  await emit("session_start", { theme });
  const editor = newEditor();
  editor.handleInput(paste(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n")));
  assert.doesNotThrow(() => editor.render(40));
  await emit("session_shutdown", { theme });
  assert.doesNotThrow(() => editor.render(40));
  Editor.prototype.render = original;
});
