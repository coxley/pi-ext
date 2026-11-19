import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { apply, empty, type Item, type Params, recitation, restore, STATUSES, type Status } from "./list.ts";

// RECITE_EVERY is how many tool results, within one agent run, pass between reminders of the open
// items. A reminder rides on a tool result: it never joins a prompt you send or starts a turn.
const RECITE_EVERY = 25;
const COLOR: Record<Status, string> = { pending: "text", in_progress: "accent", done: "success", blocked: "error" };
const GLYPH: Record<Status, string> = { pending: "○", in_progress: "◐", done: "✓", blocked: "✗" };

type Details = { snapshot: Item[] };

export default function (pi: ExtensionAPI) {
  let state = empty();
  let calls = 0;

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Track execution progress. Durable across context compaction. Actions: list, set (replace all items from newline/numbered text), add, update (change one or more items' status; batch via `updates`), clear.",
    promptSnippet: "todo(action, items?, updates?, id?, status?, text?, ordered?): action is list|set|add|update|clear. Track progress on a multi-step task.",
    promptGuidelines: [
      "When you start a multi-step plan, seed the list with `todo(action:'set', items: <steps>)`.",
      "Batch status changes in one call: `todo(action:'update', updates:'3:done,4:in_progress')`. On an ordered list, opening an item marks earlier ones done.",
      "When marking an item done, the tool warns about earlier open items: mark each done or blocked before moving on.",
      "For independent items done in any order, pass `ordered:false` on `set`.",
      "Call `todo(action:'list')` to find your place after a long run or a compaction.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "set", "add", "update", "clear"] as const),
      items: Type.Optional(Type.String({ description: "For set/add: newline-separated or numbered todo texts." })),
      updates: Type.Optional(Type.String({ description: 'For update: comma-separated "id:status" pairs, e.g. "3:done,4:in_progress".' })),
      id: Type.Optional(Type.Number({ description: "For update: one todo id." })),
      status: Type.Optional(StringEnum(STATUSES)),
      text: Type.Optional(Type.String({ description: "For update with id: new text." })),
      ordered: Type.Optional(Type.Boolean({ description: "For set: true (default) for a sequential run, false for independent items." })),
    }),
    async execute(_id, params) {
      const before = JSON.stringify(state);
      const text = apply(state, params as Params);
      if (JSON.stringify(state) !== before) pi.appendEntry("todo-state", state);
      const details: Details = { snapshot: state.todos.map((t) => ({ ...t })) };
      return { content: [{ type: "text", text }], details };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("todo"))} ${theme.fg("dim", String(args.action ?? ""))}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      // SAFETY: execute always sets details to Details; a failed call has no details.
      const snapshot = (result.details as Details | undefined)?.snapshot;
      if (!snapshot) return new Text(result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"), 0, 0);
      if (!snapshot.length) return new Text(theme.fg("muted", "(no todos)"), 0, 0);
      const line = (t: Item) => {
        const row = theme.fg(COLOR[t.status], `${GLYPH[t.status]} ${t.id}. ${t.text}`);
        return t.status === "in_progress" ? theme.bold(row) : row;
      };
      return new Text(snapshot.map(line).join("\n"), 0, 0);
    },
  });

  pi.on("agent_start", () => {
    calls = 0;
  });

  pi.on("tool_result", (event) => {
    if (++calls % RECITE_EVERY !== 0 || event.toolName === "todo") return undefined;
    const text = recitation(state);
    if (!text) return undefined;
    return { content: [...(event.content ?? []), { type: "text" as const, text }], structuredContent: event.structuredContent };
  });

  pi.on("session_start", (_event, ctx) => {
    state = restore(ctx.sessionManager.getEntries());
  });
}
