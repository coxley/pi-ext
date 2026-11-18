// These extensions patch and call pi-tui methods, some of them TS-private. A Pi update can rename
// one; then the extension stays off and warns instead of breaking the prompt editor.

type Notify = { notify(message: string, type?: "info" | "warning" | "error"): void };

// missing returns the names in methods that are not functions on proto. An absent proto (a class
// this Pi does not export) lacks them all.
export function missing(proto: object | undefined, methods: string[]): string[] {
  // SAFETY: only reads the named slots to test their type.
  const slots = (proto ?? {}) as Record<string, unknown>;
  return methods.filter((m) => typeof slots[m] !== "function");
}

// unsupported warns through ui and returns true when gone lists any method; the caller then skips
// its patches for this session.
export function unsupported(ui: Notify, extension: string, gone: string[]): boolean {
  if (!gone.length) return false;
  ui.notify(`${extension}: this Pi version lacks ${gone.join(", ")}; ${extension} is off`, "warning");
  return true;
}
