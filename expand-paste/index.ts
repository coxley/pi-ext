import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, matchesKey } from "@earendil-works/pi-tui";
import { missing, unsupported } from "../compat.ts";
import { bareLead, dedent, expandPair, indentLead, itemEnd, lineLead, quoteOnly, samePaste } from "./expand.ts";

const PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

// SAFETY: pi-tui keeps these TS-private members as runtime properties; pix-pretty mutates them too.
type Internals = {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  pasteCounter: number;
  setCursorCol(col: number): void;
  insertTextAtCursorInternal(text: string): void;
  pushUndoSnapshot(): void;
  isShowingAutocomplete(): boolean;
  onChange?: (text: string) => void;
};

// quoteRows prefixes rows from..cursor with quote, keeping the cursor on the same text.
function quoteRows(ed: Internals & Pick<Editor, "getText">, from: number, quote: string): void {
  const { state } = ed;
  let added = 0;
  for (let i = from; i <= state.cursorLine; i++) {
    const prefix = state.lines[i] ? quote : quote.trimEnd();
    state.lines[i] = prefix + state.lines[i];
    added = prefix.length;
  }
  ed.setCursorCol(state.cursorCol + added);
  ed.onChange?.(ed.getText());
}

// nest handles tab and shift+tab anywhere on a list item: tab nests it, shift+tab un-nests it,
// and the cursor stays on its text. It returns false, changing nothing, for other keys, off a
// list item, for tab after an @path (completion), and while a suggestion list is open.
function nest(editor: Editor, data: string): boolean {
  const dir = matchesKey(data, "tab") ? 1 : matchesKey(data, "shift+tab") ? -1 : 0;
  // SAFETY: Internals names pi-tui runtime fields; see the type.
  const ed = editor as unknown as Internals & Pick<Editor, "getText">;
  const { lines, cursorLine: i, cursorCol: col } = ed.state;
  const end = itemEnd(lines[i] ?? "");
  const atPath = dir > 0 && /(?:^|\s)@\S*$/.test(lines[i]?.slice(0, col) ?? "");
  const prefix = dir && end !== undefined && !atPath && !ed.isShowingAutocomplete() ? indentLead(lines, i, dir) : undefined;
  if (prefix === undefined || end === undefined) return false;
  ed.pushUndoSnapshot();
  lines[i] = prefix + lines[i].slice(end);
  // Inside the old prefix, the cursor moves to the new one's end.
  ed.setCursorCol(Math.max(prefix.length, col + prefix.length - end));
  ed.onChange?.(ed.getText());
  return true;
}

// Pasting the same text twice in a row into an editor expands that pill pair to
// one literal copy instead of a second [paste #N] marker. Other pills stay. Any
// other input to the editor between the two pastes breaks the pair.
//
// Pastes also lose the leading whitespace all their lines share. After a bare
// quote prefix (`> `), every line of an inline paste joins the quote. A newline after a
// quoted line or a list item (`- `, `1. `, `a. `, `- [ ] `) carries the prefix down. Anywhere on
// a list item, tab nests the item and shift+tab un-nests it; tab after an @path still completes.
//
// The hook sits on pi-tui's Editor.prototype.handleInput: every Pi editor
// (CustomEditor, pix-pretty chips, pi-open-tui) reaches it through super, and
// some extensions replace the editor factory without chaining it.
export default function expandPaste(pi: ExtensionAPI): void {
  let restore: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    restore?.();
    restore = undefined;
    if (ctx.mode !== "tui") return;
    const methods = ["handleInput", "insertTextAtCursor", "insertTextAtCursorInternal", "setCursorCol", "pushUndoSnapshot", "isShowingAutocomplete", "getCursor", "getLines"];
    if (unsupported(ctx.ui, "expand-paste", [...missing(Editor.prototype, methods), ...missing(CustomEditor?.prototype, ["handleInput"])])) return;
    // SAFETY: handleInput is a public method; the cast only names the prototype slot.
    const proto = Editor.prototype as unknown as { handleInput(this: Editor, data: string): void };
    const original = proto.handleInput;
    const last = new WeakMap<Editor, string>();
    let active = true;
    const patched = function (this: Editor, data: string): void {
      if (!active) return original.call(this, data);
      if (nest(this, data)) return;
      // SAFETY: Internals names pi-tui runtime fields; see the type.
      const ed = this as unknown as Internals & Pick<Editor, "getText">;
      const { cursorLine: line, cursorCol: col, lines } = ed.state;
      const [lineCount, counter] = [lines.length, ed.pasteCounter];
      const quote = quoteOnly(lines[line]?.slice(0, col) ?? "");
      const raw = PASTE.exec(data)?.[1];
      let paste = raw === undefined ? undefined : dedent(raw);
      // A trailing newline would leave an empty quote line under the paste.
      if (quote) paste = paste?.replace(/\n+$/, "");
      const previous = last.get(this);
      original.call(this, paste === undefined ? data : `\x1b[200~${paste}\x1b[201~`);
      // An expansion consumes the pair, so the next identical paste starts fresh.
      if (paste !== undefined && previous !== undefined && samePaste(paste, previous) && expandPair(this)) {
        last.delete(this);
        ctx.ui.notify("Paste expanded - edit it before sending", "info");
      } else if (paste !== undefined) {
        last.set(this, paste);
        // A chip quotes only when it expands (expandPair).
        if (quote && ed.pasteCounter === counter && ed.state.cursorLine > line) quoteRows(ed, line + 1, quote);
      } else {
        last.delete(this);
        const { lines: now } = ed.state;
        const lead = lineLead(now[line] ?? "");
        const newline = now.length === lineCount + 1 && ed.state.cursorLine === line + 1 && ed.state.cursorCol === 0;
        if (!lead || !newline) return;
        // A second empty quote line or list item in a row ends it: both become one blank line.
        if (bareLead(now[line - 1] ?? "") && bareLead(now[line]) && !now[line + 1]) {
          now.splice(line - 1, 2, "");
          ed.state.cursorLine = line;
          ed.onChange?.(ed.getText());
        } else ed.insertTextAtCursorInternal(lead);
      }
    };
    proto.handleInput = patched;
    // Pi's CustomEditor runs app keys (shift+tab cycles the thinking level) before pi-tui's
    // Editor, so nest also runs on it, first. Off a list item, the keys keep their meaning.
    // SAFETY: handleInput is a public method; the cast only names the prototype slot.
    const custom = CustomEditor.prototype as unknown as { handleInput(this: Editor, data: string): void };
    const customOriginal = custom.handleInput;
    const nested = function (this: Editor, data: string): void {
      if (!active || !nest(this, data)) customOriginal.call(this, data);
    };
    custom.handleInput = nested;
    // A later patch by another extension stays in place; this one then passes through.
    restore = () => {
      active = false;
      if (proto.handleInput === patched) proto.handleInput = original;
      if (custom.handleInput === nested) custom.handleInput = customOriginal;
    };
  });
  pi.on("session_shutdown", () => {
    restore?.();
    restore = undefined;
  });
}
