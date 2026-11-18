import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, Editor, type EditorTheme, type OverlayHandle, type OverlayOptions, sliceByColumn, type TUI, TuiAltScreen, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { missing, unsupported } from "../compat.ts";
import { editorRange } from "../editor-copy/copy.ts";
import { type Box, editorAt, editorView } from "../editor-copy/index.ts";
import { markerAt, patch } from "../chips/chips.ts";
import { annotationBody } from "./annotate.ts";

const ICON = "\uf075"; // Nerd Font comment glyph: one cell, one UTF-16 unit.
const PLACEHOLDER = "Add an optional comment · shift+enter for a new line";
// The edit box shows at most this many quote rows; a longer quote ends in "> …".
const QUOTE_ROWS = 6;

type Point = { row: number; col: number; scrollView?: unknown };
type Range = { start: Point; end: Point };
type RawMouse = { x: number; y: number; button: number; release: boolean };
// Theme and Keys are the slices of Pi's theme and keybindings the extension uses, with plain string ids.
type Theme = { fg(token: string, s: string): string; bg(token: string, s: string): string };
type Keys = { matches(data: string, id: string): boolean };
// SAFETY: pi-tui keeps these TS-private members as runtime properties; pix-pretty writes pastes too.
type Screen = {
  currentLayout?: { root: Box };
  terminal: { rows: number; columns: number };
  previousScreen: string[];
  selectionPressActive: boolean;
  selectionFocus?: Point;
  getSelectionBounds(): Range | undefined;
  getActiveSelectionText(): string | undefined;
  clearTextSelection(): void;
};
type EditorState = {
  pastes: Map<number, unknown>;
  pasteCounter: number;
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  preferredVisualCol: number | null;
  renderedVisibleLineCount: number;
  theme: EditorTheme;
  autocompleteProvider?: AutocompleteProvider;
};
type ScreenProto = {
  handleSelectionMouseEvent(this: Screen, event: RawMouse): void;
  handleMouseEvent(this: Screen, raw: RawMouse): void;
  applySelection(this: Screen, screen: string[], layout?: unknown): string[];
};

// Note is one annotation: its chip number, the quoted selection, and the comment.
type Note = { n: number; quote: string; comment: string };
// Notes per editor, keyed by chip text: pi-tui renumbers paste ids, the text moves with them.
const notes = new WeakMap<Editor, Map<string, Note>>();

// SAFETY: EditorState names pi-tui runtime fields; see the type.
const internals = (editor: Editor) => editor as unknown as EditorState;

// notesOf returns editor's notes, without notes whose chip left the editor.
function notesOf(editor: Editor): Map<string, Note> {
  const map = notes.get(editor) ?? new Map<string, Note>();
  notes.set(editor, map);
  const live = new Set(internals(editor).pastes.values());
  for (const text of map.keys()) if (!live.has(text)) map.delete(text);
  return map;
}

// AnnotationBox is a comment editor in a rounded frame, below an optional read-only quote.
// Enter submits, shift+enter adds a line, Escape cancels. It completes @paths like the prompt
// editor it annotates, with that editor's theme; slash commands are not offered.
class AnnotationBox {
  private readonly editor: Editor;
  height = 3;

  constructor(
    tui: TUI,
    private readonly theme: Theme,
    private readonly keys: Keys,
    private readonly quote: string,
    comment: string,
    private readonly done: (comment?: string) => void,
    prompt: Editor,
  ) {
    const { theme: editorTheme, autocompleteProvider: p } = internals(prompt);
    this.editor = new Editor(tui, editorTheme);
    // The prompt's provider, with what extensions wrapped into it, minus the slash commands that
    // start a line: Object.create keeps its other methods and fields.
    if (p) {
      const provider: AutocompleteProvider = Object.create(p);
      provider.getSuggestions = (lines, line, col, options) => (/^\/\S*$/.test(lines[line]?.slice(0, col) ?? "") ? Promise.resolve(null) : p.getSuggestions(lines, line, col, options));
      this.editor.setAutocompleteProvider(provider);
    }
    this.editor.setText(comment);
    this.editor.onSubmit = (value) => done(value);
  }

