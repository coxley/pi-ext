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
