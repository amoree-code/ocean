import { randomUUID } from "node:crypto";
import type { SessionStoreFactory } from "@ocean/core/domain/ports/session-store-port.js";

// A light session per MCP connection (T-319) for a client Ocean has no other way to see: Claude
// Desktop runs no CLI to intercept and no session hook, so without this it has no session at
// all. Opened on the connection's first tool call (an app that starts the server and never asks
// Ocean anything leaves no empty record), one `mcp_tool_call` event per call holding only the
// tool name and whether it succeeded — never arguments or results — and completed when the
// connection ends. Recording never fails a tool call.

export type McpSessionRecorder = {
  // Opens the connection's session before its first tool runs, so a memory change that call
  // makes is stamped with it (OCEAN_SESSION_ID, which the memory audit reads).
  open(clientName: string): Promise<void>;
  toolCall(clientName: string, tool: string, ok: boolean): Promise<void>;
  close(): Promise<void>;
};

export function createMcpSessionRecorder(options: {
  openStore: SessionStoreFactory;
  // The client id to record a session under, or null for a client recorded some other way.
  providerOf: (clientName: string) => string | null;
  cwd?: string;
  // Where the session id is published for the memory audit; the server process's own env.
  env?: NodeJS.ProcessEnv;
}): McpSessionRecorder {
  const env = options.env ?? process.env;
  let sessionId: string | null = null;

  async function withStore(
    run: (store: Awaited<ReturnType<SessionStoreFactory>>) => void,
  ): Promise<void> {
    try {
      const store = await options.openStore();
      try {
        run(store);
      } finally {
        store.close();
      }
    } catch {
      // The session store is a record, not a dependency of the tool call.
    }
  }

  // Creates the connection's session once.
  function ensure(
    store: Awaited<ReturnType<SessionStoreFactory>>,
    clientName: string,
    provider: string,
  ): void {
    if (!sessionId) {
      const id = randomUUID();
      store.create({
        sessionId: id,
        title: `${provider} over MCP`,
        provider,
        providerSessionId: null,
        parentSessionId: null,
        profile: `mcp:${provider}`,
        profileIdentity: "",
        workingDirectory: options.cwd ?? process.cwd(),
        resumeData: null,
      });
      store.updateStatus(id, "running");
      store.appendEvent(
        id,
        "mcp_connection",
        JSON.stringify({ client: clientName }),
      );
      sessionId = id;
      // A session id the client itself set is kept.
      if (!env.OCEAN_SESSION_ID) env.OCEAN_SESSION_ID = id;
    }
  }

  return {
    async open(clientName) {
      const provider = options.providerOf(clientName);
      if (!provider || sessionId) return;
      await withStore((store) => ensure(store, clientName, provider));
    },
    async toolCall(clientName, tool, ok) {
      const provider = options.providerOf(clientName);
      if (!provider) return;
      await withStore((store) => {
        ensure(store, clientName, provider);
        store.appendEvent(
          sessionId as string,
          "mcp_tool_call",
          JSON.stringify({ tool, ok }),
        );
      });
    },
    async close() {
      const id = sessionId;
      if (!id) return;
      await withStore((store) => store.updateStatus(id, "completed"));
    },
  };
}
