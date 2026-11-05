# Migration

Ocean provides an explicit, local migration command. Preview the operation with
`ocean migrate`, then apply the idempotent session database migrations with
`ocean migrate --apply`. The command reports SQLite integrity after applying changes.

## SQLite schema

`SessionStore` (`packages/loop/src/infrastructure/persistence/session-store.ts`) creates missing tables
and applies additive column migrations. `ocean migrate --apply` is the explicit upgrade
boundary. Back up `<workspace>/bridge/sessions/sessions.sqlite` before upgrading if you
want a rollback point (see [sessions.md](sessions.md)).

## Profiles

Profile files are plain JSON validated against `profileSchema` (see [profiles.md](profiles.md)).
New optional fields receive schema defaults. A future breaking profile change must ship an
explicit profile migration before the required field is enforced.

## Moving a workspace

Since the workspace root is a private directory (`~/ocean`) whose `kernel/` this repository
is (see [workspace.md](workspace.md)), moving it is a plain filesystem operation: copy the
workspace root (or `bridge/`, `charter/` and the record areas individually) to the new location,
then point `OCEAN_ROOT` at it (or place `kernel/` as its sibling again for the default
resolution). Re-run the platform startup installer (`ocean setup`) if the workspace path
changed, so the OS-level startup entry points at the correct working directory.
