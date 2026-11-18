import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { host } from "../test-host.ts";
import { bareLead, dedent, expandPair, indentLead, lineLead, samePaste } from "./expand.ts";


const big = Array.from({ length: 12 }, (_, i) => `line${i} ${"x".repeat(10)}`).join("\n");
const other = `other\n${big}`; // 13 lines: "[paste #1 +13 lines]"
const pasteEvent = (payload: string) => `\x1b[200~${payload}\x1b[201~`;
const { Editor } = await host("@earendil-works/pi-tui/dist/index.js");
const newEditor = () => new Editor({ requestRender() {}, terminal: { rows: 30, columns: 80 } }, { borderColor: (s: string) => s, selectList: {} });

test("samePaste ignores a trailing newline across copy sources", () => {
  assert.ok(samePaste(big, `${big}\n`));
  assert.ok(!samePaste(big, other));
});

test("dedent drops shared indentation from multi-line text only", () => {
  assert.equal(dedent("    if x:\n      y\n  \n    z"), "if x:\n  y\n\nz");
  assert.equal(dedent("a\n  b"), "a\n  b", "an unindented line shares nothing");
  assert.equal(dedent("  one line"), "  one line");
});

test("indentLead nests an item under the one above, as a dash under numbers, and dedents into the nearest shallower item's list", () => {
  const cases: [string[], 1 | -1, string | undefined][] = [
    [["- a", "- "], 1, "  - "],
    [["* a", "* "], 1, "  * "],
    [["1. a", "2. "], 1, "   - "],
    [["a) x", "b) "], 1, "   - "],
    [["1. [ ] a", "2. [ ] "], 1, "   - [ ] "],
    [["- [ ] a", "- [ ] "], 1, "  - [ ] "],
    [["> - a", "> - "], 1, ">   - "],
    [["text", "- "], 1, "  - "],
    [["1. a", "   1. b", "   2. "], -1, "2. "],
    [["1. a", "2. b", "   - c", "   - "], -1, "3. "],
    [["- a", "  * b", "    - "], -1, "  * "],
    [["- a", "", "  - "], -1, "- "],
    [["- a"], -1, undefined],
    [["plain"], 1, undefined],
  ];
  for (const [lines, dir, lead] of cases) assert.equal(indentLead(lines, lines.length - 1, dir), lead, `${lines.join(" | ")} ${dir}`);
});

test("lineLead continues quotes and list items, keeping indentation and counting numbers and letters", () => {
  const cases: [string, string | undefined][] = [
    ["- a", "- "], ["* a", "* "], ["+ a", "+ "], ["    - nested", "    - "], ["\t* tab", "\t* "],
    ["1. a", "2. "], ["9) a", "10) "], ["1.  wide", "2.  "], ["a. x", "b. "], ["B) x", "C) "],
    ["> a", "> "], [">> a", ">> "], ["> - a", "> - "], [">   2. a", ">   3. "],
    ["- [ ] a", "- [ ] "], ["- [x] done", "- [ ] "], ["1. [X] a", "2. [ ] "],
    ["plain", undefined], ["-a", undefined], ["1.5 is a number", undefined], ["e.g. this", undefined], ["z. last", undefined],
  ];
  for (const [line, lead] of cases) assert.equal(lineLead(line), lead, line);
  assert.ok(bareLead("- [ ] ") && !bareLead("- [ ] a"), "an empty task is bare");
  assert.deepEqual(["- ", "  2. ", "> ", "> - ", "- a", "", "text"].map(bareLead), [true, true, true, true, false, false, false]);
});

test("expandPair turns only the same-text pill pair before the cursor into one literal copy", () => {
  const e = newEditor();
  e.handleInput(pasteEvent(other));
  e.handleInput(pasteEvent(big));
  assert.equal(expandPair(e), false, "two pills with different text are no pair");
  e.handleInput(pasteEvent(big));
  assert.equal(expandPair(e), true);
  assert.equal(e.getText(), `[paste #1 +13 lines]${big}`, "the earlier pill keeps its marker");
  // pix-pretty's chips end with a space: "[#4] [#5] " leaves one trailing separator.
  for (const k of [pasteEvent(big), " ", pasteEvent(big), " "]) e.handleInput(k);
  assert.equal(expandPair(e), true);
  assert.ok(e.getText().endsWith(`${big}${big} `));
});

test("expandPair quotes every pasted line when only a quote prefix precedes the pair", () => {
  const quoted = `a\n\n${big}\n`;
  const e = newEditor();
  for (const k of ["> > ", pasteEvent(quoted), pasteEvent(quoted)]) e.handleInput(k);
  assert.equal(expandPair(e), true);
  const lines = e.getText().split("\n");
  assert.deepEqual(lines.slice(0, 3), ["> > a", "> >", "> > line0 xxxxxxxxxx"]);
  assert.equal(lines.length, 14, "the trailing newline adds no empty quote line");
  assert.ok(lines.every((l) => l.startsWith("> >")));

  const f = newEditor();
  for (const k of ["see > ", pasteEvent(big), pasteEvent(big)]) f.handleInput(k);
  assert.equal(expandPair(f), true);
  assert.equal(f.getText(), `see > ${big}`, "a '>' after other text is no quote");
});

