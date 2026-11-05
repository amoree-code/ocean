---
"ocean": minor
---

The first session opened in a git repo that no project claims registers it as a project: `04-projects/<slug>/` with `project.json` (`autoRegistered: true`), `tasks/` and `MEMORY.md`, and the session bootstrap reports `project=<slug>`. This only happens under a code root (`OCEAN_CODE_ROOTS`, default `~/Documents`), never inside the Ocean workspace or the temp dir, never for a code root itself, and never over an existing project folder. Sibling repos are not merged. `OCEAN_AUTO_REGISTER=0` turns it off. New commands: `ocean project register [path]`, `ocean project unbind <path>` (keeps the folder), and `ocean project rename <id> <new-id>` (refused while the project has tasks).
