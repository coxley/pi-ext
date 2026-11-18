// Pure helpers for prompt chips. index.ts wires them into pi-tui.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { MARKER, pasteText } from "../editor-copy/copy.ts";

// Nerd Font glyphs from the BMP: one cell and one UTF-16 unit each, so a label pads by length.
// file and dir match pix-pretty's icons.ts.
export const ICON = { url: "\uf0c1", image: "\uf03e", file: "\uf15b", dir: "\ue5ff", text: "\uf0ea", prompt: "\uf0d0", skill: "\uf0ad" };

// Value is a paste registry entry: pi-tui stores text; chips adds image and path kinds, and
// pix-pretty (when installed) adds skill and prompt kinds.
export type Value =
  | string
  | { kind: "image" | "path"; path: string }
  | { kind: "skill"; ref: string }
  | { kind: "prompt"; name: string; body: string };

// Image file extensions (as pix-pretty's): such a file gets its image chip.
const IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i;

export const isUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\/\S+$/.test(v) && URL.canParse(v);

// chipLabel is the text a chip shows for value.
export function chipLabel(value: Value): string {
  if (isUrl(value)) return `${ICON.url} ${new URL(value).hostname}`;
  if (typeof value === "string") {
    const n = value.length < 1000 ? `${value.length}` : `${Number((value.length / 1000).toFixed(1))}k`;
    return `${ICON.text} text ${n} chars`;
  }
  switch (value.kind) {
    case "image":
      return `${ICON.image} image`;
    case "path":
      return value.path.endsWith("/") ? `${ICON.dir} ${basename(value.path)}/` : `${ICON.file} ${basename(value.path)}`;
    case "skill":
      return `${ICON.skill} $${value.ref.slice(value.ref.lastIndexOf("@") + 1)}`;
    case "prompt":
      return `${ICON.prompt} ${value.name.split("-").slice(1).join("-") || "prompt"}`;
  }
  // A kind from a newer pix-pretty still draws as a chip.
  return `${ICON.text} paste`;
}

// chipText is the plain text a chip expands to in the prompt.
export const chipText: (v: Value) => string = pasteText;

// sendText is what the model receives for a tagged value, in pix-pretty's tag format: a file as
// <path>…</path>, an image as its bare path (as Pi sends a pasted image), and pix-pretty's skill
// and prompt kinds as their tags. Plain text pastes belong to pi-tui and are not tagged.
export function sendText(v: Exclude<Value, string>): string {
  switch (v.kind) {
    case "path":
      return `<path>${v.path}</path>`;
    case "image":
      return v.path;
    case "skill":
      return `<skill>${v.ref}</skill>`;
    case "prompt":
      return `<prompt name="${v.name}">${v.body}</prompt>`;
  }
  // A kind from a newer pix-pretty sends its plain text.
  return pasteText(v);
}

// expandTagged replaces the marker of each tagged value in text with its sendText. Text markers
// stay, for pi-tui's own expansion.
export function expandTagged(text: string, pastes: Map<number, unknown>): string {
  return text.replace(MARKER, (marker, id: string) => {
    const v = pastes.get(Number(id));
    // SAFETY: chips and pix-pretty store only Value kinds in the registry.
    return v === undefined || typeof v === "string" ? marker : sendText(v as Exclude<Value, string>);
  });
}

// pastedChip returns the chip value for a paste that is one URL, or one path to an existing file
// (as Pi's own check: it starts with /, ~ or .). Other pastes return undefined.
export function pastedChip(text: string, cwd: string): Value | undefined {
  const t = text.trim();
  if (isUrl(t)) return t;
  // Terminals drop a file quoted or with backslash escapes.
  const path = /^'(.*)'$/.exec(t)?.[1] ?? /^"(.*)"$/.exec(t)?.[1] ?? t.replace(/\\(.)/g, "$1");
  if (!/^[/~.]/.test(path) || path.includes("\n")) return undefined;
  const abs = resolve(cwd, path.replace(/^~(?=\/)/, homedir()));
  if (!statSync(abs, { throwIfNoEntry: false })?.isFile()) return undefined;
  return { kind: IMAGE.test(abs) ? "image" : "path", path: abs };
}

