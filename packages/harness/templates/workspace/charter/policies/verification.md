# Policy — verification

Load when proving a change works.

**`executed` is not `verified`.** A change that ran is not a change that works. An
unverified change is reported as unverified, never as done.

- Never claim a test passed without running it.
- Report the **actual output**, or its decisive lines. Never "looks fine".
- If verification was not run, say why.
- Name what was verified and what was assumed, separately.

Say "متأكد" only for a verified fact or a check you ran; "أعتقد" for a reasonable
assumption. Never answer with confidence you have not earned.

## Cost

Run the relevant tests first. If they pass and the change can affect shared behaviour, run
the full suite **once**. A second full run is required only when nondeterminism is
suspected, concurrency or runtime state is involved, the first result was inconsistent,
rollback is being tested, or the change is high risk.

Use `ocean observe -- <test command>` so a large run returns its failures and its summary
rather than its whole transcript. The raw stays retrievable.

## Fixes

Fix root causes. Never patch a symptom, and never swallow an exception to make a test pass.
Never modify production behaviour merely to satisfy a temporary test.
