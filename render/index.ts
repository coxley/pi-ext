import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { tree } from "./view.ts";

const ICONS = { dir: "\uf07b", file: "\uf15b" };

type Context = Parameters<NonNullable<ToolRenderers["renderResult"]>>[3];
type Result = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];

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

const unwrap = (context: Context): Context => ({ ...context, lastComponent: context.lastComponent instanceof Framed ? context.lastComponent.inner : context.lastComponent });
const textOf = (result: Result) => result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

// exitOf is a bash result's exit code, or undefined when the command failed without one.
function exitOf(result: Result, isError: boolean): number | undefined {
  const s = result.structuredContent;
  const code = s && typeof s === "object" && !Array.isArray(s) ? s.exit_code : undefined;
  if (typeof code === "number") return code;
  const m = /Command exited with code (\d+)\s*$/.exec(textOf(result));
  return m ? Number(m[1]) : isError ? undefined : 0;
}

// Each decorator changes only the expanded view of a finished result. A compact row, such as
// pi-minimum-sufficient-output's one line per tool, draws everything else.
function bash(base: ToolRenderers): ToolRenderers {
  const { renderResult } = base;
  if (!renderResult) return base;
  return {
    ...base,
    renderResult(result, options, theme, context) {
      const inner = renderResult(result, options, theme, unwrap(context));
      if (!options.expanded || options.isPartial) return inner;
      return new Framed(inner, (s) => theme.fg(exitOf(result, context.isError) === 0 ? "success" : "error", s));
    },
  };
}

function ls(base: ToolRenderers): ToolRenderers {
  const { renderResult } = base;
  if (!renderResult) return base;
  return {
    ...base,
    renderResult(result, options, theme, context) {
      // Pi appends limit notices as a final "[...]" paragraph; the tree shows the entries only.
      const [listing, notice] = textOf(result).trim().split(/\n\n(?=\[)/);
      if (!options.expanded || options.isPartial || context.isError || listing === "(empty directory)") return renderResult(result, options, theme, context);
      const lines = tree(theme, listing.split("\n").filter(Boolean), ICONS);
      if (notice) lines.push(theme.fg("warning", notice));
      return new Text(`\n${lines.join("\n")}`, context.outputPad ?? 1, 0);
    },
  };
}

const DECORATE: Record<string, (base: ToolRenderers) => ToolRenderers> = { bash, ls };

export default function (pi: ExtensionAPI) {
  pi.registerToolRenderer((name, next) => {
    const base = next();
    const decorate = DECORATE[name];
    return base && decorate ? decorate(base) : base;
  });
}
