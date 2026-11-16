---
name: memory-review
description: Review pending memory candidates with the owner one at a time - compare each with the record it would change, recommend, and merge approved facts cleanly into that record. Use when he says review candidates, review my memory, go through the proposals, or clear the inbox candidates.
version: 1.0.0
category: core
---

# Memory review

Candidates are facts Ocean proposed (inferred, imported or harvested). None is memory until the
owner approves it. You prepare each decision; he makes it.

## 1. Survey

Run `ocean memory review list`. Before asking anything, group what you see:

- **Duplicates**: the same source harvested twice (same `harvested from` path, same text). Decide
  them once, together.
- **Already recorded**: read the target record (or search with `ocean memory search <q>`). A
  candidate that adds nothing new is a reject to recommend, not a question to ask blind.
- **Age**: oldest first. Tell him the total and how many are older than seven days.

## 2. One candidate at a time

For each, read the candidate file and the record it would change. Show, in plain words in his
language:

1. **Now**: what the record says today (or that there is none).
2. **Proposed**: what the candidate adds or changes, with its source and date.
3. **Recommendation**: approve, merge, reject, or ask, with one line of why. Flag what may be
   stale ("as of October; still true?").

Then ask one question and wait. Never approve without his answer; never batch items he has not
seen.

## 3. Apply his answer

- **Approve, no target**: `ocean memory review approve <id> --type <type>` (`routing.json` picks
  the folder) or `--to <path>`. A project fact goes to that project's `memory/`.
- **Approve, existing record**: `ocean memory review approve <id>` appends the candidate's text
  to the record. Then merge by hand: fold the new facts into the right lines, delete what they
  replace, remove the appended raw paragraph, keep the frontmatter flat and set `updated` and
  `last_verified` to today. The record must read as one current statement, not a log.
- **Edit**: write his corrected version into the record, then reject the candidate.
- **Reject**: `ocean memory review reject <id>`.
- **His extra answers** (a date, "I cancelled that") go into the record too, dated.

Show him the few lines that changed after each one; nothing else.

## 4. Close

Run `ocean memory doctor` and report the count still waiting. Never write secrets, never record
facts about third parties beyond what work needs, and never invent a detail he did not give.
