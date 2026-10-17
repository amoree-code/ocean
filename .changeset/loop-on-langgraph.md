---
"ocean": minor
"@ocean/loop": minor
---

The task loop runs each iteration as a LangGraph graph (`work → verify → record`) with a durable checkpointer. Every step's result is written to `bridge/loop-checkpoints.json` before the next step starts. So if the process dies mid-iteration, the next pass resumes at that step: a finished agent session is not run again. A loop stopped in the meantime drops its interrupted iteration instead of resuming it. `verify` and `record` retry a thrown error in place (3 attempts) before it counts as one failed attempt of the loop. The loop's own policy is unchanged: iteration budget, attempt budget, interval, stop, and verifier-in-loop completion. LangGraph loads only when loops run, and loop runs force LangSmith tracing off, so loop state never leaves the machine. Adds `@langchain/langgraph` 1.4.19 and `@langchain/core` 1.2.14, pinned exactly.
