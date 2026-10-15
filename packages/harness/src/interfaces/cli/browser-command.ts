import {
  BrowserService,
  type ClickExpectation,
} from "../../application/browser/browser-service.js";
import {
  BrowserSessionManager,
  browserDownloadsPath,
} from "../../application/browser/browser-session.js";
import { BrowserTaskRunner } from "../../application/browser/browser-task-runner.js";
import { openSessionStore } from "../../infrastructure/persistence/session-store.js";
import { PlaywrightBrowserProvider } from "../../infrastructure/providers/playwright-browser-provider.js";

export async function runBrowserCommand(
  action: string,
  args: string[],
): Promise<void> {
  const store = await openSessionStore();
  const manager = new BrowserSessionManager(
    store,
    new BrowserService(new PlaywrightBrowserProvider()),
  );
  const runner = new BrowserTaskRunner(manager);
  try {
    if (action === "detect") return print(await manager.detect());
    if (action === "open") {
      const profile = flag(args, "--profile") ?? "default";
      const portText = flag(args, "--port");
      const port = portText === undefined ? undefined : Number(portText);
      if (
        port !== undefined &&
        (!Number.isInteger(port) || port <= 0 || port > 65_535)
      )
        throw new Error("Browser port must be an integer between 1 and 65535.");
      return print(await manager.open(profile, port));
    }
    if (action === "show")
      return print(manager.show(required(args, 0, "session-id")));
    if (action === "events")
      return print(manager.events(required(args, 0, "session-id")));
    if (action === "close")
      return print(await manager.close(required(args, 0, "session-id")));
    if (action === "approve")
      return print(await manager.approve(required(args, 0, "session-id")));

    const sessionId = required(args, 0, "session-id");
    if (action === "navigate")
      return print(
        await manager.navigate(
          sessionId,
          required(args, 1, "url"),
          args.includes("--approve"),
          numberFlag(args, "--timeout"),
        ),
      );
    if (action === "read") return print(await manager.read(sessionId));
    if (action === "observe") return print(await manager.observe(sessionId));
    if (action === "extract")
      return print(
        await manager.extract(
          sessionId,
          required(args, 1, "selector"),
          flag(args, "--attribute") ?? null,
        ),
      );
    if (action === "click")
      return print(
        await manager.click(
          sessionId,
          required(args, 1, "selector"),
          parseExpectation(args),
          numberFlag(args, "--timeout"),
        ),
      );
    if (action === "type")
      return print(
        await manager.type(
          sessionId,
          required(args, 1, "selector"),
          required(args, 2, "text"),
          !args.includes("--no-clear"),
        ),
      );
    if (action === "select")
      return print(
        await manager.select(
          sessionId,
          required(args, 1, "selector"),
          required(args, 2, "value"),
        ),
      );
    if (action === "replace-text")
      return print(
        await manager.replaceText(
          sessionId,
          required(args, 1, "selector"),
          required(args, 2, "old-text"),
          required(args, 3, "new-text"),
          numberFlag(args, "--occurrence"),
        ),
      );
    if (action === "scroll")
      return print(
        await manager.scroll(
          sessionId,
          numberFlag(args, "--delta") ?? Number(args[1] ?? "600"),
        ),
      );
    if (action === "wait")
      return print(
        await manager.wait(sessionId, {
          selector: flag(args, "--selector"),
          urlContains: flag(args, "--url-contains"),
          timeoutMs: numberFlag(args, "--timeout"),
        }),
      );
    if (action === "upload") {
      const selector = required(args, 1, "selector");
      const paths = args.slice(2).filter((value) => !value.startsWith("--"));
      if (!paths.length)
        throw new Error(
          "Usage: ocean browser upload <session-id> <selector> <path>... --approve",
        );
      return print(
        await manager.upload(
          sessionId,
          selector,
          paths,
          args.includes("--approve"),
        ),
      );
    }
    if (action === "download") {
      const selector = required(args, 1, "selector");
      const destination =
        flag(args, "--destination") ?? browserDownloadsPath(sessionId);
      return print(
        await manager.download(
          sessionId,
          selector,
          destination,
          args.includes("--approve"),
          numberFlag(args, "--timeout"),
        ),
      );
    }
    if (action === "submit")
      return print(
        await manager.submit(
          sessionId,
          required(args, 1, "selector"),
          args.includes("--approve"),
          numberFlag(args, "--timeout"),
        ),
      );
    if (action === "run") {
      const taskPath = required(args, 1, "task-file");
      const task = await BrowserTaskRunner.fromFile(taskPath);
      return print(
        await runner.run(sessionId, task, args.includes("--approve")),
      );
    }

    usage();
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

function parseExpectation(args: string[]): ClickExpectation {
  const value = flag(args, "--expect");
  if (value === "navigates" || value === "stays") return { kind: value };
  if (value?.startsWith("count:")) {
    const separator = value.lastIndexOf(":");
    const selector = value.slice("count:".length, separator);
    const expected = Number(value.slice(separator + 1));
    if (selector && Number.isInteger(expected) && expected >= 0)
      return { kind: "selector-count", selector, expected };
  }
  throw new Error(
    "Click requires --expect navigates|stays|count:<selector>:<expected>",
  );
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function numberFlag(args: string[], name: string): number | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive number.`);
  return parsed;
}

function required(args: string[], index: number, name: string): string {
  const value = args[index];
  if (!value || value.startsWith("--"))
    throw new Error(`Usage error: missing ${name}.`);
  return value;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): void {
  console.error(
    "Usage: ocean browser detect|open|show|events|close|approve|navigate|read|observe|extract|click|type|replace-text|select|scroll|wait|upload|download|submit|run",
  );
}