  get focused(): boolean {
    return this.editor.focused;
  }
  set focused(value: boolean) {
    this.editor.focused = value;
  }
  handleInput(data: string): void {
    // An open suggestion list takes Escape first, as in the prompt.
    if (!this.editor.capturesViewportInput && this.keys.matches(data, "tui.select.cancel")) this.done(undefined);
    else this.editor.handleInput(data);
  }
  invalidate(): void {
    this.editor.invalidate();
  }
  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const drawn = this.editor.render(inner);
    const count = internals(this.editor).renderedVisibleLineCount;
    // The editor draws its suggestion list below its bottom border.
    let rows = [...drawn.slice(1, 1 + count), ...drawn.slice(2 + count)];
    // An empty editor draws only the cursor cell; the placeholder follows it.
    if (!this.editor.getText()) rows = [truncateToWidth(`${rows[0]?.trimEnd() ?? ""}${this.theme.fg("dim", PLACEHOLDER)}`, inner, "…")];
    const frame = (s: string) => this.theme.fg("borderAccent", s);
    const rule = "─".repeat(Math.max(0, width - 2));
    if (this.quote) rows = [...this.quoteRows(inner), "", ...rows];
    const body = rows.map((r) => `${frame("│")} ${r}${" ".repeat(Math.max(0, inner - visibleWidth(r)))} ${frame("│")}`);
    this.height = body.length + 2;
    return [frame(`╭${rule}╮`), ...body, frame(`╰${rule}╯`)];
  }
  // quoteRows draws the quote as dim "> " lines wrapped to width.
  private quoteRows(width: number): string[] {
    const rows = wrapTextWithAnsi(annotationBody(this.quote, "").trimEnd(), width);
    const shown = rows.length > QUOTE_ROWS ? [...rows.slice(0, QUOTE_ROWS - 1), "> …"] : rows;
    return shown.map((r) => this.theme.fg("dim", r));
  }
}

// addChip records a note and inserts its marker on a line of its own, with the cursor on the next line.
function addChip(editor: Editor, quote: string, comment: string): void {
  const map = notesOf(editor);
  const body = annotationBody(quote, comment);
  map.set(body, { n: Math.max(0, ...[...map.values()].map((note) => note.n)) + 1, quote, comment });
  const ed = internals(editor);
  const id = ++ed.pasteCounter;
  ed.pastes.set(id, body);
  const { lines, cursorLine, cursorCol } = ed.state;
  const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
  editor.insertTextAtCursor(`${before.trim() ? "\n" : ""}[paste #${id} ${body.length} chars]\n`);
}

// updateChip replaces the comment of the note whose chip text is body.
function updateChip(editor: Editor, body: string, comment: string): void {
  const map = notesOf(editor);
  const note = map.get(body);
  if (!note) return;
  const next = annotationBody(note.quote, comment);
  const { pastes } = internals(editor);
  for (const [id, text] of pastes) if (text === body) pastes.set(id, next);
  map.delete(body);
  map.set(next, { ...note, comment });
}

// Chip is an annotation chip on screen: its prompt, the chip text, and its note.
type Chip = { editor: Editor; box: Box; body: string; note: Note };
// Press is a mouse press on a chip, with the prompt cursor from before the press.
type Press = { chip: Chip; cursor: { line: number; col: number } };

