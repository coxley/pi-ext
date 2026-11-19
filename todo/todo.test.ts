import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { host } from "../test-host.ts";
import { apply, empty, recitation, restore } from "./list.ts";

const statuses = (s: ReturnType<typeof empty>) => s.todos.map((t) => `${t.id}:${t.status}`).join(" ");

test("set, add, update and clear keep the list and tell the model what changed", () => {
  const s = empty();
  assert.equal(apply(s, { action: "set", items: "1. Build\n2. Test\n- Ship" }), "Todos 0/3 done:\n○ 1. Build\n○ 2. Test\n○ 3. Ship");
  assert.equal(apply(s, { action: "update", updates: "2:in_progress" }), "#2 in_progress (auto-done #1) · 1/3 done, next #2 Test", "opening #2 closes #1");
  assert.match(apply(s, { action: "update", id: 3, status: "done" }), /⚠ Earlier items still open: #2 \(Test\)/);
  assert.equal(apply(s, { action: "update", id: 2, text: "Test all" }), "#2 renamed · 2/3 done, next #2 Test all");
  apply(s, { action: "add", items: "Tag" });
  assert.equal(statuses(s), "1:done 2:in_progress 3:done 4:pending");
  assert.equal(apply(s, { action: "clear" }), "Todos cleared.");
  assert.deepEqual(s, empty());
});

test("an unordered list neither closes earlier items nor warns", () => {
  const s = empty();
  apply(s, { action: "set", items: "a\nb\nc", ordered: false });
  assert.equal(apply(s, { action: "update", updates: "3:done, #2:in_progress" }), "#3 done, #2 in_progress · 1/3 done, next #2 b");
  assert.equal(statuses(s), "1:pending 2:in_progress 3:done");
});

test("bad input throws, which Pi reports as a failed call", () => {
  const s = empty();
  apply(s, { action: "set", items: "a" });
  assert.throws(() => apply(s, { action: "set", items: " \n" }), /needs non-empty `items`/);
  assert.throws(() => apply(s, { action: "update", updates: "1:finished" }), /Bad status "finished"/);
  assert.throws(() => apply(s, { action: "update", updates: "one" }), /want "id:status"/);
  assert.throws(() => apply(s, { action: "update", id: 9, status: "done" }), /No todo with id 9/);
  assert.throws(() => apply(s, { action: "nope" }), /Unknown action/);
});

test("restore takes the newest saved list, including pix-todo's", () => {
  const entry = (todos: unknown) => ({ type: "custom", customType: "todo-state", data: { todos, remind: true } });
  const s = restore([entry([{ id: 1, text: "old", status: "done" }]), { type: "message" }, entry([{ id: 4, text: "new", status: "pending" }])]);
  assert.deepEqual(s, { todos: [{ id: 4, text: "new", status: "pending" }], nextTodoId: 5, ordered: true });
  assert.deepEqual(restore([{ type: "custom", customType: "todo-state", data: {} }]), empty());
});

test("recitation names the next open item, and nothing when all are closed", () => {
  const s = empty();
  apply(s, { action: "set", items: "a\nb" });
  assert.equal(recitation(s), "[todo] Open items remain: 0/2 done, next #1 a. Update the list as you finish items.");
  apply(s, { action: "update", updates: "1:done,2:blocked" });
  assert.equal(recitation(s), undefined);
});

test("the extension saves each change and reminds every 25th tool result in a run", async () => {
  const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  const { extensions, runtime, errors } = await loadExtensions([resolve(import.meta.dirname, "index.ts")], tmpdir());
  assert.deepEqual(errors, []);
  const saved: unknown[] = [];
  Object.assign(runtime, { appendEntry: (type: string, data: unknown) => saved.push([type, JSON.parse(JSON.stringify(data))]) });
  const ext = extensions[0];
  const emit = async (type: string, event: object, ctx: object = {}) => {
    let out;
    for (const h of ext.handlers.get(type) ?? []) out = (await h({ type, ...event }, ctx)) ?? out;
    return out;
  };
  await emit("session_start", {}, { sessionManager: { getEntries: () => [] } });
  const tool = ext.tools.get("todo").definition;
  const run = (params: object) => tool.execute("call", params, undefined, undefined, {});
  await run({ action: "set", items: "a\nb" });
  await run({ action: "list" });
  assert.equal(saved.length, 1, "list changes nothing, so it saves nothing");
  assert.deepEqual(saved[0], ["todo-state", { todos: [{ id: 1, text: "a", status: "pending" }, { id: 2, text: "b", status: "pending" }], nextTodoId: 3, ordered: true }]);

  const theme = { fg: (c: string, s: string) => `<${c}>${s}`, bold: (s: string) => `*${s}*` };
  const shown = tool.renderResult(await run({ action: "update", updates: "2:in_progress" }), {}, theme, {}).render(40);
  assert.deepEqual(shown.map((l: string) => l.trimEnd()), ["<success>✓ 1. a", "*<accent>◐ 2. b*"], "done in green, the open item bold");
  await run({ action: "update", updates: "2:pending" });

  await emit("agent_start", {});
  const result = () => emit("tool_result", { toolName: "bash", content: [{ type: "text", text: "ok" }] });
  for (let i = 1; i < 25; i++) assert.equal(await result(), undefined);
  assert.match((await result()).content[1].text, /^\[todo\] Open items remain: 1\/2 done, next #2 b/);
});
