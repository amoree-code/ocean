# Browser capability

Ocean exposes a provider-neutral browser capability through the `ocean browser` CLI.
The implementation uses `playwright-core` with an already-installed Chromium-family
browser. Ocean never downloads a browser binary during install or build.

## Lifecycle

```text
ocean browser detect
ocean browser open --profile default
ocean browser show <session-id>
ocean browser events <session-id>
ocean browser close <session-id>
```

`open` launches a headless browser on loopback CDP, persists the browser metadata in
the private `bridge/sessions/sessions.sqlite`, and returns an Ocean session id. Every
later operation reconnects to that session. Browser profiles and downloads stay under
the private workspace `system/browser/` directory.

## Operations

```text
ocean browser navigate <session-id> <url> [--approve]
ocean browser read <session-id>
ocean browser observe <session-id>
ocean browser extract <session-id> <selector> [--attribute <name>]
ocean browser click <session-id> <selector> --expect navigates|stays|count:<selector>:<number>
ocean browser type <session-id> <selector> <text> [--no-clear]
ocean browser select <session-id> <selector> <value>
ocean browser scroll <session-id> [delta-y]
ocean browser wait <session-id> [--selector <selector>] [--url-contains <text>]
ocean browser upload <session-id> <selector> <path>... --approve
ocean browser download <session-id> <selector> [--destination <directory>] --approve
ocean browser submit <session-id> <selector> --approve
ocean browser run <session-id> <task-file> [--approve]
```

Cross-origin navigation and upload/download/submit require explicit `--approve`.
Every operation returns JSON and records only bounded operation metadata in the
session event log; page content, cookies, tokens, and credentials are not persisted.

`type` supports normal form controls, `contenteditable` elements, and editor containers
that expose a nested `textarea` (the pattern used by CodeMirror/Monaco). It focuses the
live editor, replaces its contents with keyboard input, then re-reads the live value.

Task files are JSON with an ordered `steps` array and optional `retries` (capped at 3):

```json
{
  "retries": 1,
  "steps": [
    { "action": "navigate", "url": "https://www.freecodecamp.org/learn/" },
    { "action": "type", "selector": ".monaco-editor", "text": "const answer = 42;" },
    { "action": "click", "selector": "button[type=submit]", "expect": "stays" },
    { "action": "submit", "selector": "button[type=submit]" }
  ]
}
```

The runner stops on the first failed verification. Submit and cross-origin navigation
still require `--approve`.

## Browser availability

Use `OCEAN_BROWSER_EXECUTABLE` to select a Chromium-family executable when the
automatic paths are insufficient. The default unit suite uses the fake provider:

```text
pnpm test
```

Run the real Playwright integration check explicitly when a local browser is
available:

```text
OCEAN_BROWSER_INTEGRATION=1 pnpm test
```

The integration test is opt-in and does not run in CI by default.

## Safety and rollback

The browser provider is isolated under `src/infrastructure/providers/`; domain and
application code use only JSON-safe browser types. Downloads sanitize remote filenames
and stay inside their destination directory. Removing the browser CLI, provider files,
tests, and `playwright-core` dependency is the rollback boundary; private runtime data
can be left untouched or removed separately by an explicit owner decision.