// chipAt returns the annotation chip drawn at raw, if any.
function chipAt(screen: Screen, raw: RawMouse): Chip | undefined {
  const hit = screen.currentLayout && editorAt(screen.currentLayout.root, raw.y);
  const map = hit && notes.get(hit.editor);
  if (!hit || !map?.size) return undefined;
  const view = editorView(screen.previousScreen, hit.box, hit.editor);
  const point = { row: raw.y, col: raw.x };
  const id = markerAt(view.lines.join("\n"), editorRange(view, point, point, visibleWidth)[0]);
  const body = id === undefined ? undefined : internals(hit.editor).pastes.get(id);
  const note = typeof body === "string" ? map.get(body) : undefined;
  return note && typeof body === "string" ? { ...hit, body, note } : undefined;
}

// label names annotation chips for the chips extension.
const label = (editor: Editor, value: unknown) => {
  const n = typeof value === "string" ? notes.get(editor)?.get(value)?.n : undefined;
  return n === undefined ? undefined : `${ICON} annotation ${n}`;
};

// keepCells returns line with columns col..col+width taken from source. Each slice replays its own
// style codes after a reset, so neither side's style leaks into the other.
function keepCells(line: string, source: string, col: number, width: number): string {
  const after = sliceByColumn(line, col + width, Math.max(0, visibleWidth(line) - col - width), true);
  return `${sliceByColumn(line, 0, col, true)}\x1b[0m${sliceByColumn(source, col, width, true)}\x1b[0m${after}`;
}

