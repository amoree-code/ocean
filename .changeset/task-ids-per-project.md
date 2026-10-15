---
"ocean": minor
---

Task ids belong to their project. `project.json` gains `prefix` (new projects get one derived from their id, e.g. `ocean-language` → `OL`) and `nextTask`; new ids are `<prefix>-001`, numbered by `max(counter, scan)` under the projects lock, and the scan now reaches `archive/<ns>/<id>`, so archived ids are never reissued. Every project still on `T` shares one sequence. A reference resolves through its prefix to its project; a bare `T-…` looks in the current project, then the projects that hold it, then `legacyId`. Free text only treats `T-n` and registered prefixes as ids (never `UTF-8`, `SHA-256`, `GPT-5`). `ocean tasks renumber --project <id> --prefix <P> [--write]` (dry run by default) moves a project's tasks onto its prefix, keeping `legacyId`. `ocean_task_get` takes optional `project` and `cwd`.
