// The only file in Ocean permitted to know a browser engine. Everything above the
// BrowserProvider boundary (browser-provider.ts) stays engine-neutral.
//
// Depends on `playwright-core`, not `playwright`: playwright-core ships the driver and
// API without downloading a Chromium binary on install, so `pnpm install` stays light and
// a missing browser binary is a reportable `detect()` failure rather than an install-time
// requirement.
//
// A session survives between CLI invocations: the browser is launched as its own
// detached process with a remote-debugging port, and later invocations reconnect over
// CDP by port. Without this, a multi-step browser task would mean a new browser per
// step, which is not a session.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { oceanEnv } from "../../paths.js";
import type {
  BrowserElement,
  BrowserHandle,
  BrowserLaunch,
  BrowserProvider,
} from "./browser-provider.js";

// A download's suggested filename comes from the remote page/server (e.g. a
// Content-Disposition header) and must never be trusted as a path: it can contain `../`,
// an absolute path, or backslash separators aimed at escaping destinationDir.
export function safeDownloadFilename(suggested: string): string {
  const normalized = suggested.replace(/\\/g, "/");
  const base = path.posix.basename(normalized).trim();
  return !base || base === "." || base === ".." ? "download" : base;
}

export function resolveDownloadPath(
  destinationDir: string,
  suggestedFilename: string,
): string {
  const resolvedDir = path.resolve(destinationDir);
  const candidate = path.resolve(
    resolvedDir,
    safeDownloadFilename(suggestedFilename),
  );
  if (
    candidate !== resolvedDir &&
    !candidate.startsWith(resolvedDir + path.sep)
  ) {
    throw new Error(
      `Download path escapes destination directory: ${suggestedFilename}`,
    );
  }
  return candidate;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function fetchWebSocketDebuggerUrl(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    const body = (await response.json()) as { webSocketDebuggerUrl?: string };
    return body.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

function _nthIndex(value: string, needle: string, occurrence: number): number {
  let from = 0;
  for (let current = 1; current <= occurrence; current += 1) {
    const index = value.indexOf(needle, from);
    if (index < 0) return -1;
    if (current === occurrence) return index;
    from = index + needle.length;
  }
  return -1;
}

function resolveChromiumExecutable(): string | null {
  const candidates = [
    oceanEnv("BROWSER_EXECUTABLE"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export class PlaywrightBrowserProvider implements BrowserProvider {
  async detect(): Promise<{ ok: boolean; detail: string }> {
    const executable = resolveChromiumExecutable();
    if (!executable)
      return {
        ok: false,
        detail:
          "no Chromium-family browser binary found; set OCEAN_BROWSER_EXECUTABLE",
      };
    return { ok: true, detail: executable };
  }

  async launch(profileDir: string, port?: number): Promise<BrowserLaunch> {
    const executable = resolveChromiumExecutable();
    if (!executable)
      throw new Error("Browser capability denied: no browser binary detected");
    const resolvedPort = port ?? (await freePort());
    await mkdir(profileDir, { recursive: true });
    const child = spawn(
      executable,
      [
        `--remote-debugging-port=${resolvedPort}`,
        `--remote-debugging-address=127.0.0.1`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--headless=new",
        "--disable-gpu",
        "about:blank",
      ],
      { stdio: "ignore", detached: true },
    );
    child.unref();
    let endpoint: string | null = null;
    for (let attempt = 0; attempt < 100 && !endpoint; attempt += 1) {
      endpoint = await fetchWebSocketDebuggerUrl(resolvedPort);
      if (!endpoint) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!endpoint) {
      child.kill();
      throw new Error(
        "Browser did not expose a debugging endpoint within the timeout",
      );
    }
    return { pid: child.pid ?? -1, port: resolvedPort, endpoint, profileDir };
  }

  async connect(launch: BrowserLaunch): Promise<BrowserHandle> {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${launch.port}`,
    );
    const context: BrowserContext =
      browser.contexts()[0] ?? (await browser.newContext());
    const page: Page = context.pages()[0] ?? (await context.newPage());
    return new PlaywrightHandle(browser, page);
  }

  async close(launch: BrowserLaunch): Promise<void> {
    if (launch.pid > 0) {
      try {
        process.kill(launch.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
    }
  }
}

class PlaywrightHandle implements BrowserHandle {
  constructor(
    private readonly browser: Browser,
    private readonly page: Page,
  ) {}

  async state() {
    return { url: this.page.url(), title: await this.page.title() };
  }

  async navigate(url: string, timeoutMs = 30_000) {
    await this.page.goto(url, {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });
    return this.state();
  }

  async readText() {
    const text = (
      (await this.page.innerText("body")) ||
      (await this.page.locator("body").textContent()) ||
      ""
    ).slice(0, 20_000);
    return { ...(await this.state()), text };
  }

  async observe() {
    const elements = (await this.page.$$eval(
      "a,button,input,select,textarea,[role=button]",
      (nodes) =>
        nodes.slice(0, 120).map((node) => {
          const element = node as HTMLInputElement;
          return {
            tag: element.tagName.toLowerCase(),
            type: (element as { type?: string }).type ?? null,
            name: element.name || null,
            id: element.id || null,
            text: (element.innerText || element.value || "")
              .trim()
              .slice(0, 80),
            visible: Boolean(element.offsetWidth || element.offsetHeight),
          };
        }),
    )) as BrowserElement[];
    return { ...(await this.state()), elements };
  }

  async extract(selector: string, attribute: string | null) {
    const values = attribute
      ? await this.page.$$eval(
          selector,
          (nodes, attr) => nodes.map((node) => node.getAttribute(attr)),
          attribute,
        )
      : await this.page.$$eval(selector, (nodes) =>
          nodes.map(
            (node) =>
              (node as HTMLInputElement).innerText?.trim() ||
              (node as HTMLInputElement).value?.trim() ||
              "",
          ),
        );
    return { selector, count: values.length, values: values.slice(0, 200) };
  }

  async click(selector: string, timeoutMs = 15_000) {
    const urlBefore = this.page.url();
    await this.page.click(selector, { timeout: timeoutMs });
    await this.page.waitForTimeout(300);
    return { ...(await this.state()), urlBefore };
  }

  async type(selector: string, text: string, clear = true) {
    let locator = this.editorLocator(selector);
    await locator.waitFor({ state: "visible", timeout: 15_000 });
    const nestedEditor = locator.locator("textarea, input").first();
    if ((await nestedEditor.count()) > 0) locator = nestedEditor;
    const kind = await locator.evaluate((node) => ({
      tag: node.tagName.toLowerCase(),
      contentEditable: node instanceof HTMLElement && node.isContentEditable,
      value: "value" in node ? String((node as HTMLInputElement).value) : null,
    }));

    if (
      kind.contentEditable ||
      (kind.tag !== "input" && kind.tag !== "textarea")
    ) {
      await locator.click();
      if (clear) {
        await this.page.keyboard.press("ControlOrMeta+A");
        await this.page.keyboard.press("Backspace");
      }
      await this.page.keyboard.insertText(text);
    } else {
      if (clear) await locator.fill("");
      await locator.pressSequentially(text, { timeout: 15_000 });
    }

    const value = await locator.evaluate((node) => {
      if ("value" in node) return String((node as HTMLInputElement).value);
      return (node.textContent || (node as HTMLElement).innerText || "").trim();
    });
    return { selector, typed: text.length, value };
  }

  async replaceText(
    selector: string,
    oldText: string,
    newText: string,
    occurrence = 1,
  ) {
    if (!oldText) throw new Error("old-text must not be empty");
    if (!Number.isInteger(occurrence) || occurrence < 1)
      throw new Error("occurrence must be a positive integer");
    const locator = this.editorLocator(selector);
    await locator.waitFor({ state: "visible", timeout: 15_000 });
    const editorKind = await locator.evaluate((node) => ({
      monaco:
        node.classList.contains("monaco-editor") ||
        Boolean(node.querySelector(".monaco-editor")),
      codeMirror:
        node.classList.contains("CodeMirror") ||
        Boolean(node.querySelector(".CodeMirror")),
    }));
    if (editorKind.monaco) {
      const input = locator.locator("textarea.inputarea").first();
      await input.click();
      await this.page.keyboard.press("ControlOrMeta+f");
      await this.page.keyboard.insertText(oldText);
      for (let index = 1; index < occurrence; index += 1)
        await this.page.keyboard.press("Enter");
      await this.page.keyboard.press("Escape");
      await this.page.keyboard.insertText(newText);
      const value = await locator.locator(".view-lines").innerText();
      if (value.includes(oldText))
        throw new Error(`Text occurrence was not replaced: ${occurrence}`);
      return { selector, oldText, newText, occurrence, value };
    }
    const result = await locator.evaluate(
      (node, input) => {
        const root = node as HTMLElement;
        const nthIndexInPage = (
          value: string,
          needle: string,
          occurrence: number,
        ): number => {
          let from = 0;
          for (let current = 1; current <= occurrence; current += 1) {
            const index = value.indexOf(needle, from);
            if (index < 0) return -1;
            if (current === occurrence) return index;
            from = index + needle.length;
          }
          return -1;
        };
        const global = window as typeof window & {
          monaco?: {
            editor?: {
              getEditors?: () => Array<{
                getDomNode?: () => HTMLElement | null;
                getModel?: () => {
                  getValue(): string;
                  findMatches(text: string): Array<{
                    range: {
                      startLineNumber: number;
                      startColumn: number;
                      endLineNumber: number;
                      endColumn: number;
                    };
                  }>;
                  pushEditOperations(
                    _: unknown,
                    edits: unknown[],
                    __: unknown,
                  ): void;
                } | null;
              }>;
              getModels?: () => Array<{
                getValue(): string;
                findMatches(text: string): Array<{
                  range: {
                    startLineNumber: number;
                    startColumn: number;
                    endLineNumber: number;
                    endColumn: number;
                  };
                }>;
                pushEditOperations(
                  _: unknown,
                  edits: unknown[],
                  __: unknown,
                ): void;
              }>;
            };
          };
        };
        const editors = global.monaco?.editor?.getEditors?.() ?? [];
        const editor = editors.find(
          (candidate) => candidate.getDomNode?.() === root,
        );
        const model =
          editor?.getModel?.() ??
          global.monaco?.editor
            ?.getModels?.()
            .find((candidate) => candidate.getValue().includes(input.oldText));
        if (model) {
          const matches = model.findMatches(input.oldText);
          const match = matches[input.occurrence - 1];
          if (!match)
            throw new Error(`Text occurrence not found: ${input.occurrence}`);
          model.pushEditOperations(
            [],
            [{ range: match.range, text: input.newText }],
            null,
          );
          return { value: model.getValue(), occurrence: input.occurrence };
        }
        const target = root.matches("textarea,input")
          ? (root as HTMLInputElement)
          : (root.querySelector("textarea,input") as HTMLInputElement | null);
        const value =
          target && "value" in target
            ? String(target.value)
            : (root.textContent ?? "");
        const index = nthIndexInPage(value, input.oldText, input.occurrence);
        if (index < 0)
          throw new Error(`Text occurrence not found: ${input.occurrence}`);
        const next =
          value.slice(0, index) +
          input.newText +
          value.slice(index + input.oldText.length);
        if (target) {
          target.value = next;
          target.dispatchEvent(new Event("input", { bubbles: true }));
        } else root.textContent = next;
        return { value: next, occurrence: input.occurrence };
      },
      { oldText, newText, occurrence },
    );
    return {
      selector,
      oldText,
      newText,
      occurrence: result.occurrence,
      value: result.value,
    };
  }

  private editorLocator(selector: string) {
    const separator = " >>> ";
    const frameIndex = selector.indexOf(separator);
    if (frameIndex >= 0) {
      const frameSelector = selector.slice(0, frameIndex);
      const editorSelector = selector.slice(frameIndex + separator.length);
      if (!frameSelector || !editorSelector)
        throw new Error("Editor frame selector must use 'frame >>> editor'.");
      return this.page
        .frameLocator(frameSelector)
        .locator(editorSelector)
        .first();
    }
    return this.page.locator(selector).first();
  }

  async select(selector: string, value: string) {
    await this.page.selectOption(selector, value, { timeout: 15_000 });
    return {
      selector,
      value: await this.page.inputValue(selector, { timeout: 5_000 }),
    };
  }

  async scroll(deltaY = 600) {
    await this.page.mouse.wheel(0, deltaY);
    await this.page.waitForTimeout(150);
    const scrollY = await this.page.evaluate(() => Math.round(window.scrollY));
    return { scrollY };
  }

  async wait(options: {
    selector?: string;
    urlContains?: string;
    timeoutMs?: number;
  }) {
    const timeout = options.timeoutMs ?? 15_000;
    if (options.selector)
      await this.page.waitForSelector(options.selector, { timeout });
    if (options.urlContains)
      await this.page.waitForURL(`**${options.urlContains}**`, { timeout });
    return this.state();
  }

  async upload(selector: string, paths: string[]) {
    await this.page.setInputFiles(selector, paths, { timeout: 15_000 });
    const attached = await this.page.$eval(selector, (node) =>
      Array.from((node as HTMLInputElement).files ?? []).map(
        (file) => file.name,
      ),
    );
    return { selector, attached };
  }

  async download(selector: string, destinationDir: string, timeoutMs = 60_000) {
    const [download] = await Promise.all([
      this.page.waitForEvent("download", { timeout: timeoutMs }),
      this.page.click(selector, { timeout: timeoutMs }),
    ]);
    await mkdir(destinationDir, { recursive: true });
    const targetPath = resolveDownloadPath(
      destinationDir,
      download.suggestedFilename(),
    );
    await download.saveAs(targetPath);
    const { statSync } = await import("node:fs");
    const size = existsSync(targetPath) ? statSync(targetPath).size : 0;
    return { selector, path: targetPath, size };
  }

  async submit(selector: string, timeoutMs = 20_000) {
    const urlBefore = this.page.url();
    const bodyBefore = (await this.page.innerText("body")).slice(0, 20_000);
    await this.page.click(selector, { timeout: timeoutMs });
    try {
      await this.page.waitForLoadState("domcontentloaded", {
        timeout: timeoutMs,
      });
    } catch {
      /* best-effort */
    }
    await this.page.waitForTimeout(400);
    const bodyAfter = (await this.page.innerText("body")).slice(0, 20_000);
    return { ...(await this.state()), urlBefore, bodyBefore, bodyAfter };
  }

  async release() {
    await this.browser.close();
  }
}
