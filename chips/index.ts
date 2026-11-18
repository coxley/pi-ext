import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { missing, unsupported } from "../compat.ts";
import { editorRange } from "../editor-copy/copy.ts";
import { type Box, editorAt, editorView } from "../editor-copy/index.ts";
import { paint, rowStarts } from "../md-prompt/md.ts";
import { atPathStyles, chipLabel, chipText, expandTagged, labelChips, markerAt, pastedChip, patch, type Value } from "./chips.ts";

const PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

// Label names a chip for another extension (annotate), or returns undefined to pass.
type Label = (editor: Editor, value: unknown) => string | undefined;
type RawMouse = { x: number; y: number; button: number; release: boolean };
type Theme = { fg(token: string, s: string): string; bg(token: string, s: string): string };
// SAFETY: pi-tui keeps these TS-private members as runtime properties; pix-pretty, when installed,
// writes pastes too.
type Screen = { currentLayout?: { root: Box }; previousScreen: string[]; requestRender(): void };
type EditorState = {
  pastes: Map<number, Value>;
  pasteCounter: number;
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  preferredVisualCol: number | null;
  pushUndoSnapshot(): void;
  insertTextAtCursorInternal(text: string): void;
  layoutText(width: number): { text: string }[];
  getLines(): string[];
  lastWidth: number;
  paddingX: number;
  scrollOffset: number;
  renderedVisibleLineCount: number;
};
type ScreenProto = { handleMouseEvent(this: Screen, raw: RawMouse): void };
type EditorProto = {
  render(this: Editor, width: number): string[];
  handleInput(this: Editor, data: string): void;
  insertTextAtCursor(this: Editor, text: string): void;
  expandPasteMarkers(this: Editor, text: string): string;
};
// The pi-tui methods chips patches or calls; see compat.ts.
const EDITOR_METHODS = ["render", "handleInput", "insertTextAtCursor", "expandPasteMarkers", "insertTextAtCursorInternal", "pushUndoSnapshot", "layoutText", "getLines"];

// SAFETY: EditorState names pi-tui runtime fields; see the type.
const internals = (editor: Editor) => editor as unknown as EditorState;

// chipAt returns the editor and paste id of the chip drawn at raw, if any.
function chipAt(screen: Screen, raw: RawMouse): { editor: Editor; id: number; value: Value } | undefined {
  const hit = screen.currentLayout && editorAt(screen.currentLayout.root, raw.y);
  if (!hit) return undefined;
  const view = editorView(screen.previousScreen, hit.box, hit.editor);
  const point = { row: raw.y, col: raw.x };
  const id = markerAt(view.lines.join("\n"), editorRange(view, point, point, visibleWidth)[0]);
  const value = id === undefined ? undefined : internals(hit.editor).pastes.get(id);
  return id === undefined || value === undefined ? undefined : { editor: hit.editor, id, value };
}

// expandChip replaces the marker of paste id with its text, as plain prompt text.
function expandChip(editor: Editor, id: number, value: Value): void {
  const ed = internals(editor);
  const marker = new RegExp(String.raw`\[paste #${id}(?: [^\]]*)?\]`);
  const line = ed.state.lines.findIndex((l) => marker.test(l));
  const m = marker.exec(ed.state.lines[line] ?? "");
  if (!m) return;
  // A marker deletes as one unit from its end.
  ed.state.cursorLine = line;
  ed.state.cursorCol = m.index + m[0].length;
  ed.preferredVisualCol = null;
  editor.handleInput("\x7f");
  // Below every insertTextAtCursor patch: chips' own (and pix-pretty's) would chip an image path again.
  ed.pushUndoSnapshot();
  ed.insertTextAtCursorInternal(chipText(value));
}

