import { spawn } from "node:child_process";
import { sessionFactsEnabled } from "@ocean/brain/memory/memory-audit.js";
import { oceanEnv } from "@ocean/core/shared/paths.js";
import {
  type ClaudeSessionEndPayload,
  isSessionEndClient,
  payloadCwd,
  type SessionEndClient,
  TRANSCRIPT_CLIENTS,
} from "@ocean/loop/hooks/session-end-hook.js";
import { runSessionFacts } from "@ocean/loop/hooks/session-facts-hook.js";
import { defaultSessionStoreFactory } from "../../composition/runtime.js";
import {
  FACTS_CALL_ENV,
  sessionFactsCompleter,
} from "../../infrastructure/providers/session-facts-completer.js";

// True inside the model call fact capture makes (T-313): that call's own hooks do nothing.
export function insideFactsCall(): boolean {
  return oceanEnv(FACTS_CALL_ENV) === "1";
}

// From SessionEnd and PreCompact: capture runs as its own detached process, since a hook has
// seconds and a model call takes longer, and the client may exit as soon as the hook returns.
export async function startSessionFacts(
  payload: ClaudeSessionEndPayload,
  client: SessionEndClient,
): Promise<void> {
  if (!payload.session_id || !payload.transcript_path) return;
  if (!TRANSCRIPT_CLIENTS.includes(client)) return;
  if (!(await sessionFactsEnabled())) return;
  try {
    spawn(
      process.execPath,
      [
        process.argv[1],
        "hook",
        "session-facts",
        "--client",
        client,
        "--session",
        payload.session_id,
        "--transcript",
        payload.transcript_path,
        "--cwd",
        payloadCwd(payload),
      ],
      { detached: true, stdio: "ignore" },
    )
      .on("error", () => {})
      .unref();
  } catch {
    // no capture this time; the next PreCompact or SessionEnd reads from the same cursor
  }
}

const usage =
  "Usage: ocean hook session-facts --client claude|codex --session <id> --transcript <path> [--cwd <dir>]";

// `ocean hook session-facts`: one capture run, in the foreground (the detached process above, or
// by hand to see what a session yields). Prints the run as JSON.
export async function runSessionFactsCommand(args: string[]): Promise<void> {
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const client = value("--client") ?? "claude";
  const sessionId = value("--session");
  const transcript = value("--transcript");
  if (!isSessionEndClient(client) || !sessionId || !transcript) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }
  const run = await runSessionFacts(
    {
      session_id: sessionId,
      transcript_path: transcript,
      cwd: value("--cwd"),
    },
    defaultSessionStoreFactory,
    client,
    (each) => sessionFactsCompleter(each),
  );
  console.log(JSON.stringify(run, null, 2));
}
