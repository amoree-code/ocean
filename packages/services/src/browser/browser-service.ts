// Enforces the browser capability's authority/approval policy and drives live
// verification. This is where operation gating lives — providers only execute what
// they are asked and report what happened; they never decide whether an action was
// approved or verified.

import {
  type BrowserOperation,
  browserContracts,
} from "@ocean/core/domain/capabilities/browser-contract.js";
import type {
  BrowserHandle,
  BrowserLaunch,
  BrowserProvider,
} from "@ocean/core/domain/ports/browser-port.js";

export class BrowserApprovalRequiredError extends Error {
  constructor(operation: BrowserOperation, reason: string) {
    super(
      `Browser operation '${operation}' requires owner approval: ${reason}`,
    );
  }
}

export type BrowserOperationResult<T> = {
  operation: BrowserOperation;
  approved: boolean;
  verified: boolean;
  result: T;
};

// A click has no single universal post-condition — it may navigate, may leave the page
// in place, or may only change one element's state (e.g. a toggle). The caller states
// what it expects so verification can re-read live state and check that expectation,
// rather than reporting a meaningless constant.
export type ClickExpectation =
  | { kind: "navigates" }
  | { kind: "stays" }
  | { kind: "selector-count"; selector: string; expected: number };

function isExternalOrigin(currentUrl: string, targetUrl: string): boolean {
  if (currentUrl === "about:blank") return false;
  try {
    return new URL(currentUrl).origin !== new URL(targetUrl).origin;
  } catch {
    return true;
  }
}

export class BrowserService {
  constructor(private readonly provider: BrowserProvider) {}

  detect() {
    return this.provider.detect();
  }
  launch(profileDir: string, port?: number) {
    return this.provider.launch(profileDir, port);
  }
  connect(launch: BrowserLaunch) {
    return this.provider.connect(launch);
  }
  close(launch: BrowserLaunch) {
    return this.provider.close(launch);
  }

  private requireApproval(
    operation: BrowserOperation,
    approved: boolean,
    reason: string,
  ): void {
    const contract = browserContracts[operation];
    if (contract.approval === "required" && !approved)
      throw new BrowserApprovalRequiredError(operation, reason);
  }

  async navigate(
    handle: BrowserHandle,
    url: string,
    options: { approved?: boolean; timeoutMs?: number } = {},
  ): Promise<
    BrowserOperationResult<Awaited<ReturnType<BrowserHandle["navigate"]>>>
  > {
    const before = await handle.state();
    const crossOrigin = isExternalOrigin(before.url, url);
    if (crossOrigin && !options.approved)
      throw new BrowserApprovalRequiredError(
        "navigate",
        `destination origin differs from current origin (${before.url} -> ${url})`,
      );
    const result = await handle.navigate(url, options.timeoutMs);
    const verified = result.url === url || result.url.startsWith(url);
    return {
      operation: "navigate",
      approved: crossOrigin ? Boolean(options.approved) : true,
      verified,
      result,
    };
  }

  async upload(
    handle: BrowserHandle,
    selector: string,
    paths: string[],
    options: { approved?: boolean } = {},
  ): Promise<
    BrowserOperationResult<Awaited<ReturnType<BrowserHandle["upload"]>>>
  > {
    this.requireApproval(
      "upload",
      Boolean(options.approved),
      "attaching local files to a page is irreversible from Ocean's point of view",
    );
    const result = await handle.upload(selector, paths);
    return {
      operation: "upload",
      approved: true,
      verified: result.attached.length === paths.length,
      result,
    };
  }

  async download(
    handle: BrowserHandle,
    selector: string,
    destinationDir: string,
    options: { approved?: boolean; timeoutMs?: number } = {},
  ): Promise<
    BrowserOperationResult<Awaited<ReturnType<BrowserHandle["download"]>>>
  > {
    this.requireApproval(
      "download",
      Boolean(options.approved),
      "saving a file to disk is irreversible from Ocean's point of view",
    );
    const result = await handle.download(
      selector,
      destinationDir,
      options.timeoutMs,
    );
    return {
      operation: "download",
      approved: true,
      verified: result.size > 0,
      result,
    };
  }

  async submit(
    handle: BrowserHandle,
    selector: string,
    options: { approved?: boolean; timeoutMs?: number } = {},
  ): Promise<
    BrowserOperationResult<Awaited<ReturnType<BrowserHandle["submit"]>>>
  > {
    this.requireApproval(
      "submit",
      Boolean(options.approved),
      "submitting a form is irreversible from Ocean's point of view",
    );
    const result = await handle.submit(selector, options.timeoutMs);
    const verified =
      result.url !== result.urlBefore || result.bodyAfter !== result.bodyBefore;
    return { operation: "submit", approved: true, verified, result };
  }

  async click(
    handle: BrowserHandle,
    selector: string,
    expectation: ClickExpectation,
    timeoutMs?: number,
  ): Promise<
    BrowserOperationResult<Awaited<ReturnType<BrowserHandle["click"]>>>
  > {
    const result = await handle.click(selector, timeoutMs);
    let verified: boolean;
    if (expectation.kind === "navigates")
      verified = result.url !== result.urlBefore;
    else if (expectation.kind === "stays")
      verified = result.url === result.urlBefore;
    else
      verified =
        (await handle.extract(expectation.selector, null)).count ===
        expectation.expected;
    return { operation: "click", approved: true, verified, result };
  }

  async type(
    handle: BrowserHandle,
    selector: string,
    text: string,
    clear?: boolean,
  ): Promise<
    BrowserOperationResult<Awaited<ReturnType<BrowserHandle["type"]>>>
  > {
    const result = await handle.type(selector, text, clear);
    return {
      operation: "type",
      approved: true,
      verified: result.value.includes(text) || !clear,
      result,
    };
  }

  async select(
    handle: BrowserHandle,
    selector: string,
    value: string,
  ): Promise<
    BrowserOperationResult<Awaited<ReturnType<BrowserHandle["select"]>>>
  > {
    const result = await handle.select(selector, value);
    return {
      operation: "select",
      approved: true,
      verified: result.value === value,
      result,
    };
  }

  async replaceText(
    handle: BrowserHandle,
    selector: string,
    oldText: string,
    newText: string,
    occurrence = 1,
  ): Promise<
    BrowserOperationResult<Awaited<ReturnType<BrowserHandle["replaceText"]>>>
  > {
    const result = await handle.replaceText(
      selector,
      oldText,
      newText,
      occurrence,
    );
    return {
      operation: "replace-text",
      approved: true,
      verified: result.value.includes(newText),
      result,
    };
  }
}
