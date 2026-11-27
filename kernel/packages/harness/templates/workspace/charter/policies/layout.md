---
triggers: ["where is", "where do", "which folder", "file location", "وين احط", "وين", "مجلد"]
digest: "Where things live: 02-personal facts, 05-knowledge lessons, 04-projects tasks, sessions/, charter rules; workspace files stay local."
---

# Policy — where things live

Load when deciding where a file, fact or note goes, or where to look for one.

|                                           |                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| what is true about the owner              | `02-personal/` — index first                                               |
| what work taught us                       | `05-knowledge/` — check `decisions/` before contradicting one              |
| what we are working on                    | `04-projects/<category>/<project>/tasks/<ID>/` — the task is authoritative |
| a project's references · lessons          | `04-projects/<category>/<project>/docs/` · `memory/` — never its root      |
| what happened in one sitting              | `sessions/`                                                                |
| the rules and config shaping every client | `charter/` (incl. `policies/`), `bridge/config/`                           |

**The task declares its own status, and nothing else does.** Every other view of it is
generated; `ocean tasks doctor` fails when one has drifted. Per-provider context injection:
`bridge/integrations/context-injection.md`.

Workspace folders are local: only `kernel/` is committed.
