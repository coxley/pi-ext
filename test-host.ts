// Test helper: imports Pi's own modules from the local Pi installation, so tests run against the
// Pi that loads these extensions. Lookup order:
//   1. PI_TEST_MODULES: a node_modules directory that holds @earendil-works/pi-coding-agent
//   2. Pi's managed install: $PI_CODING_AGENT_DIR (default ~/.pi/agent)/install/current-version
//   3. the global npm root (npm install -g @earendil-works/pi-coding-agent)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

export const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const AGENT = "@earendil-works/pi-coding-agent";

function managed(): string | undefined {
  const install = join(agentDir, "install");
  const version = join(install, "current-version");
  return existsSync(version) ? join(install, "releases", readFileSync(version, "utf8").trim(), "node_modules") : undefined;
}

function globalRoot(): string | undefined {
  try {
    return execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // No npm on PATH: this candidate does not exist; the error below names the fix.
    return undefined;
  }
}

export const modules = [process.env.PI_TEST_MODULES, managed(), globalRoot()].find((dir) => dir && existsSync(join(dir, AGENT))) as string;
if (!modules) throw new Error(`Pi not found: set PI_TEST_MODULES to the node_modules directory that holds ${AGENT}`);

// host imports path (e.g. "@earendil-works/pi-tui/dist/index.js") from Pi's installation. A global npm
// install may nest Pi's own dependencies under the agent package.
export function host(path: string): Promise<Record<string, any>> {
  const top = join(modules, path);
  const file = existsSync(top) ? top : join(modules, AGENT, "node_modules", path);
  return import(pathToFileURL(file).href);
}

// fd is the fd binary Pi's @file completion runs, or undefined: $FD, Pi's own copy, then PATH
// (Debian and Ubuntu name it fdfind).
export const fd = [process.env.FD, join(agentDir, "bin/fd"), ...(process.env.PATH ?? "").split(delimiter).flatMap((d) => [join(d, "fd"), join(d, "fdfind")])].find(
  (f) => f && existsSync(f),
);
