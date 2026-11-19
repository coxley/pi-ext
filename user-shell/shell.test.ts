import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { shellFor } from "./shell.ts";

test("bash and no $SHELL keep Pi's shell; other shells run as is", () => {
  assert.equal(shellFor("/bin/bash", "/h"), undefined);
  assert.equal(shellFor(undefined, "/h"), undefined);
  assert.equal(shellFor("/usr/bin/fish", "/h")?.wrap("ls"), "ls");
});

test("zsh runs the command after .zshrc, so aliases expand, and quotes survive", { skip: !hasZsh() && "no zsh" }, () => {
  const home = mkdtempSync(join(tmpdir(), "user-shell-"));
  writeFileSync(join(home, ".zshrc"), "alias hi='echo hello from alias'\n");
  const shell = shellFor("zsh", home)!;
  const run = (command: string) => execFileSync("zsh", ["-c", shell.wrap(command)], { encoding: "utf8" }).trim();
  assert.equal(run("hi"), "hello from alias");
  assert.equal(run(`echo "it's" | tr a-z A-Z`), "IT'S");
});

function hasZsh(): boolean {
  try {
    execFileSync("zsh", ["-c", "true"]);
    return true;
  } catch {
    return false;
  }
}
