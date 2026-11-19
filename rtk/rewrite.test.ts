import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import { host } from "../test-host.ts";
import { rewriteChain } from "./rewrite.ts";

test("rewriteChain prefixes known commands in a chain", () => {
  for (const [input, want] of [
    ["git status", "rtk git status"],
    ["git add . && git push", "rtk git add . && rtk git push"],
    ["cd x; npm test || echo failed", "cd x; rtk npm test || echo failed"],
    ["  ls -la", "  rtk ls -la"],
    ["rtk git log", "rtk git log"],
    ["python3 x.py", "python3 x.py"],
    ["github-cli foo", "github-cli foo"],
  ]) {
    assert.equal(rewriteChain(input), want, input);
  }
});

test("rewriteChain keeps output that something else reads", () => {
  for (const input of [
    "git diff > out.patch",
    "wc -l < file",
    "echo 'a && git push'",
    "git commit -m \"unterminated",
  ]) {
    assert.equal(rewriteChain(input), input, input);
  }
  assert.equal(rewriteChain("git log | head -5 && git status"), "git log | rtk head -5 && rtk git status", "only the last pipe stage");
});

test("rewriteChain uses the given rtk command", () => {
  assert.equal(rewriteChain("git status", "'/opt/rtk'"), "'/opt/rtk' git status");
});

test("the extension rewrites bash calls when rtk is on PATH, and nothing else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtk-path-"));
  writeFileSync(join(dir, "rtk"), "#!/bin/sh\n", { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${path}`;
  const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  const { extensions, errors } = await loadExtensions([resolve(import.meta.dirname, "index.ts")], tmpdir());
  process.env.PATH = path;
  assert.deepEqual(errors, []);
  const call = async (toolName: string, input: Record<string, string>) => {
    for (const h of extensions[0].handlers.get("tool_call") ?? []) await h({ type: "tool_call", toolCallId: "1", toolName, input }, {});
    return input;
  };
  assert.deepEqual(await call("bash", { command: "git status" }), { command: "rtk git status" });
  assert.deepEqual(await call("read", { path: "git" }), { path: "git" });
});
