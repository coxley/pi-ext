export type Paint = { fg(color: string, text: string): string; bold(text: string): string };

// summarize is a one-line gist of a shell command: its first step, and how many steps follow.
export function summarize(command: string): string {
  const lines = command
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "set -e" && !line.startsWith("#"));
  const steps = lines.flatMap((line) => line.split(/\s*(?:&&|\|\||;)\s*/)).filter(Boolean);
  if (!steps.length) return "command";
  if (/^(?:export\s+)?[A-Za-z_]\w*=|^(?:if|for|while|case)\b/.test(steps[0])) return `shell script · ${lines.length} lines`;
  return steps.length > 1 ? `${steps[0].replace(/\s+/g, " ")} +${steps.length - 1} steps` : steps[0].replace(/\s+/g, " ");
}

export function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

// row is a collapsed tool's one line: status glyph, tool name, gist, and dot-joined facts.
export function row(p: Paint, ok: boolean, tool: string, gist: string, facts: (string | false | undefined)[]): string {
  const meta = facts.filter(Boolean).join(" · ");
  const tail = [gist && p.fg("dim", gist), meta && p.fg("muted", meta)].filter(Boolean).join(p.fg("muted", " · "));
  return [p.fg(ok ? "success" : "error", ok ? "✓" : "✗"), p.fg("toolTitle", p.bold(tool)), tail].filter(Boolean).join(" ");
}

// tree draws a directory listing, one entry per line with dirs ending in "/", as a one-level tree.
// more means entries follow the ones shown, so the last shown entry keeps an open branch.
export function tree(p: Paint, entries: string[], icons: { dir: string; file: string }, more = false): string[] {
  return entries.map((entry, i) => {
    const branch = p.fg("muted", i === entries.length - 1 && !more ? "└── " : "├── ");
    return entry.endsWith("/") ? `${branch}${p.fg("accent", `${icons.dir} ${entry}`)}` : `${branch}${p.fg("dim", icons.file)} ${entry}`;
  });
}
