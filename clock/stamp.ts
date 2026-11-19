export type Layout = {
  visibleWidth(text: string): number;
  sliceByColumn(line: string, start: number, length: number): string;
  stripTerminalSequences(text: string): string;
};

// stamp puts label at the right edge of the first non-blank line, margin columns from the end. It
// replaces only blank columns, so the line keeps its background; a line without a blank column
// between its text and label stays as it is. style must keep label's width: it only colors it.
export function stamp(lines: string[], width: number, label: string, style: (text: string) => string, ui: Layout, margin = 1): string[] {
  const i = lines.findIndex((line) => ui.stripTerminalSequences(line).trim() !== "");
  if (i < 0) return lines;
  const line = lines[i];
  const cut = width - margin - label.length;
  if (ui.visibleWidth(ui.stripTerminalSequences(line).trimEnd()) >= cut) return lines;
  const left = ui.sliceByColumn(line, 0, cut);
  const out = lines.slice();
  const right = ui.sliceByColumn(line, cut + label.length, margin);
  out[i] = left + " ".repeat(cut - ui.visibleWidth(left)) + style(label) + right + " ".repeat(margin - ui.visibleWidth(right));
  return out;
}

const formats = new Map<string, Intl.DateTimeFormat>();

// clockTime formats ms since the epoch as 24-hour hh:mm:ss in timeZone.
export function clockTime(ms: number, timeZone: string): string {
  let format = formats.get(timeZone);
  if (!format) formats.set(timeZone, (format = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })));
  return format.format(ms);
}

export function isZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// elapsed formats a duration: 12s, 3m 5s, 1h 2m.
export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

type Message = { role: string; timestamp?: number; command?: string; content?: unknown };
export type Index = { tools: Map<string, number>; bash: Map<string, number[]> };

// indexOf maps each tool call ID to its assistant message's time, and each `!` command to the times
// it ran, in order. Tool and `!` components carry no time of their own.
export function indexOf(messages: Message[]): Index {
  const index: Index = { tools: new Map(), bash: new Map() };
  for (const m of messages) {
    if (m.timestamp === undefined) continue;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const c of m.content) if (c?.type === "toolCall") index.tools.set(c.id, m.timestamp);
    } else if (m.role === "bashExecution" && m.command !== undefined) {
      index.bash.set(m.command, [...(index.bash.get(m.command) ?? []), m.timestamp]);
    }
  }
  return index;
}