// dropChipBefore deletes the chip (and the space after it) that ends at the cursor when it holds
// the same text as value. Returns false and changes nothing otherwise.
function dropChipBefore(editor: Editor, value: Value): boolean {
  const { state, pastes } = internals(editor);
  const m = /\[paste #(\d+)[^\]]*\]( ?)$/.exec(state.lines[state.cursorLine]?.slice(0, state.cursorCol) ?? "");
  const prev = m && pastes.get(Number(m[1]));
  if (!m || prev === undefined || chipText(prev) !== chipText(value)) return false;
  for (let i = m[2] ? 2 : 1; i > 0; i--) editor.handleInput("\x7f");
  return true;
}

// chips draws every paste marker in a Pi prompt as a labeled chip, inside the marker's width:
// URL, image, file, text, and pix-pretty's prompt and skill kinds; other extensions name their
// own chips (annotate) through the "chips:label" event. A right-click on a chip expands it in
// place. A paste of one URL or one existing file path becomes a chip, and so does an image path
// that Pi inserts (Ctrl+V of an image); the same paste twice in a row is one literal copy, like
// expand-paste. Typed @paths that name a file are highlighted. On submit, a file chip sends
// <path>abs</path> and an image chip its path (expandTagged).
//
// chips works alone. With pix-pretty installed, the hooks sit on pi-tui's Editor.prototype, below
// pix-pretty's per-instance chip pass and pi-open-tui's frame. Every marker is drawn here, so
// pix-pretty's pass finds none to shrink and the frame's right rail stays aligned; pix-pretty's
// own expansion and insert run first, and chips' then pass through.
export default function chips(pi: ExtensionAPI): void {
  let restore: (() => void)[] = [];
  const labels = new Set<Label>();
  pi.events.on("chips:label", (label) => labels.add(label as Label));
  // With pix-pretty, text chips send as <paste>…</paste>; a URL chip sends the bare URL.
  pi.on("input", (event) => {
    const text = event.text.replace(/<paste>(https?:\/\/\S+?)<\/paste>/g, "$1");
    return text === event.text ? undefined : { action: "transform" as const, text };
  });

  pi.on("session_start", (_event, ctx) => {
    for (const r of restore) r();
    restore = [];
    if (ctx.mode !== "tui") return;
    if (unsupported(ctx.ui, "chips", [...missing(Editor.prototype, EDITOR_METHODS), ...missing(TuiAltScreen?.prototype, ["handleMouseEvent"])])) return;
    const { cwd } = ctx;
    const isFile = (path: string) => statSync(resolve(cwd, path), { throwIfNoEntry: false })?.isFile() ?? false;
    // The raw text of each editor's last input when it was a paste.
    const last = new WeakMap<Editor, string>();
    // SAFETY: the casts name prototype slots of public pi-tui classes; Screen lists the private fields read.
    const screen = TuiAltScreen.prototype as unknown as ScreenProto;
    // SAFETY: the cast only names prototype slots; expandPasteMarkers is TS-private but a runtime method.
    const editor = Editor.prototype as unknown as EditorProto;
    restore = [
      patch(screen, "handleMouseEvent", (original) =>
        function (this: Screen, raw: RawMouse) {
          const chip = !raw.release && raw.button === 2 ? chipAt(this, raw) : undefined;
          if (!chip) return original.call(this, raw);
          expandChip(chip.editor, chip.id, chip.value);
          this.requestRender();
        },
      ),
      patch(editor, "handleInput", (original) =>
        function (this: Editor, data: string) {
          const raw = PASTE.exec(data)?.[1];
          const value = raw === undefined ? undefined : pastedChip(raw, cwd);
          const previous = last.get(this);
          last.delete(this);
          if (value === undefined) return original.call(this, data);
          const ed = internals(this);
          if (previous === raw && dropChipBefore(this, value)) {
            ed.pushUndoSnapshot();
            ed.insertTextAtCursorInternal(chipText(value));
            return;
          }
          ed.pushUndoSnapshot();
          const id = ++ed.pasteCounter;
          ed.pastes.set(id, value);
          ed.insertTextAtCursorInternal(`[paste #${id} ${chipText(value).length} chars] `);
          last.set(this, raw);
        },
      ),
      // A tagged chip sends its tag; text markers stay for pi-tui (or pix-pretty, whose own
      // per-editor expansion then runs instead of this one).
      patch(editor, "expandPasteMarkers", (original) =>
        function (this: Editor, text: string) {
          return original.call(this, expandTagged(text, internals(this).pastes));
        },
      ),
      // Pi inserts a Ctrl+V image as its temp file path: make it an image chip.
      patch(editor, "insertTextAtCursor", (original) =>
        function (this: Editor, text: string) {
          const value = text ? pastedChip(text, cwd) : undefined;
          if (typeof value !== "object" || value.kind !== "image") return original.call(this, text);
          const ed = internals(this);
          ed.pushUndoSnapshot();
          const id = ++ed.pasteCounter;
          ed.pastes.set(id, value);
          ed.insertTextAtCursorInternal(`[paste #${id} ${value.path.length} chars] `);
        },
      ),
      patch(editor, "render", (original) =>
        function (this: Editor, width: number) {
          const out = original.call(this, width);
          const ed = internals(this);
          const lines = ed.getLines();
          if (lines.some((l) => l.includes("@"))) {
            // As md-prompt: content rows sit between the top border (out[0]) and the bottom border.
            const styles = atPathStyles(lines, isFile);
            const starts = rowStarts(ed.layoutText(ed.lastWidth), lines);
            const pad = Math.min(ed.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
            for (let i = 0; i < ed.renderedVisibleLineCount; i++) {
              const row = starts[ed.scrollOffset + i];
              if (row && row.start >= 0) out[1 + i] = paint(out[1 + i], pad, styles[row.line].slice(row.start));
            }
          }
          if (!out.some((row) => row.includes("paste #"))) return out;
          const label = (id: number) => {
            const value = ed.pastes.get(id);
            if (value === undefined) return undefined;
            for (const named of labels) {
              const text = named(this, value);
              if (text !== undefined) return text;
            }
            return chipLabel(value);
          };
          // SAFETY: Pi's theme accepts these token names; Theme only loosens their type.
          const theme = ctx.ui.theme as unknown as Theme;
          const pill = (s: string) => theme.bg("selectedBg", theme.fg("accent", s));
          return out.map((row) => labelChips(row, label, pill));
        },
      ),
    ];
  });
  pi.on("session_shutdown", () => {
    for (const r of restore) r();
    restore = [];
  });
}
