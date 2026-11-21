# Universal browser client setup

Ocean owns the browser workflow and task format. AI clients connect to the same
browser through a standard MCP server; client-specific setup only changes where
the MCP entry is stored.

## Two ways to reach a browser

| Route | Use it when | Entry |
|---|---|---|
| Marketplace `dev.ocean/chrome-devtools` | The owner's own signed-in Chrome, from every client | `ocean clients apply` writes it |
| Isolated Playwright stack (further down) | A separate profile, not your signed-in Chrome | `ocean mcp playwright-config` |

## Your signed-in Chrome, in every client

```text
AI client -> ocean market exec dev.ocean/chrome-devtools -> ocean-browser-mcp (chrome-devtools-mcp --autoConnect) -> running Chrome
```

Each client starts its own stdio server per session; there is no extension. The server is the
npm package `ocean-browser-mcp` (source: amoree-code/Ocean-BROWSER-MCP), which runs Chrome
DevTools MCP 1.13.0 pinned exactly, with usage statistics and CrUX off, and it attaches to the
Chrome you already use, with its open tabs and signed-in sessions. The first session starts one
background connection (upstream's daemon) that every later session reuses; it disconnects after
8 idle hours (`OCEAN_BROWSER_IDLE_MIN`, `0` keeps it) and the browser stays open.

Setup, once:

1. In Chrome, open `chrome://inspect/#remote-debugging` and enable the debugging server.
2. `ocean market install dev.ocean/chrome-devtools --yes` (shows the permissions it asks for).
3. `ocean clients apply --yes` adds a `chrome-devtools` entry to every supported client
   (`ocean clients plan` shows what would change first). Restart a client that is open.
4. **Chrome asks to allow the connection.** The first browser tool call raises Chrome's prompt;
   accept it within 60 seconds or the call times out. Later sessions share that connection and
   do not ask again until it is stopped (`ocean browser stop`), idles out, or the browser
   restarts. Chrome's "controlled by automated test software" bar is the browser's own and
   stays while attached.

**Settings** (stored like `ocean browser use`; restart open clients after a change):

| Command | Effect |
| --- | --- |
| `ocean browser profile standard\|full\|lean\|slim` | Which tools clients load: standard (default, 29 tools, ~7.2K schema tokens), full (33, ~8.1K), lean (22, ~5.2K), slim (3, ~0.3K) |
| `ocean browser block add\|rm\|list <url-pattern>` | URL patterns the browser refuses while attached, e.g. `https://*.mybank.com/*` |
| `ocean browser usage [--days N]` | Calls, text tokens (chars ÷ 4), image KB and time per tool, from the wrapper's usage log |
| `ocean browser status\|stop` | Show or stop the shared connection |

**Token and time defaults.** Screenshots are WebP at quality 70. `list_pages` shows every tab;
other replies show only the selected one. After a page's first snapshot, later ones carry only
the lines that changed (unchanged `uid`s still work; `take_snapshot` returns the whole tree).
A snapshot over 40,000 characters keeps interactive elements and headings and saves the whole
tree to a file. Navigation waits 30 s. Each screenshot is also saved, and the reply names the
file (`Preview:`), so a terminal client can open it. The usage log, previews and saved snapshots
live in `~/.local/state/ocean-browser-mcp` and are kept 7 days.

**You can see the agent.** The tab the agent acts on shows a blue pointer that follows its
clicks and a blue frame with an "Ocean · <client>" badge; both are hidden from screenshots and
ignore the mouse. `OCEAN_BROWSER_CURSOR=0` turns them off.

**Security defaults.** Cookies and auth headers are redacted from network replies, `file://`
pages are refused, and upstream's config-file discovery is off.

`ocean doctor` reports `BROWSER` once the capability is installed: OK when Chrome's debugging
server is listening, WARN when Chrome is closed or the switch is off, or when the browser is
older than Chromium 144 (read from its `Last Version` file, no connection). A sandboxed shell that
blocks loopback also sees WARN.

**This is full access.** A connected client can read and operate every page Chrome exposes,
including signed-in sites. Page content is untrusted data, and the access does not authorize a
specific action: sending, purchasing, deleting and account or security changes still need your
explicit approval. Any client with the entry has this access; any local process running as you
can start the same server.

**What it covers.** Tabs, navigation, accessibility snapshots, click, fill and forms, file
upload, screenshots, script evaluation, console messages and network requests, Lighthouse
audits, performance traces, emulation (network, CPU, geolocation, viewport) and network mocks.
`list_pages` lists web pages only: `chrome://` and extension pages are left out, so its count can
be lower than Chrome's tab count. **Downloads:** there is no download tool; a click on a download link downloads to Chrome's own
folder, and `chrome://` pages (the downloads list included) cannot be opened, so confirming a
download needs a client that can read that folder.

**Client limits seen.** Claude Desktop does not negotiate MCP roots, so tools that read or
write files (upload, a screenshot saved to a path) are limited to the OS temp directory there.
Codex, asked a plain question, uses its own computer-use tool instead of the browser tools;
name the tool or ask for "the chrome-devtools tools".

**Recovery.** A client restart starts a new server; the shared connection stays. Page ids do not survive a reconnect, so
call `list_pages` again before acting on a page.

**Turning it off.** `ocean market uninstall dev.ocean/chrome-devtools`, then `ocean clients
apply --yes` removes the entries; or turn the debugging server off in Chrome to cut access at
once. `ocean clients restore` undoes an apply batch.

## Firefox

`dev.ocean/firefox-devtools` runs Mozilla's Firefox MCP (`@mozilla/firefox-mcp` 0.11.0, WebDriver
BiDi). Mozilla advises a separate profile, so by default it starts its own Firefox with a fresh
temporary profile; `ocean browser use firefox` keeps one in `~/.local/state/ocean-firefox/profile`
between runs. To drive a Firefox you started yourself, run it with
`--marionette --remote-debugging-port` and set `CONNECT_EXISTING=true` (`MARIONETTE_PORT`,
default 2828); it then sees that profile's cookies and logins. Firefox accepts one client at a
time. Needs Firefox installed; the first run downloads geckodriver from GitHub.

