import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELEASE = "https://github.com/rtk-ai/rtk/releases/latest/download/";

// assetFor names rtk's release archive for a Node platform and arch, or undefined when rtk ships none.
export function assetFor(platform: string, arch: string): string | undefined {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  if (!cpu) return undefined;
  if (platform === "darwin") return `rtk-${cpu}-apple-darwin.tar.gz`;
  if (platform === "linux") return `rtk-${cpu}-unknown-linux-musl.tar.gz`;
  return undefined;
}

async function get(fetcher: typeof fetch, url: string): Promise<Response> {
  const res = await fetcher(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

// installRtk downloads the latest rtk release into binDir/rtk and returns its --version output. It
// verifies the archive against the release's checksums.txt, and replaces binDir/rtk in one rename.
export async function installRtk(binDir: string, fetcher: typeof fetch = fetch, asset = assetFor(process.platform, process.arch)): Promise<string> {
  if (!asset) throw new Error(`rtk ships no build for ${process.platform}/${process.arch}`);
  const [sums, archive] = await Promise.all([
    get(fetcher, `${RELEASE}checksums.txt`).then((r) => r.text()),
    get(fetcher, RELEASE + asset).then(async (r) => Buffer.from(await r.arrayBuffer())),
  ]);
  const want = sums.split("\n").map((line) => line.trim().split(/\s+/)).find(([, name]) => name === asset)?.[0];
  if (!want) throw new Error(`checksums.txt has no entry for ${asset}`);
  const got = createHash("sha256").update(archive).digest("hex");
  if (got !== want) throw new Error(`checksum mismatch for ${asset}: want ${want}, got ${got}`);

  const tmp = mkdtempSync(join(tmpdir(), "rtk-"));
  try {
    writeFileSync(join(tmp, asset), archive);
    execFileSync("tar", ["-xzf", asset, "rtk"], { cwd: tmp });
    mkdirSync(binDir, { recursive: true });
    const staged = join(binDir, ".rtk.tmp");
    copyFileSync(join(tmp, "rtk"), staged);
    chmodSync(staged, 0o755);
    renameSync(staged, join(binDir, "rtk"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return execFileSync(join(binDir, "rtk"), ["--version"], { encoding: "utf8" }).trim();
}
