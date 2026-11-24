---
name: daily-harvest
description: Turn everything the inbox and the daily folder hold - sessions from every AI client, imported memories, candidates, corrections - into filed knowledge and a better system, with no manual review, then archive. Use when the owner says harvest, process the inbox, file everything, improve the knowledge, or clean up 00-inbox and 01-daily.
version: 1.0.0
category: core
---

# Daily harvest

The owner decided (2026-11-16) that Ocean files what it learns on its own. You do not ask him to
review each item. You decide where each fact belongs, write it there, and report what you did
with a way to undo it. Only a contradiction stops and waits for him.

## Where everything lives

- A session from any client (Claude Code, Claude Desktop, Codex, Gemini, …) is one record in
  `01-daily/sessions/YYYY-MM/`, its client in `provider`.
- A fact is filed by **topic, not by which AI said it**: `routing.json` maps its type to a folder
  (identity, preference, goal, education, career, project memory, decision, solution, discovery,
  …). Its frontmatter keeps where it came from: `origin: imported|harvested`, `source:
  <client>`, the date.
- Raw memory pulled from a client waits in `00-inbox/native/<client>/` until harvested, then
  moves to `00-inbox/archive/native/<client>/<YYYY-MM>/`.

## 1. The mechanical pass

`ocean rhythm --yes` runs it all with no model, each part once per period (the service runs it
at every session start and end, and hourly): the morning block of today's note, every day not yet
harvested plus today so far, the archive, last week's digest, last month's review.

The daily note has one shape: `## Today` and `## Brief` (morning, under the title), then the day's
account — `## Day summary` (sessions per client, decisions, fixes, lessons, captures), `## Open
loops` (every Next, `- [ ]`, carried each morning until ticked), `## Corrections`, `## Time` — and
last `## Notes`, which is the owner's and never written. Claude Desktop chats and long Claude Code
sessions are in it through the digest their fact capture returns in the same call.

Read the JSON of `ocean harvest --pending --yes` (or the day's note): that is your work list.

## 2. The judgement pass

Work through these in order. For every fact: search first (`ocean memory search`), then either
strengthen the record that holds it (merge into one current statement, fresh `updated` /
`last_verified`) or create the record where `routing.json` puts its type. Never duplicate.

1. **Candidates** (`ocean memory review list`): a duplicate of a record → reject; new and
   consistent → approve with `--type` (or `--to`), then merge cleanly (the memory-review skill's
   step 3); unsure what it means → leave it and list it in the report.
2. **Native memory** in `00-inbox/native/<client>/` and the files in `02-personal/imported/`:
   split each into facts, file each by topic with `origin: imported` and its client, then move the
   raw file to the archive. A project fact goes to that project's `memory/`.
3. **Legacy session records** (no Decisions / Learned sections): read a month at a time; pull out
   decisions, fixes and lessons; file them as above; add `harvested: <date>` to each record read.
4. **Corrections** in the day summaries: one the owner gave twice, or with "always" / "never",
   becomes a feedback record in `02-personal/work/` (rule, **Why:**, **How to apply:**). A rule
   for every client goes to the backlog as a charter change, not into the charter itself.
5. **The system itself**: an error recurring across sessions (`ocean telemetry --yes`); the same
   manual steps in three or more sessions → a backlog line `skill: <what it would do>`; a failure
   in `05-knowledge/lessons/` (`kind: failure`) with no linked solution → look for the fix in the sessions.
6. **Knowledge hygiene**: merge records that say the same thing; list decisions whose
   `last_verified` is over 90 days old; fix broken links; run `ocean memory sync --apply`.
7. **The owner's journey**: a study session (IELTS, Letspeak) adds to his study log; finished,
   notable work becomes a milestone (`status: done`); a project's state goes to its `memory/`.

**Stop and do not write** when a fact contradicts a record or one of his notes in `02-personal/notes/`:
propose it with `contradicts` so it waits in `02-personal/CONFLICTS.md`. Never write a secret;
about other people, only what the work needs; never invent a detail.

## 3. Archive

Run `ocean harvest archive --yes`: a harvested day's note leaves `01-daily/` for
`01-daily/archive/<YYYY-MM>/` after 7 days, and its session records go to
`01-daily/sessions/archive/<YYYY-MM>/` (still searched) after 30. Nothing is deleted.

## 4. Report

In the owner's language, short: days harvested, records created and strengthened (by folder),
facts filed from other AIs, corrections turned into rules, backlog lines added, what waits in
CONFLICTS.md, what moved to the archive, and `ocean harvest undo <date>` for any day he wants back.
