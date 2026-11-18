// Expand a pasted-twice pill in a pi-tui Editor. Shared by this extension and
// other editors that import it.
import { oneUndoStep } from "../compat.ts";

// samePaste ignores trailing newlines: copy sources differ by one for the same text.
export const samePaste = (a: string, b: string) => a.replace(/\n+$/, "") === b.replace(/\n+$/, "");

// The editor surface expandPair uses: pi-tui's Editor, and Pi's CustomEditor built on it.
export interface PairEditor {
  getCursor(): { line: number; col: number };
  getLines(): string[];
  handleInput(data: string): void;
  insertTextAtCursor(text: string): void;
}

const PILL = String.raw`\[paste #(\d+)[^\]]*\]`;
// Two pills that end at the cursor, each with the optional space pix-pretty adds after a chip.
const PAIR = new RegExp(`${PILL} ?${PILL}( ?)$`);

// expandPair replaces the two adjacent pills before the cursor, when both hold
// the same text, with one literal copy of the first pill's text. Other pills
// keep their markers. When only a quote prefix (`> `, `> > `) precedes the pair
// on its line, every pasted line gets that prefix. Returns false and changes
// nothing unless the text before the cursor ends with such a pair.
export function expandPair(editor: PairEditor): boolean {
  const { line, col } = editor.getCursor();
  const before = editor.getLines()[line]?.slice(0, col) ?? "";
  const m = before.match(PAIR);
  // SAFETY: pi-tui keeps paste text in the TS-private `pastes` map, a runtime property; pix-pretty uses it too.
  const pastes = (editor as unknown as { pastes?: Map<number, unknown> }).pastes;
  const [text, dup] = m ? [pastes?.get(Number(m[1])), pastes?.get(Number(m[2]))] : [];
  if (!m || typeof text !== "string" || typeof dup !== "string" || !samePaste(text, dup)) return false;
  // A pill deletes as one unit; each separator space is one more backspace.
  const deletes = 2 + m[0].replace(new RegExp(PILL, "g"), "").length;
  const quote = quoteOnly(before.slice(0, m.index));
  const body = quote ? quoteLines(text.replace(/\n+$/, ""), quote) : text;
  oneUndoStep(editor, () => {
    for (let i = 0; i < deletes; i++) editor.handleInput("\x7f");
    editor.insertTextAtCursor(body + m[3]);
  });
  return true;
}

// quoteLines prefixes every line after the first with quote; the first line already follows it.
function quoteLines(text: string, quote: string): string {
  const [first, ...rest] = text.split("\n");
  return [first, ...rest.map((l) => (l ? quote + l : quote.trimEnd()))].join("\n");
}

// quoteOnly returns before when it is only a quote prefix (`> `, `> > `), else undefined.
export const quoteOnly = (before: string) => /^\s*(?:> ?)+$/.exec(before)?.[0];

// LEAD splits a line's prefix: [1] quote (`> `, `> > `), then a list item: [2] indentation,
// [3] bullet (`-`, `*`, `+`), or [4] number or [5] letter (a-y, A-Y) with [6] `.` or `)`, then
// [7] its spaces and [8] a task box (`[ ] `, `[x] `). A `z.` item has no next letter, so it is plain text.
const LEAD = /^((?:\s*> ?)*)(?:(\s*)(?:([-*+])|(?:(\d{1,9})|([a-yA-Y]))([.)]))( +)(\[[ xX]\] +)?)?/;

// Lead is a line's parsed prefix. quote is normalized to end in one space; end is the prefix
// length in line. marker and next are undefined when the line is no list item.
type Lead = { quote: string; raw: string; indent: string; marker?: string; next?: string; ordered: boolean; spaces: string; box: string; end: number };

function lead(line: string): Lead {
  // Every part of LEAD is optional, so it always matches.
  const m = LEAD.exec(line) as RegExpExecArray;
  const [, raw, indent = "", bullet, num, letter = "", delim = "", spaces, box = ""] = m;
  const base = { quote: raw ? `${raw.trimEnd()} ` : "", raw, indent, ordered: !bullet, spaces: spaces ?? "", box, end: m[0].length };
  if (spaces === undefined) return base;
  const marker = (n: number, l: string) => bullet ?? `${num ? n : l}${delim}`;
  return {
    ...base,
    marker: marker(Number(num), letter),
    next: marker(Number(num) + 1, String.fromCharCode(letter.charCodeAt(0) + 1)),
  };
}

// lineLead returns the prefix that continues line onto the next line: its quote prefix, then
// its list item with the same indentation, the next number or letter, the same spacing, and an
// empty task box if it had one. A line with neither returns undefined.
export function lineLead(line: string): string | undefined {
  const l = lead(line);
  if (l.next) return `${l.quote}${l.indent}${l.next}${l.spaces}${l.box ? "[ ] " : ""}`;
  return l.quote || undefined;
}

// bareLead tells whether line is only a quote prefix or list item, with no text after it.
export const bareLead = (line: string) => {
  const l = lead(line);
  return !!(l.marker || l.quote) && !line.slice(l.end).trim();
};

// itemEnd returns where line's list item prefix ends, or undefined when line is no list item.
export const itemEnd = (line: string) => {
  const l = lead(line);
  return l.marker ? l.end : undefined;
};

// indentLead returns the new prefix of list item lines[i] one level in (dir 1) or out (dir -1).
// In, it nests under the item above, at that item's text column: a bullet keeps its marker, a
// numbered or lettered item becomes a `-` bullet. Out, it joins the list of the nearest shallower
// item above, at its indentation, as that list's next item. It returns undefined for no list
// item, and for out at the top level.
export function indentLead(lines: string[], i: number, dir: 1 | -1): string | undefined {
  const cur = lead(lines[i] ?? "");
  if (!cur.marker) return undefined;
  const prefix = (indent: string, marker: string) => `${cur.quote}${indent}${marker}${cur.spaces}${cur.box}`;
  if (dir > 0) {
    const prev = lead(lines[i - 1] ?? "");
    const col = prev.marker && prev.raw === cur.raw ? prev.indent.length + prev.marker.length + prev.spaces.length : 0;
    return prefix(" ".repeat(Math.max(col, cur.indent.length + 2)), cur.ordered ? "-" : cur.marker);
  }
  if (!cur.indent) return undefined;
  for (let j = i - 1; j >= 0 && lines[j].trim(); j--) {
    const p = lead(lines[j]);
    if (p.marker && p.raw === cur.raw && p.indent.length < cur.indent.length) return prefix(p.indent, p.next as string);
  }
  return prefix(cur.indent.slice(2), cur.marker);
}

// dedent removes the leading whitespace that every non-blank line shares, and blanks
// whitespace-only lines. Single-line text is unchanged: its leading space may be intended.
export function dedent(text: string): string {
  const lines = text.split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)?.[0] ?? "");
  let common = indents[0] ?? "";
  for (const indent of indents) while (!indent.startsWith(common)) common = common.slice(0, -1);
  if (lines.length < 2 || !common) return text;
  return lines.map((l) => (l.trim() ? l.slice(common.length) : "")).join("\n");
}
