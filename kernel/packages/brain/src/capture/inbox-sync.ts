import { readFile, writeFile } from "node:fs/promises";
import type { SessionStorePort } from "@ocean/core/domain/ports/session-store-port.js";
import { INBOX_DIR, oceanPath } from "@ocean/core/shared/paths.js";

const marker = "## Capture candidates (generated)";

export async function syncCaptureInbox(store: SessionStorePort): Promise<void> {
  const file = oceanPath(INBOX_DIR, "INBOX.md");
  let current: string;
  try {
    current = await readFile(file, "utf8");
  } catch {
    return;
  }
  const base = current.split(marker)[0].trimEnd();
  const items = store.listCaptureItems("new");
  const generated =
    items.length === 0
      ? `${marker}\n\n_No new capture candidates._`
      : `${marker}\n\n${items.map((item) => `- [${item.captureId}] ${item.content.replace(/\s+/g, " ").trim()} _(session ${item.sessionId})_`).join("\n")}`;
  const next = `${base}\n\n${generated}\n`;
  if (next !== current) await writeFile(file, next, "utf8");
}
