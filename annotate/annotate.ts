// Pure helpers for annotation chips. index.ts wires them into pi-tui.

// annotationBody quotes every line of quote, then adds comment as its own paragraph. The body ends
// in a newline, so the line after its chip expands as a new paragraph, not a continuation.
export function annotationBody(quote: string, comment: string): string {
  const quoted = quote
    .split("\n")
    .map((l) => (l.trim() ? `> ${l}` : ">"))
    .join("\n");
  return `${comment.trim() ? `${quoted}\n\n${comment.trim()}` : quoted}\n`;
}
