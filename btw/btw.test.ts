import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { host } from "../test-host.ts";
import { excerpt, parse } from "./context.ts";

test("excerpt keeps the last user and assistant text", () => {
  const messages = [
    { role: "user", content: "old" },
    { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "a1" }] },
    { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
    { role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
    { role: "user", content: [{ type: "text", text: "q2" }] },
  ];
  assert.equal(excerpt(messages, 2), "Assistant: a1\n\nUser: q2");
  assert.equal(excerpt([]), "");
  assert.deepEqual(parse(" --no-ctx why  is it "), { question: "why is it", withContext: false });
  assert.deepEqual(parse("why"), { question: "why", withContext: true });
});

test("/btw answers in a display-only card, next to the main agent", async () => {
  const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  const { extensions, runtime, errors } = await loadExtensions([resolve(import.meta.dirname, "index.ts")], tmpdir());
  assert.deepEqual(errors, []);
  const entries: [string, Record<string, unknown>][] = [];
  Object.assign(runtime, { appendEntry: (type: string, data: Record<string, unknown>) => entries.push([type, data]), getThinkingLevel: () => "high" });

  const notes: string[] = [];
  const widgets: (string[] | undefined)[] = [];
  const asked: { text: string; options: { reasoning: string; signal: AbortSignal } }[] = [];
  let reply: (m: object) => void = () => {};
  const ctx = {
    model: { id: "m1", name: "Model One" },
    ui: { notify: (m: string) => notes.push(m), setWidget: (_k: string, lines?: string[]) => widgets.push(lines), theme: { fg: (_c: string, s: string) => s } },
    sessionManager: { buildSessionContext: () => ({ messages: [{ role: "user", content: "fix the parser" }] }) },
    modelRegistry: {
      streamSimple: (_m: unknown, context: { messages: { content: { text: string }[] }[] }, options: { reasoning: string; signal: AbortSignal }) => {
        asked.push({ text: context.messages[0].content[0].text, options });
        return { result: () => new Promise((r) => (reply = r)) };
      },
    },
  };
  const { handler } = extensions[0].commands.get("btw");
  const settle = () => new Promise((r) => setImmediate(r));

  await handler("", ctx);
  assert.match(notes[0], /^Usage/);

  await handler("what changed?", ctx);
  assert.deepEqual(widgets.at(-1), ["◌ btw what changed?"], "running asides show above the editor");
  assert.match(asked[0].text, /User: fix the parser[\s\S]*Question: what changed\?$/);
  assert.equal(asked[0].options.reasoning, "high");
  reply({ stopReason: "stop", content: [{ type: "text", text: "The parser." }] });
  await settle();
  assert.equal(widgets.at(-1), undefined, "the widget clears when no aside runs");
  assert.deepEqual(entries.map(([type, d]) => [type, d.question, d.answer, d.model]), [["btw", "what changed?", "The parser.", "Model One"]]);

  await handler("--no-ctx why?", ctx);
  assert.equal(asked[1].text, "why?");
  reply({ stopReason: "error", errorMessage: "rate limited", content: [] });
  await settle();
  assert.equal(entries[1][1].error, "rate limited");

  await handler("late?", ctx);
  extensions[0].handlers.get("session_shutdown")[0]({}, ctx);
  assert.ok(asked[2].options.signal.aborted, "shutdown aborts running asides");
  reply({ stopReason: "aborted", content: [] });
  await settle();
  assert.equal(entries.length, 2, "an aborted aside posts no card");

  const { initTheme, theme } = await host("@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
  initTheme("dark");
  const card = extensions[0].entryRenderers.get("btw")({ data: entries[0][1] }, { expanded: false }, theme);
  const plain = card.render(40).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter(Boolean);
  assert.match(plain[0], /^✓ btw · Model One · \d+\.\ds$/);
  assert.deepEqual(plain.slice(1), ["what changed?", "The parser."]);
});
