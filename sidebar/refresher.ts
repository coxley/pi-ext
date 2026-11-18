// refresher keeps one snapshot of Pi sessions, their git grouping, and live Pi blocks for every
// sidebar, so a Pi reads one file instead of spawning rex and git itself. One runs per user: it
// holds LOCK_FILE and touches it every loop. It exits a minute after the last Pi with an open sidebar
// stops touching ALIVE_FILE. The git cache persists in the snapshot: a cwd is looked up once, ever.
//
// Usage: node refresher.ts <path to pi-coding-agent's dist/index.js>
import { execFile } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ALIVE_FILE, type Git, LOCK_FILE, LOCK_STALE_MS, type Live, parseGit, type Rec, RELIST_FILE, type Session, SNAPSHOT_FILE, type Snapshot, STAGE, STATE_DIR, unknownCwds } from "./tree.ts";

const POLL_MS = 1500;
const SESSIONS_MS = 10_000;
const IDLE_MS = 60_000;
// A Pi list older than this is dropped: switching to a Pi that is gone fails.
const PIS_STALE_MS = 10_000;

// The refresher serves every Rex session. A REX_SESSION or REX_BLOCK from the Pi that started it
// can die first, and then every rex call fails.
delete process.env.REX_SESSION;
delete process.env.REX_BLOCK;

// One Lua script per poll: every pi:* block on the server with its status records. A block in the
// STAGE tab or in a minimized layer counts as hidden.
const POLL_LUA = `
local out = {}
for _, s in ipairs((rex.call("session.list") or {}).sessions or {}) do
  local sid = s.session_id
  rex.session.attach{ session_id = sid }
  local hidden = {}
  for _, w in ipairs((rex.call("session.view", { session_id = sid }) or {}).windows or {}) do
    for _, l in ipairs(w.layers or {}) do
      if l.state == "minimized" or w.label == "${STAGE}" then
        for _, b in ipairs(l.blocks or {}) do hidden[b.block_id] = true end
      end
    end
  end
  local blocks = {}
  for _, b in ipairs((rex.call("session.list_blocks", { session_id = sid }) or {}).blocks or {}) do
    if string.sub(b.label or "", 1, 3) == "pi:" then
      local st = rex.call("com.superlogical.terminal.program_status", { session_id = sid, block_id = b.block_id })
      table.insert(blocks, { block_id = b.block_id, label = b.label, placement = b.placement, hidden = hidden[b.block_id] or false, window_id = b.window_id, records = st and st.records })
    end
  end
  table.insert(out, { session_id = sid, blocks = blocks })
end
return { sessions = out }
`;
type PollBlock = { block_id: string; label: string; placement?: string; hidden?: boolean; window_id?: string; records?: Rec[] | object };
type Poll = { sessions?: { session_id: string; blocks?: PollBlock[] | object }[] | object };
// Lua encodes an empty table as {}, not [].
const arr = <T>(v: T[] | object | undefined): T[] => (Array.isArray(v) ? v : []);

type Info = { id: string; path: string; cwd: string; name?: string; created: Date; modified: Date; parentSessionPath?: string };
// SAFETY: the path is Pi's own dist/index.js, which exports SessionManager; Info lists the fields read.
const { SessionManager } = (await import(pathToFileURL(process.argv[2]).href)) as unknown as { SessionManager: { listAll(): Promise<Info[]> } };

function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 10_000, maxBuffer: 8 << 20 }, (err, out) => (err ? reject(err) : resolve(out)));
    child.stdin?.end(input ?? "");
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// lock takes LOCK_FILE, replacing a stale one. It returns false when another refresher holds it.
function lock(): boolean {
  mkdirSync(STATE_DIR, { recursive: true });
  try {
    if (Date.now() - statSync(LOCK_FILE).mtimeMs < LOCK_STALE_MS) return false;
    unlinkSync(LOCK_FILE);
  } catch {
    // No lock yet.
  }
  try {
    const fd = openSync(LOCK_FILE, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    return false; // Another refresher won the race.
  }
}
// holds is false once another refresher replaced this one's lock, so at most one keeps running.
const holds = () => {
  try {
    return readFileSync(LOCK_FILE, "utf8") === String(process.pid);
  } catch {
    return false;
  }
};
// sidebarOpen tells whether some Pi has its sidebar open: each one touches ALIVE_FILE every poll.
const sidebarOpen = () => Date.now() - mtimeOf(ALIVE_FILE) < 3 * POLL_MS;

async function pollPis(): Promise<Live[]> {
  const out: Poll = JSON.parse(await run("rex", ["do", "-", "--json"], POLL_LUA));
  return arr(out.sessions).flatMap((s) =>
    arr<PollBlock>(s.blocks).map((b) => ({ blockId: b.block_id, rexSession: s.session_id, sessionId: b.label.slice(3), placed: b.placement === "placed" && !b.hidden, windowId: b.window_id, root: arr<Rec>(b.records).find((r) => !r.id) })),
  );
}
const listSessions = async (): Promise<Session[]> =>
  (await SessionManager.listAll()).map((s) => ({ id: s.id, path: s.path, cwd: s.cwd, name: s.name, created: s.created.getTime(), modified: s.modified.getTime(), parentPath: s.parentSessionPath }));
async function gitOf(cwd: string): Promise<Git | null> {
  try {
    return parseGit(await run("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--show-toplevel"])) ?? null;
  } catch {
    return null; // Not a git dir, or gone.
  }
}

const mtimeOf = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0; // No such file yet.
  }
};

if (!lock()) process.exit(0);
let snap: Snapshot = { sessions: [], git: {}, pis: [] };
try {
  snap = { ...snap, ...JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")) };
} catch {
  // First run.
}
let written = "";
let listed = 0;
let busy = Date.now();
let polled = Date.now();
while (holds()) {
  const now = Date.now();
  utimesSync(LOCK_FILE, new Date(now), new Date(now));
  if (sidebarOpen()) {
    try {
      snap.pis = await pollPis();
      polled = now;
    } catch {
      // Rex may be restarting: keep the last list for a while.
      if (now - polled > PIS_STALE_MS) snap.pis = [];
    }
    if (now - listed >= SESSIONS_MS || mtimeOf(RELIST_FILE) > listed) {
      listed = now;
      try {
        snap.sessions = await listSessions();
      } catch {
        // Keep the last list.
      }
      for (const cwd of unknownCwds(snap.sessions, snap.git)) snap.git[cwd] = await gitOf(cwd);
    }
  }
  // Only Pis that use this state dir count: other Pis on the server may use another one.
  try {
    busy = Math.max(busy, statSync(ALIVE_FILE).mtimeMs);
  } catch {
    // No sidebar has synced yet.
  }
  if (now - busy > IDLE_MS) break;
  // Pis re-read the file only when its mtime moves, so write only on change.
  const text = JSON.stringify(snap);
  if (text !== written) {
    const tmp = `${SNAPSHOT_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, SNAPSHOT_FILE);
    written = text;
  }
  await sleep(POLL_MS);
}
if (holds()) unlinkSync(LOCK_FILE);
