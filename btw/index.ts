import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { excerpt, parse, TURNS, textOf } from "./context.ts";

const TYPE = "btw";
const SYSTEM = [
  "You answer a side question the user asks while a coding agent works on their main task.",
  "You have no tools. Answer from the conversation excerpt and your own knowledge; say so when you cannot tell.",
  "Answer briefly and directly.",
].join(" ");

type Answer = { question: string; answer: string; model: string; ms: number; error?: string };

export default function (pi: ExtensionAPI) {
  const running = new Map<AbortController, string>();
  let ui: ExtensionContext["ui"] | undefined;
  type Model = NonNullable<ExtensionContext["model"]>;

  const show = () => {
    const u = ui;
    if (!u) return;
    const lines = [...running.values()].map((q) => `${u.theme.fg("accent", "◌ btw")} ${u.theme.fg("dim", q)}`);
    u.setWidget(TYPE, lines.length ? lines : undefined, { placement: "aboveEditor" });
  };

  async function ask(model: Model, question: string, context: string, ctx: ExtensionContext, signal: AbortSignal): Promise<string> {
    const text = context ? `Recent conversation from the main session, read-only:\n\n${context}\n\n---\n\nQuestion: ${question}` : question;
    const message = await ctx.modelRegistry
      .streamSimple(model, { systemPrompt: SYSTEM, messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] }, { reasoning: pi.getThinkingLevel(), signal })
      .result();
    if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage || message.stopReason);
    return textOf(message.content) || "No answer returned.";
  }

  pi.registerCommand("btw", {
    description: `Ask a side question without interrupting the agent; it sees the last ${TURNS} turns (--no-ctx: none)`,
    handler: async (args, ctx) => {
      const { question, withContext } = parse(args);
      if (!question) return ctx.ui.notify("Usage: /btw [--no-ctx] <question>", "warning");
      if (!ctx.model) return ctx.ui.notify("btw: no model is selected", "error");
      ui = ctx.ui;
      const context = withContext ? excerpt(ctx.sessionManager.buildSessionContext().messages) : "";
      const abort = new AbortController();
      const { model } = ctx;
      const name = model.name || model.id;
      const start = Date.now();
      running.set(abort, question);
      show();
      // The command returns at once, so the aside runs next to the main agent.
      void ask(model, question, context, ctx, abort.signal)
        .then(
          (answer) => ({ answer }),
          (error: unknown) => ({ answer: "", error: error instanceof Error ? error.message : String(error) }),
        )
        .then((result) => {
          running.delete(abort);
          if (abort.signal.aborted) return;
          show();
          // A custom entry is display-only: it never reaches the model and never steers a running turn.
          pi.appendEntry<Answer>(TYPE, { question, model: name, ms: Date.now() - start, ...result });
        });
    },
  });

  pi.registerEntryRenderer<Answer>(TYPE, (entry, _options, theme) => {
    const a = entry.data;
    if (!a) return undefined;
    const card = new Box(1, 1, (s) => theme.bg("customMessageBg", s));
    const status = a.error ? theme.fg("error", "✗") : theme.fg("success", "✓");
    card.addChild(new Text(`${status} ${theme.fg("accent", theme.bold("btw"))} ${theme.fg("muted", `· ${a.model} · ${(a.ms / 1000).toFixed(1)}s`)}`, 0, 0));
    card.addChild(new Text(theme.fg("dim", a.question), 0, 0));
    card.addChild(new Spacer(1));
    card.addChild(a.error ? new Text(theme.fg("error", a.error), 0, 0) : new Markdown(a.answer, 0, 0, getMarkdownTheme(), { color: (s) => theme.fg("customMessageText", s) }));
    return card;
  });

  pi.on("session_shutdown", () => {
    for (const abort of running.keys()) abort.abort();
    running.clear();
    ui?.setWidget(TYPE, undefined);
    ui = undefined;
  });
}
