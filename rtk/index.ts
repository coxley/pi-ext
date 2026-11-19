import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { type ExtensionAPI, getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { installRtk } from "./install.ts";
import { rewriteChain } from "./rewrite.ts";

export default function (pi: ExtensionAPI) {
  // Pi's bash tool puts this dir on PATH, so a bare `rtk` finds an rtk installed here.
  const bin = join(getAgentDir(), "bin");
  let ready = [bin, ...(process.env.PATH ?? "").split(delimiter)].some((dir) => dir && existsSync(join(dir, "rtk")));
  let installing: Promise<void> | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ready || process.env.PI_OFFLINE) return;
    installing ??= installRtk(bin).then(
      (version) => {
        ready = true;
        ctx.ui.notify(`rtk: installed ${version} in ${bin}`, "info");
      },
      (err: Error) => ctx.ui.notify(`rtk: install failed, bash runs without it: ${err.message}`, "warning"),
    );
  });

  // The tool_call event's input is the call's arguments; Pi runs what the handler leaves there.
  pi.on("tool_call", (event) => {
    if (ready && isToolCallEventType("bash", event)) event.input.command = rewriteChain(event.input.command);
  });
}