// Zero-width codes the editor or a styling pass may put inside a marker.
const CODE = /\x1b\[[0-9;]*m|\x1b_pi:(?:c|\/?fc)\x07/g;
const SGR = /\x1b\[[0-9;]*m/g;
// A marker as drawn: pi-tui puts the cursor marker and the fake-cursor wrapper around an atomic
// marker when the cursor sits on it.
const SPAN = new RegExp(String.raw`(\x1b_pi:c\x07)?(\x1b_pi:fc\x07)?\[((?:${CODE.source})*paste #(?:${CODE.source}|[^\]\x1b])*)\](?:\x1b_pi:\/fc\x07)?`, "g");

// labelChips draws each marker that label names as a styled pill, padded or cut to the marker's
// length. Same length keeps cursor columns and later column-based styling aligned. A marker under
// the cursor draws inverse. Style codes inside the marker are kept after the pill.
// ponytail: pads by UTF-16 length; a wide character in a label (CJK file name) shifts the row one
// cell. Pass a width function from pi-tui if that shows up.
export function labelChips(row: string, label: (id: number) => string | undefined, style: (s: string) => string): string {
  return row.replace(SPAN, (span, cursor: string | undefined, fake: string | undefined, inner: string) => {
    const plain = inner.replace(CODE, "");
    const m = /^paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?$/.exec(plain);
    const text = m ? label(Number(m[1])) : undefined;
    if (text === undefined) return span;
    const length = plain.length + 2;
    const fit = text.length + 2 > length ? `${text.slice(0, length - 3)}…` : text;
    const pill = style(` ${fit} `.padEnd(length));
    return (cursor ?? "") + (fake ? `\x1b[7m${pill}\x1b[27m` : pill) + (inner.match(SGR)?.join("") ?? "");
  });
}

// markerAt returns the id of the paste marker in text that covers offset at.
export function markerAt(text: string, at: number): number | undefined {
  for (const m of text.matchAll(/\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g)) {
    if (at >= m.index && at < m.index + m[0].length) return Number(m[1]);
  }
  return undefined;
}

// AT_PATH is the SGR style of an @path that names a file: underlined magenta.
export const AT_PATH = "4;35";

// atPathStyles returns one SGR parameter string per UTF-16 unit of each line (md-prompt's paint
// format): AT_PATH on each "@path" whose path isFile accepts. Trailing punctuation is not path.
export function atPathStyles(lines: string[], isFile: (path: string) => boolean): string[][] {
  return lines.map((line) => {
    const s = Array<string>(line.length).fill("");
    for (const m of line.matchAll(/(?<!\S)@([^\s@]+?)[,.;:!?)]*(?=\s|$)/g)) if (isFile(m[1])) s.fill(AT_PATH, m.index, m.index + 1 + m[1].length);
    return s;
  });
}

// patch replaces obj[name] with make(original) and returns a restore. A restore under a later
// patch cannot unwire, so it turns the wrapper into a pass-through instead: after a reload, a
// buried wrapper must not touch its stale ctx.
export function patch<T, K extends keyof T>(obj: T, name: K, make: (original: T[K]) => T[K]): () => void {
  type Fn = (this: unknown, ...args: unknown[]) => unknown;
  const original = obj[name];
  const wrapped = make(original);
  let active = true;
  // SAFETY: every patched slot is a method, so original and wrapped are callable.
  const call = (fn: T[K], self: unknown, args: unknown[]) => (fn as unknown as Fn).apply(self, args);
  // SAFETY: patched has the slot's call signature; it forwards this and every argument.
  const patched = function (this: unknown, ...args: unknown[]) {
    return call(active ? wrapped : original, this, args);
  } as unknown as T[K];
  obj[name] = patched;
  return () => {
    active = false;
    if (obj[name] === patched) obj[name] = original;
  };
}
