import { homedir } from "node:os";
import { type BashOperations, createLocalBashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shellFor } from "./shell.ts";

export default function (pi: ExtensionAPI) {
  const shell = shellFor(process.env.SHELL, homedir());
  if (!shell) return;
  const inner = createLocalBashOperations({ shellPath: shell.path });
  const operations: BashOperations = { exec: (command, cwd, options) => inner.exec(shell.wrap(command), cwd, options) };
  pi.on("user_bash", () => ({ operations }));
}
