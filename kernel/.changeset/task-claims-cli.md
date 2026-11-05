---
"ocean": minor
---

New `ocean tasks claim <id> --by <name> [--paths a,b] [--force]` and `ocean tasks release <id>`. A claim records which session is working on a task (and which paths); a second owner is refused with the holder named, overlapping paths across tasks are refused, and a claim expires after two hours.
