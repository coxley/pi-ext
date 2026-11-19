import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assetFor, installRtk } from "./install.ts";

const ASSET = "rtk-x86_64-unknown-linux-musl.tar.gz";

// release serves a fake rtk release: an archive holding a script that prints its version, and a
// checksums.txt with the given hash for it (the archive's real hash by default).
function release(hash?: string): typeof fetch {
  const src = mkdtempSync(join(tmpdir(), "rtk-src-"));
  writeFileSync(join(src, "rtk"), "#!/bin/sh\necho rtk 9.9.9\n", { mode: 0o755 });
  execFileSync("tar", ["-czf", ASSET, "rtk"], { cwd: src });
  const archive = readFileSync(join(src, ASSET));
  const sums = `${hash ?? createHash("sha256").update(archive).digest("hex")}  ${ASSET}\n${"0".repeat(64)}  other.tar.gz\n`;
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/checksums.txt")) return new Response(sums);
    if (u.endsWith(`/${ASSET}`)) return new Response(archive);
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

test("assetFor names the archive rtk ships for each supported platform", () => {
  assert.equal(assetFor("darwin", "arm64"), "rtk-aarch64-apple-darwin.tar.gz");
  assert.equal(assetFor("darwin", "x64"), "rtk-x86_64-apple-darwin.tar.gz");
  assert.equal(assetFor("linux", "x64"), ASSET);
  assert.equal(assetFor("linux", "arm64"), "rtk-aarch64-unknown-linux-musl.tar.gz");
  assert.equal(assetFor("win32", "x64"), undefined);
  assert.equal(assetFor("linux", "ia32"), undefined);
});

test("installRtk installs a verified rtk into binDir", async () => {
  const bin = join(mkdtempSync(join(tmpdir(), "rtk-bin-")), "bin");
  assert.equal(await installRtk(bin, release(), ASSET), "rtk 9.9.9");
  assert.equal(execFileSync(join(bin, "rtk"), { encoding: "utf8" }), "rtk 9.9.9\n");
});

test("installRtk writes nothing when the checksum does not match", async () => {
  const bin = join(mkdtempSync(join(tmpdir(), "rtk-bin-")), "bin");
  await assert.rejects(installRtk(bin, release("f".repeat(64)), ASSET), /checksum mismatch/);
  assert.equal(existsSync(join(bin, "rtk")), false);
});

test("installRtk fails on a missing asset", async () => {
  const bin = join(mkdtempSync(join(tmpdir(), "rtk-bin-")), "bin");
  await assert.rejects(installRtk(bin, release(), "rtk-nope.tar.gz"), /HTTP 404/);
});
