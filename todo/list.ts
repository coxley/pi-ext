export type Status = "pending" | "in_progress" | "done" | "blocked";
export type Item = { id: number; text: string; status: Status };
// State is what the session saves as a "todo-state" entry; pix-todo used the same shape.
export type State = { todos: Item[]; nextTodoId: number; ordered: boolean };
export type Params = { action: string; items?: string; updates?: string; id?: number; status?: Status; text?: string; ordered?: boolean };

export const STATUSES: readonly Status[] = ["pending", "in_progress", "done", "blocked"];
const GLYPH: Record<Status, string> = { pending: "○", in_progress: "◐", done: "✓", blocked: "✗" };

export const empty = (): State => ({ todos: [], nextTodoId: 1, ordered: true });

// restore returns the newest saved state among session entries, or an empty one.
export function restore(entries: { type: string; customType?: string; data?: unknown }[]): State {
  const data = entries.findLast((e) => e.type === "custom" && e.customType === "todo-state")?.data as Partial<State> | undefined;
  if (!Array.isArray(data?.todos)) return empty();
  const todos = data.todos;
  return { todos, nextTodoId: data.nextTodoId ?? Math.max(0, ...todos.map((t) => t.id)) + 1, ordered: data.ordered ?? true };
}

const parseItems = (raw = "") =>
  raw
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
    .filter(Boolean);

// parseUpdates reads comma- or newline-separated "id:status" pairs, e.g. "3:done, 4:blocked".
export function parseUpdates(raw: string): { id: number; status: Status }[] {
  const ops = raw
    .split(/[,\n]/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const m = /^#?(\d+)\s*[:=]\s*(\w+)$/.exec(token);
      if (!m) throw new Error(`Bad update "${token}": want "id:status".`);
      if (!STATUSES.includes(m[2] as Status)) throw new Error(`Bad status "${m[2]}": want one of ${STATUSES.join(", ")}.`);
      return { id: Number(m[1]), status: m[2] as Status };
    });
  if (!ops.length) throw new Error('update needs `updates` ("id:status") or `id` and `status`.');
  return ops;
}

export function summary(s: State): string {
  if (!s.todos.length) return "(no todos)";
  const done = s.todos.filter((t) => t.status === "done").length;
  return `Todos ${done}/${s.todos.length} done:\n${s.todos.map((t) => `${GLYPH[t.status]} ${t.id}. ${t.text}`).join("\n")}`;
}

const next = (s: State) => s.todos.find((t) => t.status === "in_progress") ?? s.todos.find((t) => t.status === "pending");

function hint(s: State): string {
  const done = s.todos.filter((t) => t.status === "done").length;
  const n = next(s);
  return n ? `${done}/${s.todos.length} done, next #${n.id} ${n.text}` : `${done}/${s.todos.length} done, all items closed.`;
}

// apply runs one action on s in place and returns the text for the model. It throws on bad input,
// which Pi reports to the model as a failed call. On an ordered list, opening an item marks every
// earlier open item done, and closing one warns about earlier items still open.
export function apply(s: State, p: Params): string {
  switch (p.action) {
    case "list":
      return summary(s);
    case "set":
    case "add": {
      const texts = parseItems(p.items);
      if (!texts.length) throw new Error(`${p.action} needs non-empty \`items\`.`);
      if (p.action === "set") Object.assign(s, { todos: [], nextTodoId: 1, ordered: p.ordered ?? true });
      for (const text of texts) s.todos.push({ id: s.nextTodoId++, text, status: "pending" });
      return summary(s);
    }
    case "update": {
      const ops = p.updates ? parseUpdates(p.updates) : p.id !== undefined && p.status ? [{ id: p.id, status: p.status }] : [];
      const ids = ops.length ? ops.map((o) => o.id) : [p.id];
      const gone = ids.filter((id) => !s.todos.some((t) => t.id === id));
      if (gone.length) throw new Error(`No todo with id ${gone.join(", ")}.`);
      const closed: number[] = [];
      let warning = "";
      for (const op of ops) {
        const item = s.todos.find((t) => t.id === op.id)!;
        if (s.ordered && op.status === "in_progress") {
          for (const t of s.todos) {
            if (t.id < item.id && (t.status === "pending" || t.status === "in_progress")) {
              t.status = "done";
              closed.push(t.id);
            }
          }
        }
        item.status = op.status;
        const open = s.todos.filter((t) => t.id < item.id && (t.status === "pending" || t.status === "in_progress"));
        warning = s.ordered && op.status === "done" && open.length ? `\n\n⚠ Earlier items still open: ${open.map((t) => `#${t.id} (${t.text})`).join(", ")}. Mark each done or blocked first.` : "";
      }
      if (p.text && ids.length === 1) s.todos.find((t) => t.id === ids[0])!.text = p.text;
      const applied = ops.length ? ops.map((o) => `#${o.id} ${o.status}`).join(", ") : `#${ids[0]} renamed`;
      const auto = closed.length ? ` (auto-done ${closed.map((id) => `#${id}`).join(",")})` : "";
      return `${applied}${auto} · ${hint(s)}${warning}`;
    }
    case "clear":
      Object.assign(s, empty());
      return "Todos cleared.";
    default:
      throw new Error(`Unknown action: ${p.action}`);
  }
}

// recitation is a line that keeps open items in view during a long run, or undefined when none.
export function recitation(s: State): string | undefined {
  const n = next(s);
  return n && `[todo] Open items remain: ${hint(s)}. Update the list as you finish items.`;
}
