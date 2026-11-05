// The browser provider boundary. Everything above this file is Ocean: capability,
// authority, verification, session identity. A provider is the only place a browser
// engine may be named — see infrastructure/providers/playwright-browser-provider.ts.
// Every call here returns a plain, JSON-safe value; a provider never decides whether
// an action was verified, it only reports what it observed. Verification re-reads
// state separately. These are pure interfaces, so they live in the domain layer.

export type BrowserLaunch = {
  pid: number;
  port: number;
  endpoint: string;
  profileDir: string;
};
export type BrowserPageState = { url: string; title: string };
export type BrowserElement = {
  tag: string;
  type: string | null;
  name: string | null;
  id: string | null;
  text: string;
  visible: boolean;
};

export interface BrowserHandle {
  state(): Promise<BrowserPageState>;
  navigate(url: string, timeoutMs?: number): Promise<BrowserPageState>;
  readText(): Promise<BrowserPageState & { text: string }>;
  observe(): Promise<BrowserPageState & { elements: BrowserElement[] }>;
  extract(
    selector: string,
    attribute: string | null,
  ): Promise<{ selector: string; count: number; values: Array<string | null> }>;
  click(
    selector: string,
    timeoutMs?: number,
  ): Promise<BrowserPageState & { urlBefore: string }>;
  type(
    selector: string,
    text: string,
    clear?: boolean,
  ): Promise<{ selector: string; typed: number; value: string }>;
  replaceText(
    selector: string,
    oldText: string,
    newText: string,
    occurrence?: number,
  ): Promise<{
    selector: string;
    oldText: string;
    newText: string;
    occurrence: number;
    value: string;
  }>;
  select(
    selector: string,
    value: string,
  ): Promise<{ selector: string; value: string }>;
  scroll(deltaY?: number): Promise<{ scrollY: number }>;
  wait(options: {
    selector?: string;
    urlContains?: string;
    timeoutMs?: number;
  }): Promise<BrowserPageState>;
  upload(
    selector: string,
    paths: string[],
  ): Promise<{ selector: string; attached: string[] }>;
  download(
    selector: string,
    destinationDir: string,
    timeoutMs?: number,
  ): Promise<{ selector: string; path: string; size: number }>;
  submit(
    selector: string,
    timeoutMs?: number,
  ): Promise<
    BrowserPageState & {
      urlBefore: string;
      bodyBefore: string;
      bodyAfter: string;
    }
  >;
  release(): Promise<void>;
}

export interface BrowserProvider {
  detect(): Promise<{ ok: boolean; detail: string }>;
  launch(profileDir: string, port?: number): Promise<BrowserLaunch>;
  connect(launch: BrowserLaunch): Promise<BrowserHandle>;
  close(launch: BrowserLaunch): Promise<void>;
}
