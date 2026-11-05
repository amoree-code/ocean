---
"ocean": patch
---

One process supervisor (`process-supervisor.ts`) now ends every headless provider run: the timeout (`124`), the output budget (`125`), the process group a run lives in, the signals passed on to it, and stdout line splitting. `runHeadless` (the CLI providers) and the Claude Agent SDK runner both use it instead of each keeping its own copy. A CLI provider's run now also stops everything it started on a timeout or budget stop, passes Ocean's Ctrl+C on to it, and ends 500 ms after the provider exits even if a background process still holds its output.
