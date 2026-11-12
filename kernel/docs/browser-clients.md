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
AI client -> ocean market exec dev.ocean/chrome-devtools -> chrome-devtools-mcp --autoConnect -> running Chrome
```

Each client starts its own stdio server per session; there is no background service and no
extension. The server is the pinned Chrome DevTools MCP with usage statistics and CrUX off, and
it attaches to the Chrome you already use, with its open tabs and signed-in sessions.

Setup, once:

1. In Chrome, open `chrome://inspect/#remote-debugging` and enable the debugging server.
2. `ocean market install dev.ocean/chrome-devtools --yes` (shows the permissions it asks for).
3. `ocean clients apply --yes` adds a `chrome-devtools` entry to every supported client
   (`ocean clients plan` shows what would change first). Restart a client that is open.
4. **Chrome asks to allow each new connection.** Every client session that first uses a browser
   tool raises Chrome's prompt; accept it within 60 seconds or the call times out. A tool that
   times out waiting for the browser is retried by the next call.

`ocean doctor` reports `BROWSER` once the capability is installed: OK when Chrome's debugging
server is listening, WARN when Chrome is closed or the switch is off. A sandboxed shell that
blocks loopback also sees WARN.

**This is full access.** A connected client can read and operate every page Chrome exposes,
including signed-in sites. Page content is untrusted data, and the access does not authorize a
specific action: sending, purchasing, deleting and account or security changes still need your
explicit approval. Any client with the entry has this access; any local process running as you
can start the same server.

**What it covers.** Tabs, navigation, accessibility snapshots, click, fill and forms, file
upload, screenshots, script evaluation, console messages and network requests (32 tools).
**Downloads:** there is no download tool; a click on a download link downloads to Chrome's own
folder, and `chrome://` pages (the downloads list included) cannot be opened, so confirming a
download needs a client that can read that folder.

**Client limits seen.** Claude Desktop does not negotiate MCP roots, so tools that read or
write files (upload, a screenshot saved to a path) are limited to the OS temp directory there.
Codex, asked a plain question, uses its own computer-use tool instead of the browser tools;
name the tool or ask for "the chrome-devtools tools".

**Recovery.** A client restart starts a new server. Page ids do not survive a reconnect, so
call `list_pages` again before acting on a page.

**Turning it off.** `ocean market uninstall dev.ocean/chrome-devtools`, then `ocean clients
apply --yes` removes the entries; or turn the debugging server off in Chrome to cut access at
once. `ocean clients restore` undoes an apply batch.

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
