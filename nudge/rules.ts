import { createHash } from "node:crypto";

export type Rule = { category: string; tool: string; reason: string; hint: string; test(command: string): boolean };

// leadWord is a segment's command word, past FOO=bar prefixes and an rtk wrapper: the rtk extension
// prefixes commands before tool_result fires.
function leadWord(segment: string): string {
  const words = segment.trim().split(/\s+/);
  let i = 0;
  while (/^[A-Za-z_]\w*=/.test(words[i] ?? "")) i++;
  if (words[i] === "rtk") i++;
  return (words[i] ?? "").replace(/^\\/, "");
}

const RULES: Rule[] = [
  {
    category: "read",
    tool: "read",
    reason: "Reading a file via bash cat/head/tail/sed -n.",
    hint: "offset/limit pick lines",
    // `sed -n '10,40p' f` is a line-range read, not an edit.
    test: (c) => /^(cat|head|tail|less|more|bat)$/.test(leadWord(c)) || (leadWord(c) === "sed" && /\s-n\b/.test(c) && /\d+(,\d+)?p\b/.test(c) && !/\s-i\b/.test(c)),
  },
  { category: "ls", tool: "ls", reason: "Listing a directory via bash ls/tree.", hint: "limit caps entries", test: (c) => /^(ls|tree|exa|eza)$/.test(leadWord(c)) },
  { category: "grep", tool: "grep", reason: "Searching file contents via bash grep/rg.", hint: "glob, context, limit", test: (c) => /^(grep|rg|ag|ack)$/.test(leadWord(c)) },
  { category: "find", tool: "find", reason: "Locating files via bash find/fd.", hint: "glob pattern, limit", test: (c) => /^(find|fd|fdfind)$/.test(leadWord(c)) },
  { category: "edit", tool: "edit", reason: "Editing a file in place via bash `sed -i`.", hint: "exact replacements with a reviewable diff", test: (c) => leadWord(c) === "sed" && /\s-i\b/.test(c) },
];

// A trailing `| head` or `| tail` only trims output, which the tools' limit and offset options do.
const TRAILING_TRIM = /(\s*\|\s*(head|tail)(\s+-n)?(\s+-?\d+)?)+\s*$/;

