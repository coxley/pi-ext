import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import { missing, unsupported } from "../compat.ts";
import { paint, rowStarts, styleLines } from "./md.ts";

// SAFETY: pi-tui keeps these TS-private members as runtime properties; pix-pretty reads them too.
type Internals = {
  layoutText(width: number): { text: string }[];
  getLines(): string[];
  lastWidth: number;
  paddingX: number;
  scrollOffset: number;
  renderedVisibleLineCount: number;
};

// md-prompt styles markdown in every Pi prompt editor as you type: headings, quotes,
// list markers, code spans and fences, bold, italic, strikethrough and links.
// The hook sits on pi-tui's Editor.prototype.render, like expand-paste's handleInput hook.
export default function mdPrompt(pi: ExtensionAPI): void {
  let restore: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    restore?.();
    restore = undefined;
    if (ctx.mode !== "tui") return;
    if (unsupported(ctx.ui, "md-prompt", missing(Editor.prototype, ["render", "layoutText", "getLines"]))) return;
    // SAFETY: render is a public method; Internals names the private fields the patch reads.
    const proto = Editor.prototype as unknown as { render(this: Internals, width: number): string[] };
    const original = proto.render;
    let active = true;
    const patched = function (this: Internals, width: number): string[] {
      const out = original.call(this, width);
      if (!active) return out;
      const lines = this.getLines();
      const styles = styleLines(lines);
      const starts = rowStarts(this.layoutText(this.lastWidth), lines);
      const pad = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
      // Content rows sit between the top border (out[0]) and the bottom border.
      for (let i = 0; i < this.renderedVisibleLineCount; i++) {
        const row = starts[this.scrollOffset + i];
        if (row && row.start >= 0) out[1 + i] = paint(out[1 + i], pad, styles[row.line].slice(row.start));
      }
      return out;
    };
    proto.render = patched;
    // A later patch by another extension stays in place; this one then passes through.
    restore = () => {
      active = false;
      if (proto.render === patched) proto.render = original;
    };
  });
  pi.on("session_shutdown", () => {
    restore?.();
    restore = undefined;
  });
}