// annotate adds Codex-style inline annotations in fullscreen mode. A drag selection in the
// transcript still copies, and also opens a focused comment box at the mouse. Enter adds an
// "annotation N" chip on its own prompt line; it sends as the quoted selection plus the comment.
// Clicking a chip reopens it, with its quote shown above the comment. Escape or a click outside
// the box drops the box. The chips extension draws the chip and expands it on a right-click.
export default function annotate(pi: ExtensionAPI): void {
  let restore: (() => void)[] = [];
  let open: { handle?: OverlayHandle; close(): void } | undefined;
  let pressed: Press | undefined;

  // openBox shows a comment box for prompt at place(height) and calls submit with the comment on Enter.
  const openBox = (
    ctx: ExtensionContext,
    prompt: Editor,
    place: (height: number) => OverlayOptions,
    quote: string,
    comment: string,
    submit: (comment: string) => void,
  ) => {
    const box: { handle?: OverlayHandle; close(): void } = { close: () => {} };
    open = box;
    let component: AnnotationBox | undefined;
    let requestRender = () => {};
    void ctx.ui
      .custom<string | undefined>(
        (tui, theme, keys, done) => {
          box.close = () => done(undefined);
          requestRender = () => tui.requestRender();
          // SAFETY: Pi's theme and keybindings accept these ids; Theme and Keys only loosen their types.
          component = new AnnotationBox(tui, theme as unknown as Theme, keys as unknown as Keys, quote, comment, done, prompt);
          return component;
        },
        { overlay: true, overlayOptions: () => place(component?.height ?? 3), onHandle: (handle) => (box.handle = handle) },
      )
      .then((value) => {
        if (open === box) open = undefined;
        if (value === undefined) return;
        submit(value);
        // insertTextAtCursor and registry edits change the editor without a render request.
        requestRender();
      });
  };

  // editChip reopens chip's note above its prompt, with the prompt cursor back at cursor.
  const editChip = (ctx: ExtensionContext, { chip, cursor }: Press) => {
    // The press that clicked the chip moved the cursor onto it.
    const ed = internals(chip.editor);
    ed.state.cursorLine = cursor.line;
    ed.state.cursorCol = cursor.col;
    ed.preferredVisualCol = null;
    const width = Math.min(64, chip.box.rect.width);
    // The box sits just above the prompt's top border (rect.y - lineOffset, as editorView counts).
    const border = chip.box.rect.y - chip.box.lineOffset;
    const place = (height: number) => ({ row: Math.max(0, border - height), col: chip.box.rect.x, width });
    openBox(ctx, chip.editor, place, chip.note.quote, chip.note.comment, (comment) => updateChip(chip.editor, chip.body, comment));
  };

  pi.on("session_start", (_event, ctx) => {
    for (const r of restore) r();
    restore = [];
    if (ctx.mode !== "tui") return;
    const screenMethods = ["handleSelectionMouseEvent", "handleMouseEvent", "applySelection", "getSelectionBounds", "getActiveSelectionText", "clearTextSelection"];
    const editorMethods = ["render", "handleInput", "insertTextAtCursor", "setText", "getText", "getCursor", "setAutocompleteProvider", "layoutText", "getLines"];
    if (unsupported(ctx.ui, "annotate", [...missing(TuiAltScreen?.prototype, screenMethods), ...missing(Editor.prototype, editorMethods)])) return;
    pi.events.emit("chips:label", label);
    // SAFETY: the casts name prototype slots of public pi-tui classes; Screen lists the private fields read.
    const screen = TuiAltScreen.prototype as unknown as ScreenProto;
    restore = [
      patch(screen, "handleSelectionMouseEvent", (original) =>
        function (this: Screen, event: RawMouse) {
          const pressing = this.selectionPressActive;
          original.call(this, event);
          if (!event.release || !pressing || open) return;
          const bounds = this.getSelectionBounds();
          const root = this.currentLayout?.root;
          // A selection inside the prompt is not a quote.
          if (!bounds || !root || (!bounds.start.scrollView && editorAt(root, bounds.start.row))) return;
          const quote = this.getActiveSelectionText();
          const target = editorAt(root)?.editor;
          if (!quote || !target) return;
          const { rows, columns } = this.terminal;
          const width = Math.min(64, Math.max(10, columns - 2));
          const col = Math.max(0, Math.min(event.x - Math.floor(width / 2), columns - width));
          // The selection's screen rows, from the release row: a drag can end above where it began.
          const focus = this.selectionFocus?.row ?? bounds.end.row;
          const top = event.y - (focus - bounds.start.row);
          const bottom = event.y + (bounds.end.row - focus);
          // Below the selection when the box fits, else above it, else under the mouse.
          const place = (height: number) => {
            if (bottom + 1 + height <= rows) return { row: bottom + 1, col, width };
            if (top - height >= 0) return { row: top - height, col, width };
            return { row: Math.min(event.y + 1, Math.max(0, rows - height)), col, width };
          };
          openBox(ctx, target, place, "", "", (comment) => addChip(target, quote, comment));
        },
      ),
      patch(screen, "handleMouseEvent", (original) =>
        function (this: Screen, raw: RawMouse) {
          const b = open?.handle?.getBounds();
          const press = !raw.release && (raw.button & 32) === 0;
          const inside = b && raw.y >= b.row && raw.y < b.row + b.height && raw.x >= b.col && raw.x < b.col + b.width;
          if (open && press && !inside) open.close();
          if (press) {
            const chip = inside ? undefined : chipAt(this, raw);
            pressed = chip && { chip, cursor: chip.editor.getCursor() };
          }
          const down = raw.release ? pressed : undefined;
          if (raw.release) pressed = undefined;
          // A press and a release on one chip is a click, even when the mouse moves between them.
          const click = down && !open && chipAt(this, raw)?.body === down.chip.body ? down : undefined;
          // The click's selection is a jitter, not a copy: drop it before pi-tui copies it on release.
          if (click) this.clearTextSelection();
          original.call(this, raw);
          if (click) editChip(ctx, click);
        },
      ),
      // pi-tui highlights the selection after it draws overlays. Draw the box's cells back over it.
      patch(screen, "applySelection", (original) =>
        function (this: Screen, lines: string[], layout?: unknown) {
          const out = original.call(this, lines, layout);
          const b = open?.handle?.getBounds();
          if (!b || out === lines) return out;
          return out.map((line, row) => (row < b.row || row >= b.row + b.height ? line : keepCells(line, lines[row] ?? "", b.col, b.width)));
        },
      ),
    ];
  });
  pi.on("session_shutdown", () => {
    open?.close();
    for (const r of restore) r();
    restore = [];
  });
}
