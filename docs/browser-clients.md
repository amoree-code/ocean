# Universal browser client setup

Ocean owns the browser workflow and task format. AI clients connect to the same
browser through a standard MCP server; client-specific setup only changes where
the MCP entry is stored.

## The owner's current Chrome: the browser bridge

```text
AI client -> http://127.0.0.1:18931/mcp -> ocean mcp browser-bridge -> chrome-devtools-mcp -> running Chrome
```

One long-lived local service gives every MCP client the Chrome you already use, with its open
tabs and signed-in sessions. There is no extension and no separate profile.

**This is full access.** A connected client can read and operate every page Chrome exposes,
including signed-in sites. Page content is untrusted data, and the access does not authorize a
specific action: sending, purchasing, deleting and account or security changes still need your
explicit approval.

Setup, once, outside any client sandbox:

1. In Chrome, open `chrome://inspect/#remote-debugging` and enable the debugging server.
2. Run `ocean mcp browser-service install`, which starts the bridge at login (macOS). Elsewhere,
   run `ocean mcp browser-bridge` under your own service manager.
3. Add the entry from `ocean mcp browser-config` to each client.
4. Accept Chrome's prompt when a client first connects.

`ocean doctor` reports `BROWSER_BRIDGE`. A sandboxed shell that blocks loopback sees it as
unreachable even when it is running.

**Access boundary.** The service binds to loopback only. It refuses non-loopback `Host` values,
any request with an `Origin` header, and non-JSON bodies, so a web page cannot reach it. It has no
token: **any local process running as you can control the browser.** To cut access immediately,
run `ocean mcp browser-service uninstall`, or turn the debugging server off in Chrome.

**Recovery.** launchd restarts the bridge. If the upstream process dies, the call in flight fails
and is not retried, because it may already have acted on a page; the next call starts a new one.

**Privacy.** Upstream CrUX lookups and usage statistics are off. Logs carry no page content.

**Downloads.** There is no download tool. A click on a download link downloads as usual, to
Chrome's own download folder.

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
      "args": ["@playwright/mcp@latest", "--extension"]
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
