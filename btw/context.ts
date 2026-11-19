export const TURNS = 10;

type Message = { role: string; content?: unknown };

// textOf joins a message's text blocks; it drops thinking, tool calls, and images.
export function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// excerpt flattens the last `turns` user and assistant messages with text into a read-only preamble,
// or "" when there are none. Tool results are dropped.
export function excerpt(messages: readonly Message[], turns = TURNS): string {
  const lines = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => [m.role === "user" ? "User" : "Assistant", textOf(m.content)])
    .filter(([, text]) => text)
    .slice(-turns);
  return lines.map(([who, text]) => `${who}: ${text}`).join("\n\n");
}

// parse splits "/btw" arguments into the question and whether to include the main conversation.
export function parse(args: string): { question: string; withContext: boolean } {
  const words = args.trim().split(/\s+/).filter(Boolean);
  return { question: words.filter((w) => w !== "--no-ctx").join(" "), withContext: !words.includes("--no-ctx") };
}
