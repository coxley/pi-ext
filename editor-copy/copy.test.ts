import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { host } from "../test-host.ts";
import { editorRange, expandMarkers, unwrapRows } from "./copy.ts";

const { Container, Editor, TuiAltScreen } = await host("@earendil-works/pi-tui/dist/index.js");

test("expandMarkers copies each paste as its raw text, tagged kinds included", () => {
  const pastes = new Map<number, unknown>([
    [1, "one\ntwo"],
    [2, { kind: "path", path: "/a b.txt" }],
    [3, { kind: "image", path: "/s.png" }],
    [4, { kind: "skill", ref: "o/r@tdd" }],
    [5, { kind: "prompt", name: "plan", body: "do it" }],
  ]);
  const text = "[paste #1 +2 lines] [paste #2 8 chars] [paste #3 6 chars] [paste #4 7 chars] [paste #5 5 chars] [paste #9 1 chars]";
  assert.equal(expandMarkers(text, pastes), "one\ntwo /a b.txt /s.png o/r@tdd do it [paste #9 1 chars]");
});

test("editorRange maps screen points to text offsets across wraps, frames and short rows", () => {
  const lines = ["hello world", "x"];
  const view = { lines, rows: [{ text: "hello " }, { text: "world" }, { text: "x" }], scrollOffset: 0, shown: [6, 5, 1], top: 1, left: 2 };
  const len = (s: string) => s.length;
  const text = lines.join("\n");
  const pick = (a: object, b: object) => text.slice(...editorRange(view, a as never, b as never, len));
  assert.equal(pick({ row: 1, col: 4 }, { row: 2, col: 4 }), "llo wor", "a wrap joins with no newline");
  assert.equal(pick({ row: 0, col: 0 }, { row: 4, col: 0 }), text, "frame rows clamp to the text");
  assert.equal(pick({ row: 2, col: 0 }, { row: 3, col: 40 }), "world\nx", "past the drawn text is the row end");
  assert.equal(pick({ row: 1, col: 2 }, { row: 1, col: 5, boundary: true }), "hel");
});

// Transcript rows as drawn: a one-column gutter, then pi-better-render or pi-tui markdown.
const drawn = [
  "• Expansion: expandPasteMarkers sends a file as <path>abs</path> and an",
  "  image as its path.",
  "• Ctrl+V image: turns the temp path into a chip.",
  "  ◦ nested item that wraps onto",
  "    a second row",
  "",
  "With pix-pretty installed, the old",
  "behavior is the same.",
];
const list = drawn.map((r) => ` ${r}`);
const unwrapped = [
  "• Expansion: expandPasteMarkers sends a file as <path>abs</path> and an image as its path.",
  "• Ctrl+V image: turns the temp path into a chip.",
  "  ◦ nested item that wraps onto a second row",
  "",
  "With pix-pretty installed, the old behavior is the same.",
].join("\n");

test("unwrapRows joins soft wraps and keeps list, quote and code breaks", () => {
  const cases: [string[], string][] = [
    [drawn, unwrapped],
    [["- [x] done task that", "      wraps", "2. next", "   item"], "- [x] done task that wraps\n2. next item"],
    [["☐ todo that", "  wraps", "☑ done"], "☐ todo that wraps\n☑ done"],
    [["▎ quoted", "▎ quote", "│ border"], "▎ quoted\n▎ quote\n│ border"],
    [["const a = 1;", "const b = 2;"], "const a = 1;\nconst b = 2;"],
    [["see https://example.com/a/", "b/c now"], "see https://example.com/a/b/c now"],
  ];
  for (const [rows, want] of cases) {
    assert.equal(unwrapRows(rows.map((r) => ` ${r}`).join("\n")), want, `outputPad 1: ${rows[0]}`);
    assert.equal(unwrapRows(rows.join("\n")), want, `outputPad 0: ${rows[0]}`);
    assert.equal(unwrapRows([rows[0], ...rows.slice(1).map((r) => ` ${r}`)].join("\n"), 1), want, `from the first marker: ${rows[0]}`);
  }
  assert.equal(unwrapRows("start\n more", 9), "start more", "a partial first row");
});

