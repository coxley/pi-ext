import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Editor, sliceByColumn, stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { missing, unsupported } from "../compat.ts";
import { editorRange, expandMarkers, type Point, type View, unwrapRows } from "./copy.ts";

type Rect = { x: number; y: number; width: number; height: number };
export type Box = { component: unknown; rect: Rect; lineOffset: number; children: Box[] };
// SAFETY: pi-tui keeps these TS-private members as runtime properties.
type Screen = {
  currentLayout?: { root: Box };
  previousScreen: string[];
  getSelectionBounds(): { start: Point & { scrollView?: unknown }; end: Point & { scrollView?: unknown } } | undefined;
  copyTextToClipboard(text: string): Promise<boolean>;
};
type EditorInternals = {
  layoutText(width: number): { text: string }[];
  pastes: Map<number, unknown>;
  getLines(): string[];
  lastWidth: number;
  paddingX: number;
  scrollOffset: number;
  renderedVisibleLineCount: number;
};

// editorAt finds the layout box that draws an Editor, alone or as a Container's first child.
// With row, the box must cover that screen row.
export function editorAt(box: Box, row?: number): { box: Box; editor: Editor } | undefined {
  const c = box.component;
  const editor = c instanceof Container && c.children[0] instanceof Editor ? c.children[0] : c;
  const covers = row === undefined || (row >= box.rect.y && row < box.rect.y + box.rect.height);
  if (editor instanceof Editor && covers) return { box, editor };
  for (const child of box.children) {
    const hit = editorAt(child, row);
    if (hit) return hit;
  }
  return undefined;
}

// editorView describes editor as drawn in its layout box on screen, for editorRange.
export function editorView(previousScreen: string[], box: Box, editor: Editor): View {
  // SAFETY: EditorInternals names pi-tui runtime fields; see the type.
  const ed = editor as unknown as EditorInternals;
  const { rect, lineOffset } = box;
  // pi-tui wraps at lastWidth and reserves one cursor cell without padding. The frame
  // (pi-open-tui rails, or pi-tui padding) splits the rest evenly on both sides.
  const content = ed.lastWidth + (ed.paddingX ? 0 : 1);
  const left = rect.x + Math.floor((rect.width - content) / 2);
  const top = rect.y - lineOffset + 1;
  const shown = Array.from({ length: ed.renderedVisibleLineCount }, (_, i) =>
    visibleWidth(stripTerminalSequences(sliceByColumn(previousScreen[top + i] ?? "", left, content)).trimEnd()),
  );
  return { lines: ed.getLines(), rows: ed.layoutText(ed.lastWidth), scrollOffset: ed.scrollOffset, shown, top, left };
}

// editorSelectionText returns the editor text under a selection that starts and ends inside
// the editor's box, with paste markers expanded. Returns undefined for any other selection.
function editorSelectionText(screen: Screen): string | undefined {
  const sel = screen.getSelectionBounds();
  if (!sel || sel.start.scrollView || sel.end.scrollView || !screen.currentLayout) return undefined;
  const hit = editorAt(screen.currentLayout.root, sel.start.row);
  if (!hit || sel.end.row >= hit.box.rect.y + hit.box.rect.height) return undefined;
  const view = editorView(screen.previousScreen, hit.box, hit.editor);
  const [from, to] = editorRange(view, sel.start, sel.end, visibleWidth);
  // The raw paste text, not the tags the model gets (chips' <path>, pix-pretty's <paste>).
  // SAFETY: EditorInternals names pi-tui runtime fields; see the type.
  const { pastes } = hit.editor as unknown as EditorInternals;
  return expandMarkers(view.lines.join("\n").slice(from, to), pastes) || undefined;
}

// editor-copy makes a fullscreen selection inside the prompt editor copy the editor's text:
// no frame characters, no wrap newlines, and paste pills as their content. Other selections
// read through getActiveSelectionText, which it patches to join soft-wrapped rows (unwrapRows),
// so copies and annotate quotes keep one line per paragraph or list item.
export default function editorCopy(pi: ExtensionAPI): void {
  let restore: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    restore?.();
    restore = undefined;
    if (ctx.mode !== "tui") return;
    const screenMethods = ["copySelectionToClipboard", "copyActiveSelectionToClipboard", "getActiveSelectionText", "getSelectionBounds", "copyTextToClipboard"];
    if (unsupported(ctx.ui, "editor-copy", [...missing(TuiAltScreen?.prototype, screenMethods), ...missing(Editor.prototype, ["layoutText", "getLines"])])) return;
    // SAFETY: these methods are public; the cast only names the prototype slots.
    const proto = TuiAltScreen.prototype as unknown as Record<string, (this: Screen) => unknown>;
    let active = true;
    const wrap = (name: string, patched: (this: Screen, original: (this: Screen) => unknown) => unknown) => {
      const original = proto[name];
      const fn = function (this: Screen) {
        return active ? patched.call(this, original) : original.call(this);
      };
      proto[name] = fn;
      return { name, original, patched: fn };
    };
    const copy = function (this: Screen, original: (this: Screen) => unknown) {
      const text = editorSelectionText(this);
      return text === undefined ? original.call(this) : this.copyTextToClipboard(text);
    };
    const patches = [
      wrap("copySelectionToClipboard", copy),
      wrap("copyActiveSelectionToClipboard", copy),
      wrap("getActiveSelectionText", function (original) {
        const text = original.call(this) as string | undefined;
        return text === undefined ? undefined : unwrapRows(text, this.getSelectionBounds()?.start.col);
      }),
    ];
    // A later patch by another extension stays in place; this one then passes through.
    restore = () => {
      active = false;
      for (const { name, original, patched } of patches) if (proto[name] === patched) proto[name] = original;
    };
  });
  pi.on("session_shutdown", () => {
    restore?.();
    restore = undefined;
  });
}
