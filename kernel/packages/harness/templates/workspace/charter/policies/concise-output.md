# Policy — concise output

Load when producing any response: a chat reply, a report, a checkpoint note.

Output tokens are a standing bill, paid on every turn. The rule stays small on purpose —
spending a thousand tokens of instruction to save a hundred of output is a net loss.

## Rules

- No preamble. Do not restate the task before answering it.
- Do not narrate a routine, successful tool call. Silence between meaningful events is
  correct — see `ocean policy lifecycle`.
- Do not repeat unchanged code back. Reference it (`file:line`); show only the diff.
- Do not explain a successful, expected operation. Explain a surprising one.
- Prefer stating the finding, the result, and the next action over the path taken to get
  there.
- Preserve exactly, never paraphrase: error text, commands, file paths, identifiers,
  numbers.

## What this is not

Not code golf, and not a ban on explanation. A genuinely non-obvious decision, a security
tradeoff, or a result the owner did not expect still gets the sentence it needs. The
target is zero *wasted* tokens, not zero tokens.

## Relation to response formatting

This governs *how much* to say. `ocean policy response` governs *how* — language,
direction, labels. Both apply together to a substantial reply.