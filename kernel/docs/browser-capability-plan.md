# Browser capability plan

This plan is now maintained in `docs/`, not under a client-specific `.claude/`
directory. The browser capability is provider-neutral, Playwright-backed, approval
gated, and persisted through Ocean sessions.

Completed scope:

1. Define the browser operation contracts and approval policy.
2. Add JSON-safe browser provider boundaries and the Playwright/fake providers.
3. Persist browser lifecycle metadata through the existing session store.
4. Add bounded operations, safe download paths, and live post-condition verification.
5. Add the `ocean browser` lifecycle and operation CLI.
6. Keep real browser integration opt-in; unit tests remain fake-provider based.
7. Document operations, private runtime storage, browser requirements, and rollback.

Remaining proof boundary:

- The normal test suite proves policy and fake-provider behavior.
- `OCEAN_BROWSER_INTEGRATION=1 pnpm test` proves the local real-browser path when a
  Chromium-family executable is installed.
- Native cross-platform browser proof remains separate from the default CI gates.
