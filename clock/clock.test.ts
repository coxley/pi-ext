import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { host } from "../test-host.ts";
import { clockTime, elapsed, indexOf, isZone, stamp } from "./stamp.ts";

const tui = await host("@earendil-works/pi-tui/dist/index.js");
const agent = await host("@earendil-works/pi-coding-agent/dist/index.js");
const layout = { sliceByColumn: tui.sliceByColumn, stripTerminalSequences: tui.stripTerminalSequences, visibleWidth: tui.visibleWidth };
const plain = (s: string) => tui.stripTerminalSequences(s);
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

test("stamp puts the time at the right edge of the first non-blank line", () => {
  assert.deepEqual(stamp(["", "▾ Thinking", "body"], 24, "14:32:05", dim, layout).map(plain), ["", "▾ Thinking     14:32:05 ", "body"]);
  assert.deepEqual(stamp(["  edit +2 -2   ✓        "], 30, "14:32:05", dim, layout).map(plain), ["  edit +2 -2   ✓     14:32:05 "]);
  const rule = "─".repeat(24);
  assert.deepEqual(stamp([rule, "$ date", rule], 24, "14:32:05", dim, layout).map(plain), [rule, "$ date         14:32:05 ", rule], "a ! block's top rule is skipped");
  const tight = ["a long line that fills it"];
  assert.equal(stamp(tight, 30, "14:32:05", dim, layout), tight, "no blank column left before the time");
  const blank = ["", "   "];
  assert.equal(stamp(blank, 30, "14:32:05", dim, layout), blank);
});

test("stamp keeps the line's background in the columns around the time", () => {
  const bg = "\x1b[44m";
  const [line] = stamp([`${bg}hi${" ".repeat(18)}\x1b[0m`], 20, "14:32:05", dim, layout);
  assert.equal(plain(line), "hi         14:32:05 ");
  assert.ok(line.startsWith(bg), "the slice keeps the opening style");
  assert.equal(tui.visibleWidth(line), 20);
});

test("clockTime, elapsed and isZone", () => {
  const at = Date.UTC(2026, 0, 1, 19, 32, 5);
  assert.equal(clockTime(at, "America/New_York", at + 3_600_000), "14:32:05", "today: time only");
  assert.equal(clockTime(Date.UTC(2026, 6, 1, 4, 5, 6), "America/New_York", Date.UTC(2026, 6, 1, 12)), "00:05:06", "summer time, 24-hour");
  assert.equal(clockTime(at, "America/New_York", Date.UTC(2026, 0, 2, 5, 0, 0)), "2026-01-01 14:32:05", "an earlier day: just after midnight in that zone");
  assert.equal(clockTime(at, "Asia/Tokyo", at), "04:32:05", "the zone decides the day");
  assert.deepEqual([0, 12_400, 185_000, 3_725_000].map(elapsed), ["0s", "12s", "3m 5s", "1h 2m"]);
  assert.equal(isZone("Europe/Berlin"), true);
  assert.equal(isZone("Mars/Olympus"), false);
});

test("indexOf maps tool calls and ! commands to their times", () => {
  const index = indexOf([
    { role: "user", timestamp: 1 },
    { role: "assistant", timestamp: 2, content: [{ type: "text" }, { type: "toolCall", id: "a" }, { type: "toolCall", id: "b" }] },
    { role: "bashExecution", timestamp: 3, command: "ls" },
    { role: "bashExecution", timestamp: 4, command: "ls" },
  ]);
  assert.deepEqual([...index.tools], [["a", 2], ["b", 2]]);
  assert.deepEqual(index.bash.get("ls"), [3, 4]);
});

test("the extension stamps blocks with their session time, and restores render on shutdown", async () => {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "clock-state-"));
  const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  const { extensions, errors } = await loadExtensions([resolve(import.meta.dirname, "index.ts")], tmpdir());
  assert.deepEqual(errors, []);
  const emit = async (type: string, ctx: object) => {
    for (const h of extensions[0].handlers.get(type) ?? []) await h({ type }, ctx);
  };
  const ran = Date.UTC(2026, 0, 1, 19, 32, 5);
  const ctx = {
    mode: "tui",
    ui: { theme: { fg: (_t: string, s: string) => s } },
    sessionManager: { buildSessionContext: () => ({ messages: [{ role: "bashExecution", command: "ls", timestamp: ran }] }) },
  };
  const proto = agent.BashExecutionComponent.prototype;
  assert.equal(Object.hasOwn(proto, "render"), false, "inherits render from Container");
  await emit("session_start", ctx);
  const block = (command: string) => Object.assign(Object.create(proto), { command, children: [{ render: () => ["", "$ ls"] }] });
  assert.deepEqual(proto.render.call(block("ls"), 30), ["", `$ ls${" ".repeat(6)}2026-01-01 14:32:05 `], "an earlier day shows its date");
  const live = proto.render.call(block("pwd"), 20)[1];
  assert.match(live, /^\$ ls {7}\d\d:\d\d:\d\d $/, "a block not in the session gets its first-render time");
  await emit("session_shutdown", ctx);
  assert.equal(Object.hasOwn(proto, "render"), false, "inherited render is back");
});
