// Map a fullscreen selection inside the prompt editor to editor text offsets.
// Pure functions; index.ts reads the screen and editor state from pi-tui.
import { rowStarts } from "../md-prompt/md.ts";

// MARKER matches a paste marker as pi-tui writes it; group 1 is the paste id.
export const MARKER = /\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g;

// pasteText is the prompt text a paste registry value stands for. pi-tui stores text; chips and
// pix-pretty store tagged kinds that hold a path, a skill ref, or a prompt body.
export function pasteText(value: unknown): string {
  if (typeof value === "string") return value;
  // SAFETY: a tagged kind is a plain object; each field is read only when present.
  const v = (value ?? {}) as { path?: string; ref?: string; body?: string };
  return v.path ?? v.ref ?? v.body ?? "";
}

// expandMarkers replaces each paste marker in text with its value's pasteText. Unknown ids stay.
export function expandMarkers(text: string, pastes: Map<number, unknown>): string {
  return text.replace(MARKER, (marker, id: string) => (pastes.has(Number(id)) ? pasteText(pastes.get(Number(id))) : marker));
}

export type Point = { row: number; col: number; boundary?: boolean };

// View is the editor as drawn: its text, its layout rows, and where the visible rows sit on screen.
export type View = {
  lines: string[];
  rows: { text: string }[];
  scrollOffset: number;
  // Drawn width of each visible row. pix-pretty chips draw narrower than their markers.
  shown: number[];
  // Screen row of the first visible row, and screen column of its first text cell.
  top: number;
  left: number;
};

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// indexAt returns the index of the first grapheme in text that starts at or after column col.
function indexAt(text: string, col: number, width: (s: string) => number): number {
  let w = 0;
  for (const { segment, index } of graphemes.segment(text)) {
    if (w >= col) return index;
    w += width(segment);
  }
  return text.length;
}

// editorRange returns [from, to) offsets into lines.join("\n") for a selection from start to end
// (end cell inclusive unless end.boundary). Points on the frame clamp to the nearest text row;
// a column past a row's drawn text means the row's end.
export function editorRange(view: View, start: Point, end: Point, width: (s: string) => number): [number, number] {
  const starts = rowStarts(view.rows, view.lines);
  const lineStart: number[] = [];
  for (let i = 0, at = 0; i < view.lines.length; at += view.lines[i].length + 1, i++) lineStart.push(at);
  const last = view.shown.length - 1;
  const offset = (p: Point, isEnd: boolean): number => {
    const r = Math.min(Math.max(p.row - view.top, 0), last);
    let col = p.col - view.left + (isEnd && !p.boundary ? 1 : 0);
    if (p.row < view.top) col = 0;
    if (p.row > view.top + last || col >= view.shown[r]) col = Infinity;
    const k = view.scrollOffset + r;
    const { line, start: at } = starts[k];
    return lineStart[line] + Math.max(at, 0) + indexAt(view.rows[k].text, col, width);
  };
  return [offset(start, false), offset(end, true)];
}

// A list item's marker, with an optional task box, as pi-tui or pi-better-render draws it.
const ITEM = /^\s*(?:[-*+•◦▪☐☑]|\d+[.)])\s+(?:[☐☑]\s+|\[[ x]\]\s+)?/;
// Rows that start a list item, quote, table, heading, rule, or fence.
const BLOCK = /^\s*(?:#{1,6}\s|[-*+•◦▪☐☑]\s|\d+[.)]\s|[>│▎┃┌├└╭╰─|]|```|~~~)/;
const CODE = /^\s*(?:import|export|const|let|var|function|class|interface|type|if|else|for|while|switch|case|return|throw|try|catch)\b|[{};]\s*$/;

// unwrapRows joins the screen rows of a selection that are soft wraps of one line. Inside a list
// item, only rows at the item's hanging indent join it. Elsewhere it keeps a break at block
// starts, indented code, and code-like rows. Blank rows always break. startCol is the screen
// column of the first row; it aligns that row with the rest. When every row has a leading space
// (Pi's outputPad gutter), the rows lose it. URLs and paths join without a space.
// Adapted from pi-copy-soft-wrap (MIT, Hasan Burak Taşyürek).
export function unwrapRows(text: string, startCol = 0): string {
  const raw = text.split("\n");
  const cols = [" ".repeat(startCol) + raw[0], ...raw.slice(1)];
  const gutter = cols.every((row) => !row.trim() || row.startsWith(" ")) ? 1 : 0;
  const rows = cols.map((row) => row.slice(gutter));
  let hang = rows[0].match(ITEM)?.[0].length ?? -1;
  let out = startCol > 0 ? raw[0] : rows[0];
  for (let i = 1; i < rows.length; i++) {
    const [left, right] = [rows[i - 1], rows[i]];
    const lead = right.length - right.trimStart().length;
    const join =
      !!left.trim() &&
      !!right.trim() &&
      !BLOCK.test(right) &&
      (hang >= 0 ? lead === hang : !BLOCK.test(left) && lead < 4 && !CODE.test(left) && !CODE.test(right));
    const item = right.match(ITEM)?.[0].length;
    hang = item ?? (join ? hang : -1);
    if (!join) {
      out += `\n${right}`;
      continue;
    }
    const tail = left.trimEnd().match(/\S+$/)?.[0] ?? "";
    const head = right.trimStart();
    const tight = /^(?:https?:\/\/|www\.)/.test(tail) || (/[/._?&=#%+-]$/.test(tail) && /^[\w/._?&=#%+-]/.test(head));
    out += (tight ? "" : " ") + head;
  }
  return out;
}
