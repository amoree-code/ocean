---
"ocean": minor
"@ocean/brain": minor
---

One lessons store for what Ocean learns from the owner's work (T-230 P1): a markdown record per lesson under `05-knowledge/lessons/` (`type: experiential`, `status: candidate|active|retired`, `confidence`, `hits`, `evidence`). Confidence is stored with the time it was written and halves every 30 days on read, so an unconfirmed lesson fades without a rewrite. `confirmLesson` counts a verified use as a hit and restarts the clock; `contradictLesson` halves confidence, logs the disagreement to `CONFLICTS.md` and retires a lesson that falls below 0.1. `migrateLegacyLessons` folds `skills/observations.json` and `skills/candidates.json` into lessons and renames them `*.migrated`; `ocean observe` command logs are evidence, not lessons, and stay where they are. Nothing calls the store yet — scoring and promotion are P2, activation and the CLI are P3.
