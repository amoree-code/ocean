---
"@amoree-code/ocean": minor
---

feat(tasks): `ocean tasks sync [--all] [--dry-run]` moves a task's state from the GitHub PRs it links: an open PR → `in-qa`; every linked PR merged → `done` through the same completion gate as `ocean tasks complete` (or it stays `in-qa` with the reason). Session start runs it in the background for every project.
