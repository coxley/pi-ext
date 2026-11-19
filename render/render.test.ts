import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { host } from "../test-host.ts";
import { duration, row, summarize, tree } from "./view.ts";

const paint = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const lines = (component: { render(w: number): string[] }, width = 10) => component.render(width).map((l) => l.trimEnd());

test("summarize, duration, row and tree", () => {
  assert.equal(summarize("git status"), "git status");
  assert.equal(summarize("cd x &&  npm   test || echo no"), "cd x +2 steps");
  assert.equal(summarize("set -e\n# note\nFOO=1\necho $FOO"), "shell script · 2 lines");
  assert.deepEqual([450, 2_700, 125_000].map(duration), ["450ms", "2.7s", "2m 5s"]);
  assert.equal(row(paint, false, "bash", "make", [false, "exit 2", undefined, "3 lines"]), "✗ bash make · exit 2 · 3 lines");
  assert.equal(row(paint, true, "bash", "", ["1 line"]), "✓ bash 1 line", "no gist");
  assert.deepEqual(tree(paint, ["a.ts", "src/"], { dir: "D", file: "F" }), ["├── F a.ts", "└── D src/"]);
  assert.deepEqual(tree(paint, ["a.ts"], { dir: "D", file: "F" }, true), ["├── F a.ts"], "more entries follow");
});

test("bash rows frame, then fold to one line, and unfold while expanded", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  const { extensions, errors } = await loadExtensions([resolve(import.meta.dirname, "index.ts")], tmpdir());
  assert.deepEqual(errors, []);
  const { Text } = await host("@earendil-works/pi-tui/dist/index.js");
  const [resolver] = extensions[0].toolRenderers;
  const base = {
    renderCall: () => new Text("$ git status", 0, 0),
    renderResult: () => ({ render: () => ["", "out1", "out2"], invalidate() {} }),
  };
  assert.equal(resolver("read", () => base), base, "other tools keep their renderers");
  const bash = resolver("bash", () => base);
  let invalidated = 0;
  const context = { state: {}, expanded: false, isError: false, durationMs: 2_700, args: { command: "git status && git push" }, invalidate: () => invalidated++ };
  const ok = { content: [{ type: "text", text: "out1\nout2" }], structuredContent: { exit_code: 0 } };
  const done = { expanded: false, isPartial: false };

  assert.deepEqual(lines(bash.renderResult(ok, done, paint, context), 4), ["────", "out1", "out2", "────"], "framed; leading blank dropped");
  t.mock.timers.tick(5_000);
  assert.equal(invalidated, 1, "the row redraws when it folds");
  assert.deepEqual(lines(bash.renderResult(ok, done, paint, context), 60), ["✓ bash git status +1 steps · 2 lines · 2.7s"]);
  assert.deepEqual(lines(bash.renderCall({}, paint, context)), [], "the folded row carries the call");
  assert.equal(lines(bash.renderResult(ok, done, paint, { ...context, expanded: true })).length, 4, "expanded shows the frame");

  const failed = { content: [{ type: "text", text: "boom\n\nCommand exited with code 2" }] };
  assert.deepEqual(lines(bash.renderResult(failed, done, paint, { ...context, isError: true, durationMs: undefined }), 60), ["✗ bash git status +1 steps · exit 2 · 1 line"]);
  const slow = { content: [{ type: "text", text: "partial\n\nCommand timed out after 60 seconds" }] };
  assert.match(lines(bash.renderResult(slow, done, paint, { ...context, isError: true }), 60)[0], /· timed out · 1 line ·/, "the status line is not output");
});

test("ls rows draw a tree with notices, and fold to a count", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  const { extensions } = await loadExtensions([resolve(import.meta.dirname, "index.ts")], tmpdir());
  const { Text } = await host("@earendil-works/pi-tui/dist/index.js");
  const pi = { renderCall: () => new Text("ls src", 0, 0), renderResult: () => new Text("pi's own", 0, 0) };
  const ls = extensions[0].toolRenderers[0]("ls", () => pi);
  const context = { state: {}, expanded: false, isError: false, args: { path: "src" }, invalidate() {}, keyHint: (_k: string, d: string) => `ctrl+o ${d}` };
  const result = { content: [{ type: "text", text: "a.ts\nlib/\n\n[2 entries limit reached. Use limit=4 for more]" }] };
  const done = { expanded: false, isPartial: false };
  const icon = (l: string) => l.replace(/[\uf07b\uf15b]/u, "#");
  assert.deepEqual(lines(ls.renderResult(result, done, paint, context), 60).map(icon), ["", "├── # a.ts", "└── # lib/", "[2 entries limit reached. Use limit=4 for more]"]);
  const empty = { content: [{ type: "text", text: "(empty directory)" }] };
  assert.deepEqual(lines(ls.renderResult(empty, done, paint, { ...context, state: {} }), 20), ["pi's own"], "Pi draws the empty case");
  t.mock.timers.tick(5_000);
  assert.deepEqual(lines(ls.renderResult(result, done, paint, context), 60), ["✓ ls src · 2 entries · truncated"]);
});
