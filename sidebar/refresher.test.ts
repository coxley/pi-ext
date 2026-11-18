import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { modules } from "../test-host.ts";

test("a refresher that cannot start rex exits and frees its lock, so a Pi in Rex can start one", () => {
  const dir = mkdtempSync(join(tmpdir(), "refresher-"));
  const state = join(dir, "pi-sidebar");
  mkdirSync(state);
  // A Pi with its sidebar open touched alive just now.
  writeFileSync(join(state, "alive"), "");
  const env = { PATH: "/usr/bin:/bin", HOME: dir, XDG_STATE_HOME: dir, PI_CODING_AGENT_DIR: join(dir, "agent") };
  const index = join(modules, "@earendil-works/pi-coding-agent/dist/index.js");
  execFileSync(process.execPath, [join(import.meta.dirname, "refresher.ts"), index], { env, timeout: 10_000 });
  assert.equal(existsSync(join(state, "refresher.pid")), false);
});
