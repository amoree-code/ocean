---
"ocean": minor
---

Projects are recorded in `04-projects/<id>/project.json` (`id`, `name`, `paths[]` stored `~`-relative, `created`, `autoRegistered`), the single source of truth for project resolution. One project can own several repos (`ocean project bind <id> <path> --add`), and the longest matching path wins. The old `project-bindings.json` is still read for paths no manifest claims, and is rewritten as a cache after every change. `ocean project migrate [--write]` folds legacy bindings into existing project folders and reports the rest; `ocean project index [--write]` keeps a generated project list in a managed block of `04-projects/registry.md`. Project ids must be one plain path segment.
