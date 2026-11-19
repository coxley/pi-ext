export type Paint = { fg(color: string, text: string): string };

// tree draws a directory listing, one entry per line with dirs ending in "/", as a one-level tree.
export function tree(p: Paint, entries: string[], icons: { dir: string; file: string }): string[] {
  return entries.map((entry, i) => {
    const branch = p.fg("muted", i === entries.length - 1 ? "└── " : "├── ");
    return entry.endsWith("/") ? `${branch}${p.fg("accent", `${icons.dir} ${entry}`)}` : `${branch}${p.fg("dim", icons.file)} ${entry}`;
  });
}
