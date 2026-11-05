---
"ocean": minor
---

`scripts/publish.mjs` now runs the export through gitleaks, trufflehog (without live verification) and `pnpm check:privacy` before reporting success, and stops at the first failure. A scanner that is not installed fails the run unless it is named in `--skip`, which marks the result `complete: false`. A pre-commit hook scans staged changes with gitleaks and only warns when gitleaks is missing. Two test fixtures that the scanners flagged (a literal fake JWT and a connection-string comment) no longer contain the literal.
