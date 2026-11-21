---
name: weekly-review
description: Walk the owner through the week to inbox zero - the weekly digest, pending memory candidates, inbox captures and unsorted notes - deciding each item with him.
version: 1.1.0
category: core
---

# Weekly review

Take the owner from a full inbox to zero, one decision at a time. He decides; you prepare.

1. Run `ocean distill --week` (dry run) and show what it would do; on his yes, run it with
   `--yes`. Open the digest it wrote in `01-daily/reports/weekly/`.
2. Walk `ocean memory review list`, oldest first. For each candidate, show its title, source and
   proposed target in two lines, then ask: approve (`ocean memory review approve <id>`, with
   `--type <type>` or `--to <path>` when it has no target), edit, or reject. Never approve
   without his answer.
3. Walk `00-inbox/captures/`: for each capture, file it where its type lives (routing.json),
   turn it into a task or backlog line, or mark it `status: processed`.
4. List his notes in `02-personal/notes/` still `status: todo` and older than 7 days. For each,
   suggest one of: a folder (`study/`, `work/`, `ideas/`, `archive/`), a status (`active`, `in-qa`,
   `paused`, `blocked`, `done`, `cancelled`), or "make it a project" (QuickAdd: Project from
   this note). He acts on it in Obsidian; never move, rename or edit a note yourself.
5. Run `ocean interests decay` (dry run) and the brief's keep/skip feedback he gives.
6. Finish with `ocean doctor`: report `INBOX_STALE`, `FRONTMATTER_MISSING`, `TYPE_LOCATION`, and
   one next step.

Ask one question at a time. Batch nothing he has not seen.
