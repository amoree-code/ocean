---
"ocean": minor
"@ocean/brain": minor
"@ocean/core": minor
"@ocean/loop": minor
"@ocean/market": minor
---

Runs and the CLI read lessons instead of the legacy skill stores (T-230 P3). `selectActiveLessons` asks the brain index for each distinctive word in the prompt and ranks a lesson by how many it answers, instead of matching the lesson's name as a substring; only `active` lessons above a decayed-confidence floor of 0.2 activate, and one that cannot be read is skipped. `runAgent` takes them through a new `loadActiveLessons` dependency and records `selectedLessons` beside `selectedSkills`. Lesson text is redacted before it reaches the prompt. `ocean skill list [status|id]`, `observe [session-id]`, `learn`, `add` and `review` now work on lessons; `ocean skill migrate` folds the legacy `skills/observations.json` and `candidates.json` into lessons. `ocean skill observation-review` is gone (use `review`), and `ocean daily` reviews candidate lessons, changing nothing on an empty answer. `market/skills/skill-curation` and the observer's store are deleted; signal detection stays in `market/skills/signal-detection`. Run `ocean memory reindex` after a lesson changes so runs can find it.
