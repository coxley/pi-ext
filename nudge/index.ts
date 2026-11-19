import { type ExtensionAPI, isBashToolResult } from "@earendil-works/pi-coding-agent";
import { classify, loopReason, loopTracker, nudgeFor } from "./rules.ts";

// The model reads tool results, not UI notices, so each nudge is a line appended to the result. The
// call always runs: blocking it costs the model a retry turn.
export default function (pi: ExtensionAPI) {
  const nudged = new Set<string>();
  const track = loopTracker();

  pi.on("tool_result", (event) => {
    const notes: string[] = [];
    const rule = isBashToolResult(event) ? classify(event.input.command) : undefined;
    if (rule && !nudged.has(rule.category)) {
      const text = nudgeFor(rule, new Set(pi.getAllTools().map((t) => t.name)), pi.getActiveTools());
      if (text) {
        nudged.add(rule.category);
        notes.push(text);
      }
    }
    const loop = track(event.toolName, event.input, event.content, event.isError);
    if (loop) notes.push(loopReason(loop, event.isError === true));
    if (!notes.length) return undefined;
    return { content: [...(event.content ?? []), ...notes.map((text) => ({ type: "text" as const, text }))], structuredContent: event.structuredContent };
  });
}
