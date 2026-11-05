import { access } from "node:fs/promises";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import { backfillSessionProjects } from "@ocean/loop/sessions/session-projects.js";

export async function runMigrateCommand(apply: boolean): Promise<void> {
  const database = oceanPath(SYSTEM_DIR, "sessions", "sessions.sqlite");
  const exists = await access(database).then(
    () => true,
    () => false,
  );
  if (!apply) {
    console.log(
      JSON.stringify(
        {
          applyRequired: true,
          databaseExists: exists,
          action: "ocean migrate --apply",
          note: "Applying opens the session database and runs idempotent schema migrations.",
        },
        null,
        2,
      ),
    );
    return;
  }
  const store = await openSessionStore();
  try {
    const projects = await backfillSessionProjects(store);
    console.log(
      JSON.stringify(
        { migrated: true, integrity: store.integrityCheck(), projects },
        null,
        2,
      ),
    );
  } finally {
    store.close();
  }
}
