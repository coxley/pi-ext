import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { duration, row, summarize, tree } from "./view.ts";

// COLLAPSE_MS is how long a finished bash or ls row stays open before it folds to one line.
const COLLAPSE_MS = 5000;
const LS_LINES = 20;
const ICONS = { dir: "\uf07b", file: "\uf15b" };

type Renderers = ToolRenderers;
type Context = Parameters<NonNullable<Renderers["renderResult"]>>[3];
type Result = Parameters<NonNullable<Renderers["renderResult"]>>[0];
type State = { collapsed?: boolean; timer?: ReturnType<typeof setTimeout> };

// Framed draws a rule above and below a result, colored by its status.
class Framed implements Component {
  constructor(
    readonly inner: Component,
    private paint: (s: string) => string,
  ) {}
  render(width: number): string[] {
    const lines = this.inner.render(width);
    const start = lines.findIndex((line) => line.trim() !== "");
    const rule = this.paint("─".repeat(width));
    return [rule, ...(start < 0 ? [] : lines.slice(start)), rule];
  }
  invalidate(): void {
    this.inner.invalidate();
  }
}

// folded starts a finished row's collapse timer once, and is true while the row shows as one line.
function folded(context: Context): boolean {
  const state: State = context.state;
  if (!state.timer && !state.collapsed) {
    state.timer = setTimeout(() => {
      state.collapsed = true;
      context.invalidate();
    }, COLLAPSE_MS);
  }
  return state.collapsed === true && !context.expanded;
}

const unwrap = (context: Context): Context => ({ ...context, lastComponent: context.lastComponent instanceof Framed ? context.lastComponent.inner : undefined });
const textOf = (result: Result) => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const field = (result: Result, key: string) => {
  const s = result.structuredContent;
  return s && typeof s === "object" && !Array.isArray(s) ? s[key] : undefined;
};

// exitOf is a bash result's exit code, or undefined when the command failed without one.
function exitOf(result: Result, isError: boolean): number | undefined {
  const code = field(result, "exit_code");
  if (typeof code === "number") return code;
  const m = /Command exited with code (\d+)\s*$/.exec(textOf(result));
  return m ? Number(m[1]) : isError ? undefined : 0;
}

function bash(base: Renderers): Renderers {
  const { renderCall, renderResult } = base;
  if (!renderCall || !renderResult) return base;
  return {
    ...base,
    renderCall(args, theme, context) {
      const state: State = context.state;
      return state.collapsed && !context.expanded ? new Text("", 0, 0) : renderCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return renderResult(result, options, theme, unwrap(context));
      const code = exitOf(result, context.isError);
      const ok = code === 0;
      if (folded(context)) {
        // Pi ends a failed command's text with a status line; it is not the command's output.
        const output = textOf(result).replace(/\n*Command (?:exited with code \d+|timed out[^\n]*|aborted)\s*$/, "").trim();
        const lines = output ? output.split("\n").length : 0;
        const wall = field(result, "wall_time_seconds");
        const ms = context.durationMs ?? (typeof wall === "number" ? wall * 1000 : undefined);
        const why = /Command (timed out|aborted)/.exec(textOf(result))?.[1] ?? "failed";
        const facts = [!ok && (code === undefined ? why : `exit ${code}`), lines > 0 && `${lines} ${lines === 1 ? "line" : "lines"}`, ms !== undefined && duration(ms)];
        return new Text(row(theme, ok, "bash", summarize(String(context.args?.command ?? "")), facts), 0, 0);
      }
      return new Framed(renderResult(result, options, theme, unwrap(context)), (s) => theme.fg(ok ? "success" : "error", s));
    },
  };
}

function ls(base: Renderers): Renderers {
  const { renderCall, renderResult } = base;
  if (!renderCall || !renderResult) return base;
  return {
    ...base,
    renderCall(args, theme, context) {
      const state: State = context.state;
      return state.collapsed && !context.expanded ? new Text("", 0, 0) : renderCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      // Pi appends limit notices as a final "[...]" paragraph; the tree shows the entries only.
      const [listing, notice] = textOf(result).trim().split(/\n\n(?=\[)/);
      const entries = listing.split("\n").filter(Boolean);
      if (options.isPartial || context.isError || listing === "(empty directory)") return renderResult(result, options, theme, context);
      if (folded(context)) return new Text(row(theme, true, "ls", String(context.args?.path || "."), [`${entries.length} ${entries.length === 1 ? "entry" : "entries"}`, notice && "truncated"]), 0, 0);
      const shown = options.expanded ? entries : entries.slice(0, LS_LINES);
      const lines = tree(theme, shown, ICONS, entries.length > shown.length);
      if (entries.length > shown.length) lines.push(`${theme.fg("muted", `… ${entries.length - shown.length} more,`)} ${context.keyHint("app.tools.expand", "to expand")}`);
      if (notice) lines.push(theme.fg("warning", notice));
      return new Text(`\n${lines.join("\n")}`, 0, 0);
    },
  };
}

const DECORATE: Record<string, (base: Renderers) => Renderers> = { bash, ls };

export default function (pi: ExtensionAPI) {
  pi.registerToolRenderer((name, next) => {
    const base = next();
    const decorate = DECORATE[name];
    return base && decorate ? decorate(base) : base;
  });
}
