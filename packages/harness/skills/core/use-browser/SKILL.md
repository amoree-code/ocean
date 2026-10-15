---
name: use-browser
description: Open a supplied URL, understand the user's requested outcome from the live page, complete the browser task, and verify the result.
version: 1.0.0
category: core
---

# Use Browser

Use when the user gives a URL and asks the agent to complete, fill, test, submit, or otherwise operate the page.

For client-neutral browser access, prefer the shared Playwright MCP connection
described in `docs/browser-clients.md`. The skill defines the task and verification
contract; MCP supplies the browser tools. Ocean's `ocean browser` capability remains
the deterministic local backend for repeatable JSON task files.

Use Ocean's `ocean browser` capability through the terminal as the default browser backend. Do not switch to `claude-in-chrome`, an extension, or another browser connector unless the user explicitly asks for that backend. If Ocean cannot detect or open a browser, report the exact command result and stop; do not ask the user to install a different browser extension as the first workaround.

## Cost-aware execution

Keep browser work bounded and token-efficient. Use one `observe` and one targeted `read` before acting, prefer `extract` over rereading the whole page, and keep page text bounded. Do not run exploratory shell scripts or repeated reload/undo cycles when a deterministic browser operation is unavailable. Use at most one retry for a reversible step and no automatic retry for submit, upload, purchase, message, or other consequential actions. If the live state is ambiguous after the bounded attempt, stop and report the blocker instead of spending more tokens guessing.

## Workflow

1. Treat the URL as the starting location, not as permission to perform every possible action on the site.
2. Open or reconnect to an Ocean browser session with a persistent profile. Navigate to the URL.
3. Inspect the live page with `observe`, `read`, and targeted `extract`. Identify the page's current state, the user's intended outcome, required fields, available controls, and a concrete success signal.
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

## Ocean execution shape

Use the browser capability's session lifecycle and task runner:

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
