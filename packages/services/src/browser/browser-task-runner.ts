import { readFile } from "node:fs/promises";
import type { BrowserSessionManager } from "./browser-session.js";

export type BrowserTaskStep =
  | { action: "navigate"; url: string }
  | { action: "click"; selector: string; expect?: "navigates" | "stays" }
  | { action: "type"; selector: string; text: string; clear?: boolean }
  | { action: "select"; selector: string; value: string }
  | { action: "scroll"; deltaY?: number }
  | {
      action: "wait";
      selector?: string;
      urlContains?: string;
      timeoutMs?: number;
    }
  | { action: "read" }
  | { action: "extract"; selector: string; attribute?: string }
  | { action: "submit"; selector: string };

export type BrowserTask = {
  steps: BrowserTaskStep[];
  retries?: number;
};

export class BrowserTaskRunner {
  constructor(private readonly manager: BrowserSessionManager) {}

  async run(sessionId: string, task: BrowserTask, approved = false) {
    if (!Array.isArray(task.steps) || task.steps.length === 0)
      throw new Error("Browser task must contain at least one step.");
    if (task.steps.length > 100)
      throw new Error("Browser task exceeds the 100-step limit.");
    const retries = Math.max(0, Math.min(3, task.retries ?? 0));
    const results: unknown[] = [];
    for (const step of task.steps) {
      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const result = await this.execute(sessionId, step, approved);
          if (isUnverified(result))
            throw new Error(`Browser step was not verified: ${step.action}`);
          results.push(result);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < retries)
            await new Promise((resolve) =>
              setTimeout(resolve, 100 * (attempt + 1)),
            );
        }
      }
      if (lastError) throw lastError;
    }
    return { completed: true, steps: results.length, results };
  }

  static async fromFile(path: string): Promise<BrowserTask> {
    return JSON.parse(await readFile(path, "utf8")) as BrowserTask;
  }

  private execute(sessionId: string, step: BrowserTaskStep, approved: boolean) {
    switch (step.action) {
      case "navigate":
        return this.manager.navigate(sessionId, step.url, approved);
      case "click":
        return this.manager.click(sessionId, step.selector, {
          kind: step.expect ?? "stays",
        });
      case "type":
        return this.manager.type(
          sessionId,
          step.selector,
          step.text,
          step.clear ?? true,
        );
      case "select":
        return this.manager.select(sessionId, step.selector, step.value);
      case "scroll":
        return this.manager.scroll(sessionId, step.deltaY ?? 600);
      case "wait":
        return this.manager.wait(sessionId, step);
      case "read":
        return this.manager.read(sessionId);
      case "extract":
        return this.manager.extract(
          sessionId,
          step.selector,
          step.attribute ?? null,
        );
      case "submit":
        return this.manager.submit(sessionId, step.selector, approved);
    }
  }
}

function isUnverified(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      "verified" in value &&
      (value as { verified?: boolean }).verified === false,
  );
}
