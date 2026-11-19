import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { host } from "../test-host.ts";
import { classify, loopTracker, nudgeFor } from "./rules.ts";

test("classify finds bash commands that stand in for a tool", () => {
  for (const [command, want] of [
    ["cat a.txt", "read"],
    ["sed -n '10,40p' f.ts", "read"],
    ["rtk grep -n foo src", "grep"],
    ["FOO=1 ls -la", "ls"],
    ["git log | head -5", undefined],
    ["grep -rn foo . | head -20", "grep"],
    ["cat x || ls y", "read"],
    ["cd src; find . -name '*.ts'", "find"],
    ["sed -i 's/a/b/' f", "edit"],
    ["cat x | jq .", undefined],
    ["git log | cat", undefined],
    ["grep x y > out", undefined],
    ["npm test", undefined],
    ["cat > notes.md <<'EOF'\nhi\nEOF", "heredoc"],
    ["tee -a src/a.ts <<EOF\nx\nEOF", "heredoc"],
    ["cat > /tmp/x <<EOF\nhi\nEOF", undefined],
    ['cat > "$TMPDIR/x" <<EOF\nhi\nEOF', undefined],
    ["T=$(mktemp -d); cat > $T/probe.ts <<'EOF'\nx\nEOF", undefined],
    ["cat > $HOME/real.ts <<'EOF'\nx\nEOF", "heredoc"],
    ["python3 - <<'EOF'\nopen('out.json', 'w').write('{}')\nEOF", "heredoc"],
    ["D=$(mktemp -d); python3 - \"$D\" <<'EOF'\nopen(sys.argv[1] + '/x', 'w')\nEOF", undefined],
  ] as const) {
    assert.equal(classify(command)?.category, want, command);
  }
});

test("nudgeFor names only tools the session has", () => {
  const read = classify("cat a")!;
  assert.match(nudgeFor(read, new Set(["read"]), ["read"])!, /^\[nudge\] Reading .* Use `read` \(offset\/limit pick lines\) instead\./);
  assert.match(nudgeFor(read, new Set(["read", "tool_search"]), [])!, /Load `read` with tool_search, then call it/);
  assert.equal(nudgeFor(read, new Set(["read"]), []), undefined, "deferred, and nothing can load it");
  assert.equal(nudgeFor(read, new Set(["bash"]), ["bash"]), undefined, "not installed");
  const heredoc = classify("cat > a.md <<EOF\nx\nEOF")!;
  assert.doesNotMatch(nudgeFor(heredoc, new Set(["write"]), ["write"])!, /edit/, "the hint names edit, which is missing");
});

test("loopTracker flags a repeated call or cycle once, until the pattern breaks", () => {
  const track = loopTracker();
  const ok = (tool: string, out = "same") => track(tool, { a: 1 }, [{ type: "text", text: out }]);
  assert.equal(ok("read"), undefined);
  assert.equal(ok("read"), undefined);
  assert.deepEqual(ok("read"), ["read"]);
  assert.equal(ok("read"), undefined, "flagged once");
  assert.equal(ok("read", "changed"), undefined, "new output breaks it");

  const cycle = loopTracker();
  const seen = ["a", "b", "a", "b", "a", "b"].map((t) => cycle(t, {}, [{ type: "text", text: t }]));
  assert.deepEqual(seen.at(-1), ["a", "b"]);

  const failing = loopTracker();
  const fail = (arg: number) => failing("edit", { arg }, [{ type: "text", text: `old text not found\nat ${arg}` }], true);
  assert.deepEqual([fail(1), fail(2), fail(3)], [undefined, undefined, ["edit"]], "same first error line, different arguments");
});

test("the extension appends one nudge per category, and leaves other results alone", async () => {
  const { loadExtensions } = await host("@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  const { extensions, runtime, errors } = await loadExtensions([resolve(import.meta.dirname, "index.ts")], tmpdir());
  assert.deepEqual(errors, []);
  Object.assign(runtime, { getAllTools: () => [{ name: "read" }, { name: "bash" }], getActiveTools: () => ["read", "bash"] });
  const result = async (toolName: string, input: object, text: string) => {
    const event = { type: "tool_result", toolCallId: text, toolName, input, content: [{ type: "text", text }], isError: false };
    for (const h of extensions[0].handlers.get("tool_result") ?? []) {
      const out = await h(event, {});
      if (out) return out.content.map((c: { text: string }) => c.text);
    }
    return undefined;
  };
  assert.deepEqual((await result("bash", { command: "cat a" }, "1"))?.length, 2);
  assert.equal(await result("bash", { command: "cat b" }, "2"), undefined, "once per category");
  assert.equal(await result("bash", { command: "npm test" }, "3"), undefined);
  assert.equal(await result("read", { path: "a" }, "4"), undefined);
});
