export type UserShell = { path: string; wrap(command: string): string };

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// shellFor picks the shell for `!` commands: $SHELL, or none to keep Pi's bash. zsh sources .zshrc
// first, so aliases and functions work; eval parses the command after .zshrc defines them.
export function shellFor(shell: string | undefined, home: string): UserShell | undefined {
  const name = shell?.split("/").pop();
  if (!shell || !name || name === "bash") return undefined;
  if (name !== "zsh") return { path: shell, wrap: (command) => command };
  const rc = quote(`${home}/.zshrc`);
  return { path: shell, wrap: (command) => `. ${rc} 2>/dev/null; eval ${quote(command)}` };
}
