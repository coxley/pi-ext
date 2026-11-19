import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { host } from "../test-host.ts";
import { tree } from "./view.ts";

const paint = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const lines = (component: { render(w: number): string[] }, width = 10) => component.render(width).map((l) => l.trimEnd());
const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
const { Text } = await host("@earendil-works/pi-tui/dist/index.js");
const { extensions, errors } = await loadExtensions([resolve(import.meta.dirname, "index.ts")], tmpdir());
const [resolver] = extensions[0].toolRenderers;
const done = { expanded: false, isPartial: false };
const open = { expanded: true, isPartial: false };
const context = { state: {}, isError: false, args: {}, outputPad: 1 };

test("tree draws one entry per line", () => {
  assert.deepEqual(errors, []);
  assert.deepEqual(tree(paint, ["a.ts", "src/"], { dir: "D", file: "F" }), ["├── F a.ts", "└── D src/"]);
});

test("bash frames the expanded result by exit status, and leaves compact rows alone", () => {
  const compact = new Text("compact", 0, 0);
  const base = { renderResult: (_r: unknown, o: { expanded: boolean }) => (o.expanded ? { render: () => ["", "out1"], invalidate() {} } : compact) };
  assert.equal(resolver("read", () => base), base, "other tools keep their renderers");
  const bash = resolver("bash", () => base);
  const ok = { content: [{ type: "text", text: "out1" }], structuredContent: { exit_code: 0 } };
  assert.equal(bash.renderResult(ok, done, paint, context), compact, "collapsed: the base row");
  assert.equal(bash.renderResult(ok, { ...open, isPartial: true }, paint, context).render(4).length, 2, "running: the base view");
  const paints: string[] = [];
  const spy = { fg: (c: string, s: string) => (paints.push(c), s) };
  assert.deepEqual(lines(bash.renderResult(ok, open, spy, context), 4), ["────", "out1", "────"], "leading blank dropped");
  const failed = { content: [{ type: "text", text: "boom\n\nCommand exited with code 2" }] };
  lines(bash.renderResult(failed, open, spy, { ...context, isError: true }));
  assert.deepEqual([...new Set(paints)], ["success", "error"]);
});

test("ls draws the expanded listing as a tree with Pi's notices", () => {
  const pi = { renderResult: () => new Text("pi's own", 0, 0) };
  const ls = resolver("ls", () => pi);
  const result = { content: [{ type: "text", text: "a.ts\nlib/\n\n[2 entries limit reached. Use limit=4 for more]" }] };
  const icon = (l: string) => l.replace(/[\uf07b\uf15b]/u, "#");
  assert.deepEqual(lines(ls.renderResult(result, open, paint, context), 60).map(icon), ["", " ├── # a.ts", " └── # lib/", " [2 entries limit reached. Use limit=4 for more]"], "indented by outputPad");
  assert.deepEqual(lines(ls.renderResult(result, done, paint, context), 20), ["pi's own"], "collapsed: the base row");
  const empty = { content: [{ type: "text", text: "(empty directory)" }] };
  assert.deepEqual(lines(ls.renderResult(empty, open, paint, context), 20), ["pi's own"], "Pi draws the empty case");
});
