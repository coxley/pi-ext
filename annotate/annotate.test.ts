import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fd, host } from "../test-host.ts";
import { annotationBody } from "./annotate.ts";

const { CombinedAutocompleteProvider, Container, Editor, TuiAltScreen } = await host("@earendil-works/pi-tui/dist/index.js");

test("annotationBody quotes the selection, adds the comment as a paragraph, and ends the paragraph", () => {
  assert.equal(annotationBody("a\n\nb", " why? "), "> a\n>\n> b\n\nwhy?\n");
  assert.equal(annotationBody("a", ""), "> a\n");
});

test("annotate draws no chips itself: the render hook is the chips extension's", async () => {
  const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  const { extensions, errors } = await loadExtensions([resolve(import.meta.dirname, "index.ts")], tmpdir());
  assert.deepEqual(errors, []);
  const original = Editor.prototype.render;
  for (const h of extensions[0].handlers.get("session_start") ?? []) await h({ type: "session_start" }, { mode: "tui", cwd: tmpdir(), ui: {} });
  assert.equal(Editor.prototype.render, original);
  for (const h of extensions[0].handlers.get("session_shutdown") ?? []) await h({ type: "session_shutdown" }, { mode: "tui", cwd: tmpdir(), ui: {} });
});

test("selections open a comment box, chips sit on their own lines, and clicking a chip edits it", async () => {
  const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  // chips draws the annotation chip and expands it on a right-click.
  const paths = [resolve(import.meta.dirname, "../chips/index.ts"), resolve(import.meta.dirname, "index.ts")];
  const { extensions, errors } = await loadExtensions(paths, tmpdir());
  assert.deepEqual(errors, []);
  const theme = { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s };
  let box: { focused: boolean; handleInput(d: string): void; render(w: number): string[] } | undefined;
  let closed: Promise<unknown> | undefined;
  let renders = 0;
  let place: ((h: number) => { row: number }) | undefined;
  const ui = {
    theme,
    custom: (factory: Function, options: { onHandle(h: object): void; overlayOptions: (h: number) => { row: number } }) => {
      place = options.overlayOptions;
      closed = new Promise((done) => {
        const keys = { matches: (d: string, id: string) => id === "tui.select.cancel" && d === "\x1b" };
        box = factory({ requestRender: () => renders++, terminal: { rows: 30, columns: 80 } }, theme, keys, done);
        options.onHandle({ getBounds: () => ({ row: 11, col: 0, width: 40, height: 3 }) });
      });
      return closed;
    },
  };
  const emit = async (type: string) => {
    for (const ext of extensions) for (const h of ext.handlers.get(type) ?? []) await h({ type }, { mode: "tui", cwd: tmpdir(), ui });
  };
  const originals = [TuiAltScreen.prototype.handleSelectionMouseEvent, Editor.prototype.render];
  await emit("session_start");

  const editor = new Editor({ requestRender() {}, terminal: { rows: 30, columns: 80 } }, { borderColor: (s: string) => s, selectList: {} });
  editor.setText("intro");
  const container = new Container();
  container.addChild(editor);
  const editorBox = { component: container, rect: { x: 0, y: 20, width: 40, height: 3 }, lineOffset: 0, children: [] };
  // The fields the original release path and the hook read; the transcript sits above row 20.
  const transcript = { scrollTop: 50, viewportHeight: 10, scrollTo(top: number) { this.scrollTop = top; } };
  let copies = 0;
  const screen = {
    currentLayout: { root: { component: {}, rect: { x: 0, y: 0, width: 40, height: 30 }, lineOffset: 0, children: [editorBox] } },
    terminal: { rows: 30, columns: 40 },
    previousScreen: [] as string[],
    selectionPressActive: true,
    selectionAnchor: { row: 9, col: 0 } as object | undefined,
    selectionDragged: true,
    selectionFocus: { row: 9, col: 0 },
    getSelectionPoint: () => ({ row: 10, col: 5 }),
    updateSelectionFocus() {},
    stopSelectionAutoScroll() {},
    requestRender() {},
    clearTextSelection() { this.selectionAnchor = undefined; this.selectionPressActive = false; this.selectionDragged = false; },
    getSelectionBounds: () => ({ start: { row: 9, col: 0, scrollView: transcript }, end: { row: 10, col: 5, scrollView: transcript } }) as object,
    getActiveSelectionText: () => "the quoted line",
    // pi-tui moves the cursor and starts a selection on a press in the prompt, and copies a dragged
    // selection on release. Up one line and a copy count stand in for that.
    handleSearchMouseEvent(raw: { button: number; release: boolean }) {
      if (raw.release) {
        if (this.selectionPressActive && this.selectionDragged) copies++;
        this.selectionPressActive = false;
      } else if (raw.button & 32) this.selectionDragged = true;
      else {
        editor.handleInput("\x1b[A");
        this.selectionPressActive = true;
        this.selectionDragged = false;
      }
      return true;
    },
    createMouseEvent: () => ({}),
    decodeMouseButton: () => "left",
  };
  // A drag released on its top row: rows 9-10 are selected, the mouse is on row 9.
  const release = { x: 5, y: 9, button: 0, release: true };

  TuiAltScreen.prototype.handleSelectionMouseEvent.call(screen, release);
  assert.ok(box, "release opens the box");
  box.focused = true;
  assert.match(box.render(40)[1].replace(/\x1b_[^\x07]*\x07/g, ""), /Add an optional comment/);
  assert.equal(place?.(3).row, 11, "the box opens below the selection's bottom row, not over it");
  // The box (rows 11-13) keeps its own cells when the selection highlight covers its rows.
  const highlighted = TuiAltScreen.prototype.applySelection.call(
    { ...screen, getSelectionBounds: () => ({ start: { row: 10, col: 0 }, end: { row: 12, col: 39 } }), getSelectionColumns: TuiAltScreen.prototype.getSelectionColumns, applySelectionHighlight: TuiAltScreen.prototype.applySelectionHighlight },
    Array.from({ length: 15 }, (_, i) => `line ${i}`.padEnd(40)),
  );
  assert.deepEqual(highlighted.slice(10, 13).map((l: string) => l.includes("\x1b[7m")), [true, false, false]);
  // ctrl+j is the newline key, like shift+enter.
  for (const k of ["s", "o", "\n", "?", "\r"]) box.handleInput(k);
  await closed;
  assert.equal(editor.getExpandedText(), "intro\n> the quoted line\n\nso\n?\n\n", "its own line, cursor on the next");
  assert.deepEqual(editor.getCursor(), { line: 2, col: 0 });
  await Promise.resolve();
  assert.equal(renders, 1, "adding the chip requests a render");
  const drawn = container.render(40);
  assert.match(drawn[2], /annotation 1/);
  assert.doesNotMatch(drawn.join("\n"), /\[paste #/);

  // Rows 20-24: top border, "intro", the chip, the empty line, bottom border.
  screen.previousScreen = [...Array(20).fill("transcript"), ...drawn];
  editorBox.rect.height = drawn.length;
  box = undefined;
  // click presses at x and releases at to, after a drag there when to differs.
  const click = (x: number, y: number, to = x) => {
    TuiAltScreen.prototype.handleMouseEvent.call(screen, { x, y, button: 0, release: false });
    if (to !== x) TuiAltScreen.prototype.handleMouseEvent.call(screen, { x: to, y, button: 32, release: false });
    TuiAltScreen.prototype.handleMouseEvent.call(screen, { x: to, y, button: 0, release: true });
  };
  click(30, 22);
  assert.equal(box, undefined, "a click right of the pill opens nothing");
  copies = 0;
  click(3, 22, 30);
  assert.equal(box, undefined, "a drag off the pill opens nothing");
  assert.equal(copies, 1, "and copies as usual");
  const cursor = editor.getCursor();
  click(3, 22, 4);
  assert.ok(box, "a click on the pill reopens its box, even when the mouse moves a cell");
  assert.equal(copies, 1, "the click copies nothing");
  assert.deepEqual(editor.getCursor(), cursor, "the click leaves the cursor where it was");
  box.focused = true;
  const rows = box.render(40).map((r) => r.replace(/\x1b_[^\x07]*\x07/g, "").slice(2, -2).trimEnd());
  assert.deepEqual(rows.slice(1, -1), ["> the quoted line", "", "so", "?"], "the quote, a blank line, then the comment");
  assert.equal(transcript.scrollTop, 50, "the transcript does not move");
  for (const k of ["!", "\r"]) box.handleInput(k);
  await closed;
  assert.equal(editor.getExpandedText(), "intro\n> the quoted line\n\nso\n?!\n\n");
  assert.match(container.render(40)[2], /annotation 1/, "the edit keeps the number");
  const rightClick = (x: number, y: number) => {
    for (const release of [false, true]) TuiAltScreen.prototype.handleMouseEvent.call(screen, { x, y, button: 2, release });
  };
  rightClick(30, 22);
  assert.match(editor.getText(), /\[paste #1 /, "a right-click off the pill changes nothing");
  rightClick(3, 22);
  assert.equal(editor.getText(), "intro\n> the quoted line\n\nso\n?!\n\n", "a right-click on the pill expands it in place");

  box = undefined;
  screen.selectionPressActive = true;
  TuiAltScreen.prototype.handleSelectionMouseEvent.call(screen, release);
  TuiAltScreen.prototype.handleMouseEvent.call(screen, { x: 1, y: 2, button: 0, release: false });
  assert.equal(await closed, undefined, "a press outside the box cancels it");
  assert.equal(editor.getExpandedText(), "intro\n> the quoted line\n\nso\n?!\n\n");

  screen.selectionPressActive = true;
  screen.getSelectionBounds = () => ({ start: { row: 21, col: 0 }, end: { row: 21, col: 5 } });
  box = undefined;
  TuiAltScreen.prototype.handleSelectionMouseEvent.call(screen, { ...release, y: 21 });
  assert.equal(box, undefined, "a selection inside the prompt opens nothing");

  await emit("session_shutdown");
  assert.deepEqual([TuiAltScreen.prototype.handleSelectionMouseEvent, Editor.prototype.render], originals);
});

test("the comment box completes @paths like the prompt, and Escape closes the list first", { skip: !fd && "needs fd (set FD)" }, async () => {
  const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  const { extensions, errors } = await loadExtensions([resolve(import.meta.dirname, "../chips/index.ts"), resolve(import.meta.dirname, "index.ts")], tmpdir());
  assert.deepEqual(errors, []);
  const theme = { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s };
  let box: { focused: boolean; handleInput(d: string): void; render(w: number): string[] } | undefined;
  let closed: Promise<unknown> | undefined;
  const tui = { requestRender() {}, terminal: { rows: 30, columns: 80 } };
  const ui = {
    theme,
    custom: (factory: Function, options: { onHandle(h: object): void }) => {
      closed = new Promise((done) => {
        box = factory(tui, theme, { matches: (d: string, id: string) => id === "tui.select.cancel" && d === "\x1b" }, done);
        options.onHandle({ getBounds: () => ({ row: 11, col: 0, width: 40, height: 3 }) });
      });
      return closed;
    },
  };
  const emit = async (type: string) => {
    for (const ext of extensions) for (const h of ext.handlers.get(type) ?? []) await h({ type }, { mode: "tui", cwd: tmpdir(), ui });
  };
  await emit("session_start");
  const cwd = mkdtempSync(join(tmpdir(), "annotate-"));
  writeFileSync(join(cwd, "notes.md"), "");
  const id = (s: string) => s;
  const editor = new Editor(tui, { borderColor: id, selectList: { selectedPrefix: id, selectedText: id, description: id, scrollInfo: id, noMatch: id } });
  // Extensions wrap Pi's provider, so the prompt's provider has no CombinedAutocompleteProvider fields.
  const base = new CombinedAutocompleteProvider([{ name: "model" }], cwd, fd);
  editor.setAutocompleteProvider({ getSuggestions: (...a: unknown[]) => base.getSuggestions(...a), applyCompletion: (...a: unknown[]) => base.applyCompletion(...a) });
  const container = new Container();
  container.addChild(editor);
  const editorBox = { component: container, rect: { x: 0, y: 20, width: 40, height: 3 }, lineOffset: 0, children: [] };
  const screen = {
    currentLayout: { root: { component: {}, rect: { x: 0, y: 0, width: 40, height: 30 }, lineOffset: 0, children: [editorBox] } },
    terminal: { rows: 30, columns: 40 },
    previousScreen: [] as string[],
    selectionPressActive: true,
    selectionAnchor: { row: 9, col: 0 } as object | undefined,
    selectionDragged: true,
    selectionFocus: { row: 9, col: 0 },
    getSelectionPoint: () => ({ row: 10, col: 5 }),
    updateSelectionFocus() {},
    stopSelectionAutoScroll() {},
    requestRender() {},
    clearTextSelection() { this.selectionAnchor = undefined; this.selectionPressActive = false; },
    getSelectionBounds: () => ({ start: { row: 9, col: 0 }, end: { row: 10, col: 5 } }) as object,
    getActiveSelectionText: () => "quoted",
  };
  TuiAltScreen.prototype.handleSelectionMouseEvent.call(screen, { x: 5, y: 9, button: 0, release: true });
  assert.ok(box, "release opens the box");
  box.focused = true;
  const rows = () => box!.render(40).map((r) => r.replace(/\x1b_[^\x07]*\x07/g, ""));
  const listed = async () => {
    // The editor asks the provider after a short debounce; fd answers asynchronously.
    for (let i = 0; i < 100 && !rows().some((r) => r.includes("notes.md")); i++) await new Promise((r) => setTimeout(r, 20));
    return rows();
  };
  for (const k of "@no") box.handleInput(k);
  const shown = await listed();
  const row = shown.find((r) => r.includes("notes.md"));
  assert.ok(row?.startsWith("│") && row.endsWith("│"), "the suggestion list shows inside the frame");
  box.handleInput("\x1b");
  assert.ok(!rows().some((r) => r.includes("notes.md")), "Escape closes the list");
  assert.ok(rows().some((r) => r.includes("@no")), "and keeps the box");
  box.handleInput("\x7f");
  box.handleInput("o");
  await listed();
  box.handleInput("\t");
  box.handleInput("\r");
  await closed;
  assert.match(editor.getExpandedText(), /\n@notes\.md\n/, "Tab completes the path; Enter submits the comment");
  box = undefined;
  editor.setText("");
  TuiAltScreen.prototype.handleSelectionMouseEvent.call({ ...screen, selectionPressActive: true }, { x: 5, y: 9, button: 0, release: true });
  for (const k of "/mo") box!.handleInput(k);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!rows().some((r) => r.includes("model")), "slash commands are not offered");
  await emit("session_shutdown");
});
