// Markdown styling for pi-tui editor rows. Pure functions; index.ts wires them into the Editor.

// Targeted off codes, not a full reset: the fake cursor's inverse video (7/27) must survive.
const OFF = "\x1b[22;23;24;29;39m";
// CSI, OSC and APC sequences (cursor markers) are zero-width.
const ESC = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[_\]][^\x07]*\x07)/y;
const INLINE: [RegExp, string][] = [
  [/\*\*(?!\s).+?(?<!\s)\*\*/g, "1"],
  [/(?<![*\w])\*(?![\s*]).*?(?<![\s*])\*(?![*\w])/g, "3"],
  [/~~(?!\s).+?(?<!\s)~~/g, "9"],
  [/\[[^\]\n]+\]\([^)\s]+\)/g, "4"],
];

// styleLines returns one SGR parameter string per UTF-16 unit of each line ("" is unstyled).
// Markers stay visible, so cursor columns and wrapping do not change.
export function styleLines(lines: string[]): string[][] {
  let fence = false;
  return lines.map((line) => {
    const s = Array<string>(line.length).fill("");
    const set = (from: number, to: number, code: string) => {
      for (let i = from; i < to; i++) s[i] = s[i] ? `${s[i]};${code}` : code;
    };
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      set(0, line.length, "2");
      return s;
    }
    if (fence) {
      set(0, line.length, "33");
      return s;
    }
    if (/^#{1,6}\s/.test(line)) set(0, line.length, "1;36");
    const quote = /^\s*(?:>\s?)+/.exec(line)?.[0];
    const list = /^\s*(?:[-*+]|\d+[.)])(?=\s)/.exec(line)?.[0];
    if (quote) {
      set(0, quote.length, "34");
      set(quote.length, line.length, "3");
    } else if (list) set(0, list.length, "34");
    // Code spans hide their content from the other inline rules.
    let masked = line;
    for (const m of line.matchAll(/`[^`]+`/g)) {
      set(m.index, m.index + m[0].length, "33");
      masked = masked.slice(0, m.index) + "\0".repeat(m[0].length) + masked.slice(m.index + m[0].length);
    }
    for (const [re, code] of INLINE) for (const m of masked.matchAll(re)) set(m.index, m.index + m[0].length, code);
    return s;
  });
}

// rowStarts maps each layout row to its logical line and start offset. Rows are in-order slices of their line.
export function rowStarts(rows: { text: string }[], lines: string[]): { line: number; start: number }[] {
  let li = 0;
  let pos = 0;
  return rows.map(({ text }) => {
    const line = lines[li] ?? "";
    const at = line.indexOf(text, pos);
    const row = { line: li, start: at };
    if (at >= 0) pos = at + text.length;
    if (!line.slice(pos).trim()) [li, pos] = [li + 1, 0];
    return row;
  });
}

// paint applies styles to a rendered row: pad columns of padding, then the row's text with zero-width codes inside.
// The row's own SGR codes since their last reset are sent again after paint's off codes, so a
// span painted over styled text does not turn that style off for the rest of the row.
export function paint(row: string, pad: number, styles: string[]): string {
  let out = "";
  let cur = "";
  let held = "";
  for (let i = 0, j = 0; i < row.length; ) {
    ESC.lastIndex = i;
    const esc = ESC.exec(row);
    if (esc) {
      out += esc[0];
      if (esc[0] === OFF || esc[0] === "\x1b[0m" || esc[0] === "\x1b[m") held = "";
      else if (/^\x1b\[[0-9;]*m$/.test(esc[0])) held += esc[0];
      i += esc[0].length;
      continue;
    }
    const want = styles[j - pad] ?? "";
    if (want !== cur) {
      out += (cur ? OFF + held : "") + (want ? `\x1b[${want}m` : "");
      cur = want;
    }
    const n = (row.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    out += row.slice(i, i + n);
    i += n;
    j += n;
  }
  return cur ? out + OFF : out;
}
