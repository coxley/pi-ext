import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as agent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { clockTime, elapsed, type Index, indexOf, isZone, stamp } from "./stamp.ts";

const STATE = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "pi-clock", "state.json");
const DEFAULT_ZONE = "America/New_York";
// Every transcript block Pi draws. Some inherit render from Container or Box.
const BLOCKS = [
  "UserMessageComponent", "AssistantMessageComponent", "ToolExecutionComponent", "BashExecutionComponent",
  "CustomMessageComponent", "SkillInvocationMessageComponent", "CompactionSummaryMessageComponent", "BranchSummaryMessageComponent",
] as const;
const layout = { sliceByColumn, stripTerminalSequences, visibleWidth };

// SAFETY: TS-private fields that Pi's transcript components keep as runtime properties: an entry's
// ISO timestamp (messages), the message (assistant), the call ID (tools), the command (`!`).
type Block = { timestamp?: string; lastMessage?: { timestamp?: number }; toolCallId?: string; command?: string };
type Render = (this: Block, width: number) => string[];

function loadZone(): string {
  try {
    const zone = JSON.parse(readFileSync(STATE, "utf8")).zone;
    return typeof zone === "string" && isZone(zone) ? zone : DEFAULT_ZONE;
  } catch {
    return DEFAULT_ZONE; // No state yet.
  }
}

export default function (pi: ExtensionAPI) {
  let zone = loadZone();
  let ctx: ExtensionContext | undefined;
  let index: Index | undefined;
  const used = new Set<number>();
  const when = new WeakMap<object, number>();
  const cache = new WeakMap<object, { lines: string[]; width: number; label: string; out: string[] }>();
  let restore: (() => void)[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;

  // lookup finds a tool call's or `!` command's time in the session. A miss rebuilds the index once:
  // the block may be newer than it, or live and not saved yet.
  const lookup = (block: Block, fresh = false): number | undefined => {
    if (!block.toolCallId && block.command === undefined) return undefined;
    if (!index || fresh) index = indexOf(ctx?.sessionManager.buildSessionContext().messages ?? []);
    const t = block.toolCallId ? index.tools.get(block.toolCallId) : index.bash.get(block.command ?? "")?.find((t) => !used.has(t));
    if (t === undefined) return fresh ? undefined : lookup(block, true);
    if (block.command !== undefined) used.add(t);
    return t;
  };

  // timeOf is a block's time: its entry's, else its session lookup, else when it first rendered,
  // which for a live block is when it appeared.
  const timeOf = (block: Block): number => {
    let t = when.get(block);
    if (t === undefined) {
      t = Date.parse(block.timestamp ?? "") || block.lastMessage?.timestamp || lookup(block) || Date.now();
      when.set(block, t);
    }
    return t;
  };

  const patch = (proto: { render: Render }) => {
    const own = Object.hasOwn(proto, "render");
    const original = proto.render;
    const render: Render = function (width) {
      const lines = original.call(this, width);
      const theme = ctx?.ui.theme;
      if (!theme) return lines;
      const label = clockTime(timeOf(this), zone);
      const hit = cache.get(this);
      if (hit?.lines === lines && hit.width === width && hit.label === label) return hit.out;
      const out = stamp(lines, width, label, (s) => theme.fg("dim", s), layout);
      cache.set(this, { lines, width, label, out });
      return out;
    };
    proto.render = render;
    restore.push(() => {
      if (proto.render !== render) return;
      if (own) proto.render = original;
      // SAFETY: deleting the own slot re-exposes the inherited Container/Box render.
      else delete (proto as Partial<typeof proto>).render;
    });
  };

  pi.on("session_start", (_event, c) => {
    for (const r of restore) r();
    restore = [];
    index = undefined;
    used.clear();
    if (c.mode !== "tui") return;
    ctx = c;
    // SAFETY: each name is a component class Pi exports; its prototype has a render method.
    const classes = agent as unknown as Record<string, { prototype: { render: Render } }>;
    for (const name of BLOCKS) patch(classes[name].prototype);
  });

  pi.on("session_shutdown", () => {
    for (const r of restore) r();
    restore = [];
    clearInterval(timer);
    ctx = undefined;
  });

  pi.on("agent_start", (_event, c) => {
    if (c.mode !== "tui") return;
    clearInterval(timer);
    const start = Date.now();
    const tick = () => c.ui.setWorkingMessage(`Working (${elapsed(Date.now() - start)})`);
    tick();
    timer = setInterval(tick, 1000);
    timer.unref();
  });

  pi.on("agent_end", (_event, c) => {
    clearInterval(timer);
    if (c.mode === "tui") c.ui.setWorkingMessage();
  });

  pi.registerCommand("tz", {
    description: "Show or set the time zone of transcript timestamps",
    getArgumentCompletions: (prefix) =>
      Intl.supportedValuesOf("timeZone")
        .filter((z) => z.toLowerCase().includes(prefix.toLowerCase()))
        .slice(0, 30)
        .map((z) => ({ value: z, label: z })),
    handler: async (args, c) => {
      const next = args.trim();
      if (next && !isZone(next)) {
        c.ui.notify(`Unknown time zone: ${next}`, "error");
        return;
      }
      if (next) {
        zone = next;
        mkdirSync(dirname(STATE), { recursive: true });
        writeFileSync(STATE, `${JSON.stringify({ zone })}\n`);
      }
      c.ui.notify(`Timestamps use ${zone}`, "info");
    },
  });
}