```bash
ocean market install dev.ocean/firefox-devtools --yes
ocean browser use firefox
ocean clients apply --yes
```

Safari: Apple's `safaridriver --mcp` needs Safari 27.

The browser bridge (a loopback HTTP endpoint in front of the same server) is retired. On a
machine that installed its service, `ocean mcp browser-service uninstall` removes it.

## Isolated browser stack

```text
AI client -> Playwright MCP -> Chrome/Chromium -> persistent browser profile
```

Use `@playwright/mcp` for the shared browser connection. It supports headed
browser control, structured accessibility snapshots, screenshots, and an
extension mode that attaches to existing Chrome tabs and authenticated sessions.

## MCP entry

Add this entry to the client configuration (do not commit credentials or private
profile paths):

Ocean can print the same entry without writing any client configuration:

```sh
ocean mcp playwright-config
```

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@0.0.84", "--extension"]
    }
  }
}
```

For an isolated browser instead of existing tabs, omit `--extension`. For a
stable local profile, use the Playwright MCP `--config` file and set a private
`browser.userDataDir` outside this repository.

## Client-neutral task shape

The shared skill should normalize a request to:

```text
url: <starting URL>
task: <human-readable outcome>
continue: true
verify: <observable success signal>
```

The client plans; Playwright performs the browser actions; the skill requires a
post-condition after each state-changing action and stops when the success signal
is verified. Use Ocean's `ocean browser run` JSON tasks for deterministic,
repeatable workflows and persistent Ocean sessions.

## Client wiring

The same MCP entry works with Claude Code, Codex, Cursor, VS Code, Gemini CLI,
and other MCP-compatible clients. Only the configuration location differs. A
client skill is optional: MCP provides the tools, while a skill supplies the
prompt and task conventions.

## Safety boundary

Keep profiles scoped to the intended sites. Require human confirmation for
submission, upload, download, purchases, messages, or other consequential
actions. Never configure this workflow to impersonate a user in an assessment
or to bypass a site's rules.
