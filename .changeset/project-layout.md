---
"ocean": minor
---

Every project folder gets a standard layout: auto-register (and `ocean project register`) now creates `memory/` (lessons and decisions, indexed by `MEMORY.md`) and `docs/` (reference material, indexed by `docs/README.md`) next to `tasks/`, and the seeded `MEMORY.md` states where each kind of file goes, so sessions stop writing reference files at the project root. `ocean doctor` warns on project-root entries outside `project.json`, `MEMORY.md`, `README.md`, `index.md`, `tasks/`, `memory/`, `docs/` (`PROJECT_LAYOUT_STRAY`) and on missing standard folders (`PROJECT_LAYOUT_MISSING`); `ocean repair` creates the missing ones and never moves a file.
