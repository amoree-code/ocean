---
"@ocean/brain": patch
"@ocean/core": patch
"@ocean/market": patch
"ocean": patch
---

Brain index and service, memory (narratives, summaries, promotion, profile facts), evidence and capture move into the new `@ocean/brain` package; `sqlite-vec` moves with the brain index. Every `@ocean/*` package exports a `source` condition so the dependency check resolves imports between packages.
