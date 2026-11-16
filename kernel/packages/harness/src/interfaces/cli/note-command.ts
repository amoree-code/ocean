import { writeCapture } from "@ocean/services/obsidian/folder-templates.js";

// `ocean note "<text>"` (T-314): capture a thought from the terminal into the inbox.
export async function runNoteCommand(args: string[]): Promise<void> {
  const file = await writeCapture(args.join(" "));
  console.log(file);
}
