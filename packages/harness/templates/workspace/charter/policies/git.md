# Policy — git

Load for anything beyond reading git state. The hard remote boundary is in the bootstrap
because it must never depend on this file having been read.

**Local and remote are separate trust boundaries. Maximum autonomy locally; explicit human
approval remotely.**

## Free, no asking

`status` · `diff` · `log` · `show` · `branch` · `checkout` / `switch` · `add` · `commit` ·
`stash` · `fetch` · `pull` · rebasing local unpushed work · reading anything with `gh`.

## Publication is the last step, not the next one

Keep substantial workspace, public-repo and private-repo restructuring local until the
owner says the structure is settled and explicitly asks to publish. Do not propose `push`
as the automatic next action while architecture or public/private boundaries are still
moving.

## When local work is done

Stop and report. Do not push, and do not ask permission in advance of finishing:

```
The task is complete locally.

Branch:  <name>
Commit:  <sha> <subject>
Tests:   <command> → <actual result>
Changes: <n files — the notable ones>

Ready to push and open/update the PR. Do you want me to push?
```

After an explicit yes: push → verify the remote ref → `gh pr list --head <branch>` →
create the PR, or update the existing one. **Never open a second PR for a branch that
already has one.** Never merge, never close, never force push, never rewrite history that
has been pushed — each is the owner's call, asked for by name.

Run verification locally to prove a fix, then delete temporary test files before staging.

## Working in the kernel

Code work happens in `~/ocean/kernel` itself, on its own branch — no worktrees (owner decision
2026-10-16). `git fetch origin && git switch -c <branch> origin/main`, commit, push by name with
approval, PR, owner merges. If the kernel tree already has uncommitted changes you did not make,
they belong to another session: never stash, commit, discard or `git add -A` them — stage by
path, or stop and say so. Before editing, claim the task and the dirs
(`ocean policy task`, "Claims"); use path `kernel` if you will switch branches or commit — the
checkout has one HEAD, and another session may be committing in it right now.
`~/ocean` is not a Git repository for our purposes (see below), so task records are plain-file
edits and need no branch.

## Only the kernel uses Git

Git exists only in `~/ocean/kernel` (its own remote): branch, push with explicit
approval, PR, owner merges. Everything else, including `~/ocean`, is local files with no remote
and no repository to think about — edit them, never commit or mention committing. Copying any
private data into `kernel/` crosses a trust boundary and needs approval each time.
