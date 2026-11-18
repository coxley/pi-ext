import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { missing } from "./compat.ts";
import { host } from "./test-host.ts";

const { Editor } = await host("@earendil-works/pi-tui/dist/index.js");
const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");

test("missing names absent or non-function methods, and every method of an absent class", () => {
  assert.deepEqual(missing({ a() {}, b: 1 }, ["a", "b", "c"]), ["b", "c"]);
  assert.deepEqual(missing(undefined, ["a"]), ["a"]);
});

test("each extension stays off and warns when this Pi lacks a method it patches", async () => {
  const names = ["editor-copy", "md-prompt", "expand-paste", "chips", "annotate"];
  const { extensions, errors } = await loadExtensions(names.map((n) => resolve(import.meta.dirname, n, "index.ts")), tmpdir());
  assert.deepEqual(errors, []);
  const before = { render: Editor.prototype.render, handleInput: Editor.prototype.handleInput };
  // A Pi that renamed getLines, which every extension here reads.
  const getLines = Editor.prototype.getLines;
  Editor.prototype.getLines = undefined;
  const warnings: string[] = [];
  const ui = { theme: { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s }, notify: (m: string) => warnings.push(m) };
  try {
    for (const ext of extensions) for (const h of ext.handlers.get("session_start") ?? []) await h({ type: "session_start" }, { mode: "tui", cwd: tmpdir(), ui });
  } finally {
    Editor.prototype.getLines = getLines;
  }
  assert.deepEqual(warnings.map((w) => w.split(":")[0]), names);
  assert.ok(warnings.every((w) => w.includes("getLines")), warnings.join("\n"));
  assert.deepEqual({ render: Editor.prototype.render, handleInput: Editor.prototype.handleInput }, before, "nothing patched");
});
