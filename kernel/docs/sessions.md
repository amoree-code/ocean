# Sessions

Every `ocean run` or `ocean session resume` creates or continues a session record: what
was run, for which profile, its provider-side session id, its status, and its event log.
Sessions are persisted in SQLite so they survive process restarts and can be listed,
inspected, or resumed later.

## Storage

`SessionStore` (`packages/loop/src/infrastructure/persistence/session-store.ts`) opens
`<workspace>/bridge/sessions/sessions.sqlite` (via `oceanPath(SYSTEM_DIR, "sessions", "sessions.sqlite")`,
see [workspace.md](workspace.md)) with `node:sqlite`, in WAL mode, and creates three tables
if absent:

- `sessions` — one row per session: id, provider, provider-side session id, parent session
  id, profile name, profile identity (see [profiles.md](profiles.md#session-reproducibility-profileidentity)),
  working directory, status, timestamps, and opaque `resume_data`.
- `session_events` — an append-only log per session (`type`, `data`, `created_at`),
  auto-incrementing `event_id`.
- `session_links` — parent/child session id pairs, for sessions created by `resumeAgent`
  or with an explicit `parentSessionId`.

- `handoffs` — compact provider-neutral task continuity records linked to tasks and sessions.
- `ideas` — explicit raw idea records; ordinary conversation is not written here.
- `capture_items` — reviewable references to explicit `user_input` events. Use `ocean capture` to list,
  promote, or discard candidates; provider completion does not sync them into the inbox view.

A closed session is scored into the lessons store (`<workspace>/05-knowledge/lessons/`, one markdown
record per lesson) when it completed, exited 0 and every evidence event it recorded is proven. A
verified session confirms the lessons it used, turns repeated work into candidate lessons, and a
user correction in a session that used a lesson contradicts it (logged to `lessons/CONFLICTS.md`).
Confidence halves every 30 days without confirmation. A candidate becomes active only with three
verified hits and a passing replay eval; nothing is written to `charter/` automatically. The outcome
is recorded as a `lesson_scored` event. Runs pick active lessons through the brain index, so run
`ocean memory reindex` after a lesson changes. Review with:

```bash
ocean skill list [candidate|active|retired]
ocean skill observe <session-id>
ocean skill review <lesson-id> promoted|rejected
ocean skill migrate    # fold the legacy skills/observations.json and candidates.json into lessons
```

`openSessionStore()` ensures the `bridge/sessions/` directory exists and returns a `SessionStore`;
callers must `close()` it when done.

## Session schema (`src/domain/sessions/session.ts`)

```ts
{
  sessionId: string,
  title: string,
  taskId: string | null,
  handoffId: string | null,
  provider: string,
  providerSessionId: string | null,
  parentSessionId: string | null,
  profile: string,
  profileIdentity: string,             // default "" for sessions created before this field existed
  workingDirectory: string,
  status: "created" | "running" | "completed" | "failed" | "cancelled",
  createdAt: string,
  updatedAt: string,
  resumeData: string | null,
  contextHash: string | null,
  contextBytes: number,
  nextAction: string,
  verificationStatus: "unknown" | "proven" | "not_proven" | "blocked",
}
```

Rows are validated with Zod (`validateSession`) on both write and read.

## Status lifecycle

```
created → running → completed → running → ...
                   → failed    → running → ...
                   → cancelled  (terminal)
```

`assertValidStatusTransition` enforces this: `completed` and `failed` describe the outcome
of the most recent run, not whether the session can run again, so both can transition back
to `running` on resume. `cancelled` has no outgoing transitions.

## CLI usage

```bash
node dist/main.js session list
node dist/main.js session show <session-id>
node dist/main.js session summary <session-id>
node dist/main.js session events <session-id>
node dist/main.js session resume <session-id> "<prompt>"
```

- `list` prints all sessions as JSON, newest first.
- `show <id>` prints one session or exits 1 if not found.
- `show <id>` includes the validated `entryContract`; `events <id>` prints the ordered evidence log.
- `summary <id>` prints the bounded human-readable Markdown closeout written under
  `<workspace>/bridge/sessions/summaries/`. The session row stores its relative summary path,
  SHA-256, byte count, closeout status, version, and close timestamp.
- `resume <id> "<prompt>"` currently only supports sessions whose `provider` is `claude`
  and that already have a `providerSessionId`; it re-invokes the provider with
  `--resume <providerSessionId>` (see [providers.md](providers.md)) and appends a
  `resume_requested` event before running.

## Events

Every provider event and lifecycle transition is appended to `session_events` via
`appendEvent`, including `context_manifest` (the referenced context, paths + why, see [context.md](context.md)),
each provider stdout event (bounded to 64,000 characters), `process_exit`, and `error` on
failure. `listEvents(sessionId)` returns the full ordered log for a session.

Every governed session also records a `session_entry_contract` event. It declares
the entry point (`ocean-run`, `terminal-shim`, `interactive-managed`, or
`desktop-wrapper`), control level, input-capture boundary, context transport,
policy enforcement, promotion rule, and resume capability. The shim bootstrap manifest is
recorded as an `ocean_bootstrap` event. The contract prevents
a successful command resolution from being misreported as full Ocean governance.

Successful and unsuccessful provider exits also append a bounded `evidence` event. Evidence
records include a source, timestamp, result (`proven`, `not_proven`, or `limitation`), an
optional acceptance criterion, and bounded payload. Provider output is evidence input; it is
not a verified fact until a check records the corresponding result.

Every governed closeout runs one idempotent finalizer. It writes one concise Markdown summary,
updates structured session metadata in `bridge/sessions/sessions.sqlite`, and creates a bounded
handoff draft when the session has enough task evidence. It never promotes the session to memory,
knowledge, inbox, daily, or skills automatically, and it never copies the complete provider
transcript into the summary or database.

Runtime diagnostics are written as bounded JSON Lines at the private workspace path
`logs/runtime.jsonl`. Records contain correlation/session ids and lifecycle status only;
secrets, private home paths, prompts, and provider documents are redacted or excluded.

## Cross-client handoff

```bash
ocean handoff create --task T-193 --session <session-id> --next "Run verification"
ocean handoff context <handoff-id>
ocean handoff list --task T-193
ocean run --profile reviewer --client codex --task T-193 --handoff <handoff-id> --prompt "Continue"
ocean client open hermes --task T-193 --handoff <handoff-id>
```

The handoff contains compact task metadata, decisions, changed files, verification, limitations,
permissions, context manifest, profile identity, and one next action. It never copies the source
provider transcript or credentials. MCP exposes the same bounded retrieval path.

`ocean idea save` is the explicit raw-idea path; it does not create an inbox file. `ocean daily
start` previews one dated brief and `--apply` writes it only when that day's file is empty.
