# Ocean operating model

Ocean is the canonical local source of truth for project, task, memory, knowledge,
decision, session, and evidence state. Provider clients are entry points and execution
hands; they are not alternate storage owners.

## Ownership

The Ocean root owns the durable state under `personal/`, `projects/`, and `system/`.
The public `engine/` package contains code, tests, and templates only. Private records
must never be written into the engine package or provider-owned memory files. The
unrelated `second-brain` workspace is outside this boundary and is never read, written,
or integrated.

Provider authentication remains provider-owned. Ocean does not broker credentials,
copy them into prompts, persist them in sessions, or write them to logs. Provider
commands receive only the credentials already managed by their installed client.

## Request flow

```text
arbitrary project cwd
  -> provider entry (native hook, shim, or supported adapter)
  -> deterministic intent classification
  -> project and session resolution
  -> confidence and approval checks
  -> metadata-first candidate selection
  -> bounded context packet
  -> exact record read or approval-gated write
  -> independent result and evidence
```

Startup sends identity only. Retrieval happens on demand through the local operation
layer. The operation layer enforces record type, project scope, field allow-lists,
result limits, byte limits, path safety, freshness, and provenance.

## Ambiguous binding

Project resolution returns `bound`, `unbound`, or `ambiguous` with confidence. An
unbound or ambiguous result produces one focused confirmation question. Ocean never
scans broadly or chooses the first matching project. A missing path, git root, project
name, or binding remains unresolved until the user supplies the missing target.

## Provenance

Every returned record carries its source path, record type, freshness, confidence, and
selection reason. The optional declared provenance is normalized to one of:
`fact`, `preference`, `decision`, `lesson`, `proposal`, `temporary-note`, `task`,
`project`, `execution`, or `unknown`.

Corrections are additive evidence. A correction writes a new record with an explicit
`correction_of` reference; it does not silently rewrite or erase historical records.

## CLI and MCP

Simple deterministic reads use the local CLI/application operation path and do not
require an MCP round trip. `ocean operate <request>` classifies the request and executes
only the mapped bounded operation. Writes remain refused unless the caller supplies the
existing explicit approval contract.

MCP is optional. It is an adapter and discovery surface, not the storage layer, source
of truth, or approval authority. A client bypassing the registered hook, shim, or
adapter may operate outside Ocean; Ocean reports the boundary when it can detect it and
does not claim universal enforcement.

## Verification status

Claude, Codex, and Gemini have verified headless invocation paths on the development
machine. Claude has a registered Ocean `SessionStart` hook; direct hook execution and
configuration registration are proven, while invocation and application by a newly
opened live Claude session require a fresh-session check. Providers without a verified
headless contract remain explicitly unsupported or wrapper-only; executable discovery
alone is not compatibility evidence.
