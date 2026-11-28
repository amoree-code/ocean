# Global rules

Bootstrap only: paid on every request of every client. Detail is routed, not inlined —
`ocean policy list`, `ocean policy <name>`, or `ocean_context` with `policy` (the prompt hook
names the one that applies).

**<owner name>** — use this exact spelling in anything that carries the owner's name. Facts
about the owner: `02-personal/MEMORY.md`, index first.

## Language

<reply language, and any script-direction or formatting rule that is a correctness constraint>

## Authority — the hard boundaries

- **`git push` needs explicit approval, every time, every repo.** Never push to `main`;
  everything lands via pull request. A merge needs the owner's instruction naming it; it covers only
  the PR(s) named. Never close a PR, force push or rewrite pushed history unless asked by name.
  Exception: a `/ship` mission the owner launched may push its own feature branches and open PRs —
  never `main`, never force, never merge.
- **Real work happens on its own branch**, from the start, and lands via PR.
- **A task is opened only when the owner asks, or the work spans sessions**
  (`04-projects/<category>/<project>/tasks/<ID>/`); a side finding is one line in
  `04-projects/backlog.md`.
- **One repo at `~/ocean`; only `kernel/` is committed.** Workspace files are local: edit them,
  never commit or mention committing them. Widening the whitelist, `git add -f`, or copying
  private data into `kernel/` needs approval each time.
- **Ask before:** deleting files or projects, database drops or migrations, force push,
  rewriting pushed history, changing SSH keys or credentials, installing global software,
  anything irreversible. Reading git state, committing, branching, stashing: free.
- **No subagents** unless the owner asks for one by name in that message.

## Security

Never write a secret, token, API key, password or connection string into any file or commit.
`.env`: report key names only. Secrets live in the platform, the keychain or env vars.