test("the extension expands a repeated paste in any Editor, and restores the prototype on shutdown", async () => {
  const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  const { extensions, errors } = await loadExtensions([resolve(import.meta.dirname, "index.ts")], tmpdir());
  assert.deepEqual(errors, []);
  const notified: string[] = [];
  const emit = async (type: string, mode = "tui") => {
    for (const handler of extensions[0].handlers.get(type) ?? []) await handler({ type }, { mode, ui: { notify: (m: string) => notified.push(m) } });
  };
  const original = Editor.prototype.handleInput;

  await emit("session_start");
  // A subclass made by a factory that never chains (as pi-open-tui does) still passes through the hook.
  const e = new (class extends Editor {})({ requestRender() {}, terminal: { rows: 30, columns: 80 } }, { borderColor: (s: string) => s, selectList: {} });
  for (const k of [pasteEvent(other), " ", pasteEvent(big), pasteEvent(big)]) e.handleInput(k);
  assert.equal(e.getText(), `[paste #1 +13 lines] ${big}`);
  assert.equal(notified.length, 1);

  for (const k of [pasteEvent(big), "x", pasteEvent(big)]) e.handleInput(k);
  assert.match(e.getText(), /\[paste #\d+ \+12 lines\]x\[paste #\d+ \+12 lines\]$/, "a key between the pastes breaks the pair");
  const inline = "y".repeat(200);
  e.handleInput(pasteEvent(inline));
  e.handleInput(pasteEvent(inline));
  assert.ok(e.getText().endsWith(inline + inline), "inline duplicates stay");
  assert.equal(notified.length, 1);

  // Inline pastes: shared indent goes; after a bare quote prefix every line joins the quote.
  const q = newEditor();
  for (const k of ["> ", pasteEvent("  a\n\n  b\n")]) q.handleInput(k);
  assert.equal(q.getText(), "> a\n>\n> b");
  assert.deepEqual(q.getCursor(), { line: 2, col: 3 });
  // ctrl+j (newline) carries the quote down, also from an empty quote line.
  for (const k of ["\n", "c", "\n", "\n"]) q.handleInput(k);
  assert.equal(q.getText(), "> a\n>\n> b\n> c\n> \n> ");
  q.handleInput("\n");
  assert.equal(q.getText(), "> a\n>\n> b\n> c\n\n", "a second empty quote line ends the quote");
  assert.deepEqual(q.getCursor(), { line: 5, col: 0 });
  const plain = newEditor();
  for (const k of ["x > ", pasteEvent("a\nb"), "\n"]) plain.handleInput(k);
  assert.equal(plain.getText(), "x > a\nb\n", "no quote without a bare prefix");
  // List items continue like quotes, and two empty items in a row end the list.
  const list = newEditor();
  for (const k of ["  1. a", "\n", "b", "\n"]) list.handleInput(k);
  assert.equal(list.getText(), "  1. a\n  2. b\n  3. ");
  list.handleInput("\n");
  assert.equal(list.getText(), "  1. a\n  2. b\n  3. \n  4. ");
  list.handleInput("\n");
  assert.equal(list.getText(), "  1. a\n  2. b\n\n", "a second empty item ends the list");
  assert.deepEqual(list.getCursor(), { line: 3, col: 0 });
  const bullets = newEditor();
  for (const k of ["> - a", "\n", pasteEvent("x\ny")]) bullets.handleInput(k);
  assert.equal(bullets.getText(), "> - a\n> - x\ny", "a paste after a list prefix stays as pasted");
  // Tab and shift+tab right after a list prefix nest and un-nest it in Pi's prompt editor.
  const { CustomEditor } = await host("@earendil-works/pi-coding-agent/dist/index.js");
  let cycled = 0;
  const prompt = new CustomEditor({ requestRender() {}, terminal: { rows: 30, columns: 80 } }, { borderColor: (s: string) => s, selectList: {} }, { matches: (d: string, id: string) => id === "app.thinking.cycle" && d === "\x1b[Z" });
  prompt.onAction("app.thinking.cycle", () => cycled++);
  for (const k of ["1. a", "\n", "\t", "b", "\n"]) prompt.handleInput(k);
  assert.equal(prompt.getText(), "1. a\n   - b\n   - ");
  prompt.handleInput("\x1b[Z");
  assert.equal(prompt.getText(), "1. a\n   - b\n2. ");
  assert.deepEqual(prompt.getCursor(), { line: 2, col: 3 });
  assert.equal(cycled, 0);
  prompt.handleInput("\x1b[Z");
  assert.equal(cycled, 1, "shift+tab on a top-level item cycles the thinking level");
  // Anywhere on a list line: tab nests and shift+tab un-nests, keeping the cursor on its text.
  for (const k of ["c", "\t"]) prompt.handleInput(k);
  assert.equal(prompt.getText(), "1. a\n   - b\n     - c");
  assert.deepEqual(prompt.getCursor(), { line: 2, col: 8 }, "still after the c");
  prompt.handleInput("\x1b[Z");
  assert.equal(prompt.getText(), "1. a\n   - b\n   - c");
  assert.equal(cycled, 1);
  // An @path before the cursor keeps tab for completion.
  for (const k of ["\x1b[F", " @x", "\t"]) prompt.handleInput(k);
  assert.equal(prompt.getText(), "1. a\n   - b\n   - c @x", "tab after an @path is completion");
  prompt.setText("plain");
  prompt.handleInput("\x1b[Z");
  assert.equal(cycled, 2, "shift+tab outside a list cycles the thinking level");
  // Plain editors, such as the annotation box, nest too.
  const box = newEditor();
  for (const k of ["1. a", "\n", "b", "\t"]) box.handleInput(k);
  assert.equal(box.getText(), "1. a\n   - b");
  box.handleInput("\x1b[Z");
  assert.equal(box.getText(), "1. a\n2. b");

  await emit("session_shutdown");
  assert.equal(Editor.prototype.handleInput, original, "shutdown restores the original method");
  await emit("session_start", "print");
  assert.equal(Editor.prototype.handleInput, original, "non-tui sessions patch nothing");
});
