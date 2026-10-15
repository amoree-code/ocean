---
"ocean": minor
---

Sessions and handoffs record their project: an additive `project_id` column on both tables, written for new sessions and backfilled from `working_directory` by `ocean migrate --apply` (handoffs inherit through their source session; a corrupt registry aborts the backfill). `ocean handoff list --project <id>` and the MCP `ocean_handoffs_list` `project` argument filter by it.
