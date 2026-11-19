// Commands that rtk compresses. rtk passes unknown arguments through to the real command.
const COMMANDS = new Set([
  "git", "gh", "ls", "tree", "grep", "cat", "head", "tail", "tsc", "lint", "eslint", "prettier", "next",
  "cargo", "rustc", "vitest", "playwright", "jest", "test", "pnpm", "npm", "npx", "yarn", "bun",
  "docker", "kubectl", "aws", "psql", "wc", "prisma", "dotnet",
]);
const OPERATORS = new Set(["&&", "||", ";", "|"]);

// splitChain splits a command line at top-level &&, ||, ; and |, keeping each operator as its own
// part. Operators inside quotes stay in their part. It returns undefined on an unbalanced quote.
export function splitChain(command: string): string[] | undefined {
  const parts: string[] = [];
  let buf = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      buf += c;
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') {
      quote = c;
      buf += c;
    } else if ((c === "&" || c === "|") && command[i + 1] === c) {
      parts.push(buf, c + c);
      buf = "";
      i++;
    } else if (c === ";" || c === "|") {
      parts.push(buf, c);
      buf = "";
    } else {
      buf += c;
    }
  }
  if (quote) return undefined;
  parts.push(buf);
  return parts;
}

// rewriteChain prefixes each known command in a chain with rtk. It leaves a segment alone when its
// output pipes into the next one, and the whole line alone when it has a redirect or cannot parse:
// those need the command's own output.
export function rewriteChain(command: string, rtk = "rtk"): string {
  // ponytail: any < or >, even quoted, skips the line; exact handling needs a shell parser.
  if (/[<>]/.test(command)) return command;
  const parts = splitChain(command);
  if (!parts) return command;
  return parts
    .map((part, i) => {
      if (OPERATORS.has(part.trim()) || parts[i + 1]?.trim() === "|") return part;
      const body = part.trimStart();
      const lead = part.slice(0, part.length - body.length);
      const word = body.split(/\s/)[0];
      return COMMANDS.has(word) ? `${lead}${rtk} ${body}` : part;
    })
    .join("");
}
