// `ocean project snippet <id>` (T-333): the two lines to paste into a Claude Desktop project's
// instructions, so every chat in it starts from that project's brief and is saved under it.
export function projectSnippet(id: string): string {
  return [
    `At the start of each chat, call the ocean_context tool with project "${id}".`,
    `When saving this chat to Ocean, call ocean_session_save with project "${id}".`,
  ].join("\n");
}