test("the extension copies editor text, not the frame, and leaves other selections alone", async () => {
  const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  const { extensions, errors } = await loadExtensions([resolve(import.meta.dirname, "index.ts")], tmpdir());
  assert.deepEqual(errors, []);
  const emit = async (type: string) => {
    for (const h of extensions[0].handlers.get(type) ?? []) await h({ type }, { mode: "tui", ui: {} });
  };
  const original = TuiAltScreen.prototype.copySelectionToClipboard;
  const originalText = TuiAltScreen.prototype.getActiveSelectionText;
  await emit("session_start");
  const transcript = Object.assign(Object.create(TuiAltScreen.prototype), {
    previousScreen: list,
    getSelectionBounds: () => ({ start: { row: 0, col: 0 }, end: { row: list.length - 1, col: 80 } }),
  });
  assert.equal(transcript.getActiveSelectionText(), unwrapped, "transcript selections unwrap");

  const tui = { requestRender() {}, terminal: { rows: 30, columns: 80 } };
  const theme = { borderColor: (s: string) => s, selectList: {} };
  // Same geometry as pi-open-tui: "│ " rails around an editor rendered 4 columns narrower.
  class Framed extends Editor {
    render(width: number) {
      const rows = super.render(width - 4);
      return rows.map((r: string, i: number) => (i === 0 || i === rows.length - 1 ? `╭${"─".repeat(width - 2)}╮` : `│ ${r} │`));
    }
  }
  const copy = async (editor: InstanceType<typeof Editor>, width: number, start: object, end: object) => {
    const container = new Container();
    container.addChild(editor);
    const drawn = container.render(width);
    const y = 3;
    let copied: string | undefined;
    const editorBox = { component: container, rect: { x: 0, y, width, height: drawn.length }, lineOffset: 0, children: [] };
    const screen = {
      currentLayout: { root: { component: {}, rect: { x: 0, y: 0, width, height: 30 }, lineOffset: 0, children: [editorBox] } },
      previousScreen: [...Array(y).fill("transcript"), ...drawn],
      getSelectionBounds: () => ({ start, end }),
      getActiveSelectionText: () => "screen text",
      copyTextToClipboard: async (t: string) => ((copied = t), true),
    };
    await TuiAltScreen.prototype.copySelectionToClipboard.call(screen);
    return copied;
  };

  const paste = Array.from({ length: 12 }, (_, i) => `p${i}`).join("\n");
  const framed = new Framed(tui, theme);
  framed.setText("hello world this wraps\n");
  framed.handleInput(`\x1b[200~${paste}\x1b[201~`);
  // Rows: 3 top border, 4 "hello world this ", 5 "wraps", 6 the paste marker, 7 bottom border.
  assert.equal(await copy(framed, 24, { row: 3, col: 0 }, { row: 7, col: 23 }), `hello world this wraps\n${paste}`, "no frame, no wrap newline, pill expanded");
  assert.equal(await copy(framed, 24, { row: 4, col: 8 }, { row: 4, col: 12 }), "world");

  const plain = new Editor(tui, theme);
  plain.setText("hello world this wraps");
  assert.equal(await copy(plain, 20, { row: 4, col: 0 }, { row: 5, col: 4 }), "hello world this wraps");
  assert.equal(await copy(plain, 20, { row: 1, col: 0 }, { row: 4, col: 3 }), "screen text", "a selection from the transcript copies the screen");

  await emit("session_shutdown");
  assert.equal(TuiAltScreen.prototype.copySelectionToClipboard, original);
  assert.equal(TuiAltScreen.prototype.getActiveSelectionText, originalText);
});
