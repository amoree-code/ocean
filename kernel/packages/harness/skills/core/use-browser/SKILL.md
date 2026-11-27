---
name: use-browser
description: Open a supplied URL, understand the user's requested outcome from the live page, complete the browser task, and verify the result.
version: 1.2.0
category: core
---

# Use Browser

Use when the user gives a URL and asks the agent to complete, fill, test, submit, or otherwise operate the page.

The skill defines the task and verification contract. Pick the backend in this order:

1. **The `dev.ocean/chrome-devtools` MCP tools** (`list_pages`, `navigate_page`, `take_snapshot`,
   `click`, `fill`, …), when the client has them: they drive the owner's own signed-in browser
   (`ocean browser use` picks which one), and the owner sees a pointer and a blue "Ocean" frame
   on the tab being driven. Routes and setup: `docs/browser-clients.md`.
2. **`dev.ocean/firefox-devtools`**, only when the user asks for Firefox.
3. **The `ocean browser` terminal capability** for repeatable JSON task files, or when the client
   has no browser MCP tools.

Do not switch to `claude-in-chrome`, an extension, or another browser connector unless the user explicitly asks for that backend. If the browser cannot be reached, report the exact error and stop (the usual cause: the browser is closed or its inspect page's remote debugging is off, and `ocean doctor` says which); do not ask the user to install a different browser extension as the first workaround.

## Browser playbook (MCP tools)

The failures that cost the most turns are the same few; each rule below prevents one.

1. **Load the schemas first.** When the client defers tool schemas, load every browser tool you
   expect to use in one call before the first one. A call to an unloaded tool fails.
2. **Tools missing?** They are listed only in a profile that uses the browser (`frontend`,
   `qa-testing`). Call `gateway__use_profile` with one of those; if the tools still do not
   appear, this client does not reload its tool list: say so and suggest a new session.
3. **Pages first, after any reconnect.** `list_pages`, then `select_page` (or `new_page`), before
   anything else, and again whenever a reply says "No page found", "Page ids have changed" or
   "Target closed". Page ids do not survive the browser or the gateway restarting.
4. **Snapshot after every navigation.** `take_snapshot` after `navigate_page`, a click that
   loads a page, or a submit, and before the next `click` or `fill`. A `uid` belongs to one
   snapshot of one page: "uid not found" means the snapshot is stale, not that the element is gone.
5. **Act on snapshot `uid`s.** Later snapshots on the same page carry only the changed lines, and
   unchanged `uid`s still work; call `take_snapshot` for the whole tree again. A very large page
   is cut to its interactive elements and headings, with the whole tree in the file the note names.
6. **Snapshots, not screenshots.** A screenshot costs far more context and gives no `uid`s. Take
   one only when the answer is visual (layout, RTL/Arabic rendering, charts, proof of a result),
   and always with `filePath` so the image goes to disk, not into the reply.
7. **Wait on exact text, briefly.** `wait_for` the exact text the next state shows, with a short
   timeout (5–10 s). A long wait on vague text hides a failure behind a timeout.
8. **One retry, then stop.** A reversible step gets at most one retry after a fresh snapshot;
   a consequential one (submit, upload, purchase, message) gets none.

`list_pages` shows every tab; other replies show only the selected tab. The browser asks the
owner once to allow the connection; it is shared by every session. `ocean browser stop` ends it.
Errors from the gateway end with a one-line hint naming the next call: follow it.

## Cost-aware execution

Keep browser work bounded and token-efficient. With the terminal capability, use one `observe` and one targeted `read` before acting, prefer `extract` over rereading the whole page, and keep page text bounded. Do not run exploratory shell scripts or repeated reload/undo cycles when a deterministic browser operation is unavailable. Use at most one retry for a reversible step and no automatic retry for submit, upload, purchase, message, or other consequential actions. If the live state is ambiguous after the bounded attempt, stop and report the blocker instead of spending more tokens guessing.

## Workflow

1. Treat the URL as the starting location, not as permission to perform every possible action on the site.
2. With the MCP tools, `list_pages`, then `select_page` an existing tab or `new_page` for the URL; with the terminal, open or reconnect to an Ocean browser session with a persistent profile and navigate to the URL.
3. Inspect the live page (`take_snapshot`; in the terminal, `observe`, `read`, and targeted `extract`). Identify the page's current state, the user's intended outcome, required fields, available controls, and a concrete success signal.
4. Build the smallest step sequence that reaches the requested outcome. Prefer stable labels, roles, names, ids, and visible text. Use editor selectors for `contenteditable`, CodeMirror/Monaco containers, and `frame >>> editor` for same-origin iframe editors.
5. For code-editor changes, use `ocean browser replace-text <session-id> <selector> <old-text> <new-text> --occurrence <n>` when replacing a specific token. Never simulate a precise replacement by clicking and typing into the middle of a Monaco/CodeMirror line. Verify the returned editor value and then re-read the page.
6. Execute through Ocean browser operations or a bounded browser task file. Keep the task file small, cap retries at 0–1, and cap total steps to the minimum needed. After every state-changing step, verify the live post-condition. Stop if the page state contradicts the plan.
7. For forms, tests, purchases, uploads, messages, or other externally visible mutations, keep the existing Ocean approval gate. Ask for confirmation only at the final consequential action when approval is not already present.
8. If a field is ambiguous, required data is missing, authentication is needed, or the page reports failure, stop with the exact blocker. Do not invent personal, financial, legal, academic, or credential data.
9. Report the outcome, the verified success signal, and any unverified or blocked step. Close the browser session only if the user requested cleanup; otherwise preserve it for continuation.

## Client-neutral task prompt

Normalize browser requests to:

```text
url: <starting URL>
task: <human-readable outcome>
continue: true
verify: <observable success signal>
```

Use one bounded loop, verify every state-changing action, and stop when the
success signal is present or a required human decision is reached.

## Ocean terminal execution shape

When using the terminal capability, use its session lifecycle and task runner:

```text
ocean browser detect
ocean browser open --profile <profile>
ocean browser approve <session-id>
ocean browser navigate <session-id> <URL> --approve
ocean browser observe <session-id>
ocean browser read <session-id>
ocean browser replace-text <session-id> <selector> <old-text> <new-text> --occurrence <n>
ocean browser run <session-id> <task-file> --approve
```

Use direct operations for discovery and a bounded JSON task for repeatable execution. Keep task files small, set `retries` to 0–2, and never use retries to repeat an irreversible action blindly. The runner caps retries at three and stops on failed verification.

## Completion contract

A task is complete only when the requested outcome is visible in live page state: a success message, changed status, expected navigation, submitted result, or another explicit post-condition. A click or lack of error is not proof by itself.