// skeleton drops heredoc bodies, quoted strings, escapes and comments, so their contents never match.
function skeleton(command: string): string {
  return command
    .replace(/<<-?\s*['"]?(\w+)['"]?([^\n]*)\n[\s\S]*?\n\s*\1\s*(?=\n|$)/g, "<<H$2")
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''")
    .replace(/\\./g, "")
    .replace(/(^|\s)#[^\n]*/g, "$1");
}

// A scratch path is under /tmp, /var/tmp, $TMPDIR, or a variable the command sets from mktemp.
function isScratch(path: string, command: string): boolean {
  if (/^(\/tmp\/|\/var\/tmp\/|\/dev\/|\$\{?TMP|&)/i.test(path)) return true;
  const variable = path.match(/^\$\{?(\w+)/)?.[1];
  // The variable name is \w+, so it is safe inside the pattern.
  return variable !== undefined && new RegExp(`\\b${variable}=["']?\\$\\(mktemp\\b`).test(command);
}

// heredocToFile is true when a heredoc lands in a real file: `cat > f <<EOF`, `cat <<EOF > f`, `tee f <<EOF`.
function heredocToFile(command: string): boolean {
  const head = skeleton(command).split("\n").find((line) => line.includes("<<"));
  if (!head || !/\b(cat|tee)\b/.test(head)) return false;
  // Targets come from the raw header line: the skeleton blanks quoted paths like "$TMPDIR/x".
  const raw = command.split("\n").find((line) => line.includes("<<")) ?? "";
  const targets = [...raw.replace(/<<-?\S*/, "").matchAll(/(?:>{1,2}|\btee(?:\s+-a)?)\s*([^\s;&|<>]+)/g)].map((m) => m[1].replace(/^["']|["']$/g, ""));
  return targets.some((t) => !isScratch(t, command));
}

// scriptWritesFile is true for `python - <<EOF` that opens a file for writing outside scratch dirs.
function scriptWritesFile(command: string): boolean {
  if (!/\bpython3?\s+-\s*<</.test(command) || /\/tmp\/|\bmktemp\b/.test(command)) return false;
  return /open\([^)]*['"][wa]\+?['"]|\.write_(text|bytes)\(/.test(command);
}

const HEREDOC: Rule = {
  category: "heredoc",
  tool: "write",
  reason: "Writing a file via a bash heredoc/script.",
  hint: "or `edit` for changes, so the user sees what changed",
  test: (c) => heredocToFile(c) || scriptWritesFile(c),
};

// simple matches a rule only for a single command: pipes, redirects, chains and subshells are shell work.
const simple = (command: string) => (/[|&;]|\$\(|`|<|>|\n/.test(command.trim()) ? undefined : RULES.find((r) => r.test(command.trim())));

// classify returns the rule for a bash command that stands in for a dedicated tool, or undefined.
// In a chain, a segment that feeds or reads a pipe is shell work; any other segment can match:
// `cat x || ls y` and `ls; pwd` match, `cat x | jq .` and `grep x y > out` do not.
export function classify(command: string): Rule | undefined {
  if (HEREDOC.test(command)) return HEREDOC;
  const cmd = command.trim().replace(TRAILING_TRIM, "");
  const parts = cmd.split(/(\|\||&&|[|;&\n])/);
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i + 1] === "|" || parts[i - 1] === "|") continue;
    const rule = simple(parts[i]);
    if (rule) return rule;
  }
  return undefined;
}

// nudgeFor is the line to append to a bash result for rule, or undefined when the session lacks the
// tool, or lacks tool_search to load a deferred one. A hint that names a missing tool is dropped.
export function nudgeFor(rule: Rule, registered: Set<string>, active: string[]): string | undefined {
  if (!registered.has(rule.tool)) return undefined;
  const live = active.includes(rule.tool);
  if (!live && !registered.has("tool_search")) return undefined;
  const hint = [...rule.hint.matchAll(/`([a-z_]+)`/g)].every((m) => registered.has(m[1])) ? ` (${rule.hint})` : "";
  const how = live ? `Use \`${rule.tool}\`${hint} instead.` : `Load \`${rule.tool}\` with tool_search, then call it${hint}.`;
  return `[nudge] ${rule.reason} ${how} (Use bash for genuine shell pipelines, not chained tool replacements.)`;
}

export const LOOP_THRESHOLD = 3;
const MAX_CYCLE = 5;

// loopTracker returns a function to call per tool result. It returns the cycle's tool names once,
// when the same call or cycle of up to MAX_CYCLE calls repeats threshold times in a row, and stays
// quiet until the pattern breaks. A success keys on tool, arguments and result, so polling that
// sees new output is no loop; a failure keys on tool and first error line, so retries with
// tweaked arguments that hit the same error are.
export function loopTracker(threshold = LOOP_THRESHOLD) {
  const history: { fp: string; tool: string }[] = [];
  let flagged = false;
  return (tool: string, input: unknown, content: unknown, isError = false): string[] | undefined => {
    const first = Array.isArray(content) ? content.find((c) => c?.type === "text")?.text : undefined;
    const key = isError ? [tool, String(first ?? "").split("\n", 1)[0]] : [tool, input, content];
    history.push({ fp: createHash("sha1").update(JSON.stringify(key) ?? "").digest("hex"), tool });
    if (history.length > MAX_CYCLE * threshold) history.shift();
    const n = history.length;
    let cycle = 0;
    for (let k = 1; k <= MAX_CYCLE && !cycle && n >= k * threshold; k++) {
      let repeats = true;
      for (let i = n - k * threshold; i < n - k && repeats; i++) repeats = history[i].fp === history[i + k].fp;
      if (repeats) cycle = k;
    }
    if (!cycle) {
      flagged = false;
      return undefined;
    }
    if (flagged) return undefined;
    flagged = true;
    return history.slice(n - cycle).map((h) => h.tool);
  };
}

export function loopReason(tools: string[], failing: boolean): string {
  const what = tools.length === 1 ? `${failing ? "Calls to" : "Same call to"} \`${tools[0]}\`` : `Same ${tools.length}-call cycle (${tools.map((t) => `\`${t}\``).join(" → ")})`;
  return failing
    ? `[nudge] Possible loop: ${what} matched error signatures ${LOOP_THRESHOLD} times. Read the error and change approach; ask the user only if needed.`
    : `[nudge] Possible loop: ${what} returned the same result ${LOOP_THRESHOLD} times. If this is intentional polling, wait for a relevant change; otherwise try another approach.`;
}
