import { isValidProjectId } from "../context/project-id.js";

// Record scope (T-256 phase 4): which project a memory/knowledge record belongs to. One pure
// function decides, so the index, the ladder, search and the CLI cannot disagree.
// Missing scope is global (new writes carry none); anything unrecognised is "invalid" —
// hidden from every scoped search and reported by reindex, never guessed into a project.

export type RecordScope = "global" | `project:${string}` | "invalid";
export type ScopeState = "declared" | "defaulted" | "invalid";

export function normalizeScope(raw?: string | null): {
  scope: RecordScope;
  state: ScopeState;
} {
  const value = (raw ?? "").trim();
  if (value === "") return { scope: "global", state: "defaulted" };
  if (value === "global") return { scope: "global", state: "declared" };
  if (value.startsWith("project:")) {
    const id = value.slice("project:".length);
    if (isValidProjectId(id))
      return { scope: `project:${id}`, state: "declared" };
  }
  return { scope: "invalid", state: "invalid" };
}

// Bound to P → global + project:P; unbound or ambiguous (null) → global only.
export function visibleScopes(project: string | null): string[] {
  return project ? ["global", `project:${project}`] : ["global"];
}

export function scopeVisible(scope: string, project: string | null): boolean {
  return visibleScopes(project).includes(scope);
}
