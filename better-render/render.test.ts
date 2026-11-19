import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { host, modules } from "../test-host.ts";

const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
const src = resolve(import.meta.dirname, "src");
// Pi loads the fork through jiti, with its own packages aliased; Node's strip-only TypeScript
// rejects the fork's parameter properties.
const { createJiti } = await host("jiti/lib/jiti.mjs");
const pkg = (name: string) => join(modules, "@earendil-works", name, "dist/index.js");
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-tui": pkg("pi-tui"), "@earendil-works/pi-coding-agent": pkg("pi-coding-agent") } });
const { renderMarkdown } = await jiti.import(`${src}/render/rich-markdown.ts`);
const { createMathRenderer } = await jiti.import(`${src}/math/formula.ts`);
const { plainStyle } = await jiti.import(`${src}/style.ts`);
const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07]*\x07/g, "").trimEnd();

test("the fork loads in Pi and registers /better-render", async () => {
  const { extensions, errors } = await loadExtensions([`${src}/index.ts`], tmpdir());
  assert.deepEqual(errors, []);
  assert.ok(extensions[0].commands.has("better-render"));
});

test("markdown renders headings, code with a copy target, tables, and math", () => {
  const md = ["# Title", "", "```ts", "const x = 1;", "```", "", "| a | b |", "|---|--:|", "| 1 | 22 |", "", "Euler: $e^{i\\pi}$"].join("\n");
  const actions: { y: number; code: string }[] = [];
  const lines = renderMarkdown(md, 40, { style: plainStyle(), math: createMathRenderer(() => undefined), streaming: false }, actions).map(strip);
  assert.ok(lines.includes("Title"), "no # marker");
  assert.match(lines[lines.indexOf("Title") + 1], /^━+$/, "H1 rule");
  assert.deepEqual(actions.map((a) => a.code), ["const x = 1;"]);
  assert.match(lines[actions[0].y], /\[Copy\]$/, "the button sits on the code block's first row");
  assert.ok(lines.some((l) => /^╭─+┬─+╮$/.test(l)), "rounded table border");
  assert.ok(lines.some((l) => l.startsWith("Euler:") && !l.includes("$")), "math is typeset, not shown as source");
});
