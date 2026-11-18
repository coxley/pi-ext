import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { host } from "../test-host.ts";
import { paint, rowStarts, styleLines } from "./md.ts";

const { Editor, stripTerminalSequences } = await host("@earendil-works/pi-tui/dist/index.js");
const strip = (s: string) => s.replace(/\x1b_[^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");

test("styleLines marks markdown spans and leaves markers in place", () => {
  const [h, q, l, inline, fenceOpen, code, fenceClose, plain] = styleLines([
    "# Title",
    "> quote",
    "- item",
    "a **b** *c* `*d*` ~~e~~ [f](g) snake_case 2*3*4",
    "```",
    "**not bold**",
    "```",
    "**bold**",
  ]);
  assert.deepEqual(new Set(h), new Set(["1;36"]));
  assert.deepEqual([q[0], q[2]], ["34", "3"]);
  assert.deepEqual([l[0], l[2]], ["34", ""]);
  const line = "a **b** *c* `*d*` ~~e~~ [f](g) snake_case 2*3*4";
  const at = (s: string) => inline[line.indexOf(s)];
  assert.deepEqual([at("**b"), at("*c"), at("`"), at("*d"), at("~~"), at("[f"), at("snake"), at("*3")], ["1", "3", "33", "33", "9", "4", "", ""]);
  assert.deepEqual([fenceOpen[0], code[0], fenceClose[0], plain[0]], ["2", "33", "2", "1"]);
});

test("rowStarts maps wrapped rows back to their line offsets", () => {
  const rows = [{ text: "hello " }, { text: "world" }, { text: "" }, { text: "x" }];
  assert.deepEqual(rowStarts(rows, ["hello world", "", "x"]), [
    { line: 0, start: 0 },
    { line: 0, start: 6 },
    { line: 1, start: 0 },
    { line: 2, start: 0 },
  ]);
});

test("paint keeps cursor codes and text, and closes styles with targeted off codes", () => {
  const row = ` a\x1b_pi:c\x07\x1b_pi:fc\x07b\x1b_pi:/fc\x07c   `;
  const out = paint(row, 1, ["", "1", "1"]);
  assert.equal(strip(out), strip(row));
  assert.ok(out.includes("\x1b_pi:c\x07\x1b_pi:fc\x07"));
  assert.equal(out, ` a\x1b_pi:c\x07\x1b_pi:fc\x07\x1b[1mb\x1b_pi:/fc\x07c\x1b[22;23;24;29;39m   `);
});

test("paint restores the row's own styles after its span ends", () => {
  const off = "\x1b[22;23;24;29;39m";
  const row = `\x1b[1mab cd ef${off}`;
  assert.equal(paint(row, 0, ["", "", "", "4;35", "4;35"]), `\x1b[1mab \x1b[4;35mcd${off}\x1b[1m ef${off}`);
});

test("the extension styles a real editor without changing its text, and restores render", async () => {
  const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  const { extensions, errors } = await loadExtensions([resolve(import.meta.dirname, "index.ts")], tmpdir());
  assert.deepEqual(errors, []);
  const emit = async (type: string, mode = "tui") => {
    for (const h of extensions[0].handlers.get(type) ?? []) await h({ type }, { mode, ui: {} });
  };
  const original = Editor.prototype.render;
  const e = new Editor({ requestRender() {}, terminal: { rows: 30, columns: 20 } }, { borderColor: (s: string) => s, selectList: {} });
  e.focused = true;
  e.setText("# hi\nsome **bold words** wrap here");
  const before = e.render(20);

  await emit("session_start");
  const after = e.render(20);
  assert.deepEqual(after.map(stripTerminalSequences), before.map(stripTerminalSequences), "same visible text");
  assert.ok(after[1].includes("\x1b[1;36m#"), "heading styled");
  assert.ok(after.some((r: string) => r.includes("\x1b[1m**bold")), "bold styled");
  assert.ok(after.some((r: string) => /\x1b\[1mwords\*\*/.test(r)), "a span wrapped onto the next row keeps its style");

  await emit("session_shutdown");
  assert.equal(Editor.prototype.render, original);
});
