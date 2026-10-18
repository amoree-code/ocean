---
"ocean": minor
"@ocean/brain": minor
"@ocean/loop": minor
"@ocean/market": patch
---

Session closeout now learns into the lessons store (T-230 P2). `scoreSession` calls a session verified only when it completed, exited 0, and every evidence event it recorded is proven. A verified session confirms the lessons it used, turns what it did into candidate lessons, and counts a repeat of an existing lesson as another hit. A user correction in a session that used a lesson contradicts it. A candidate becomes active only with three verified hits and a passing replay eval, which re-scores each hit's session from its recorded events; nothing writes to `charter/`. The outcome is recorded as a `lesson_scored` session event. The task observer's detection is now a pure function; its own store is retired in P3.
