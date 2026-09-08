# Git Hygiene — Non-Negotiable

Read this at the start of **every** task that may touch git. The goal is a clean,
legible history and a working tree that is never in a "weird state." When in
doubt, stop and ask — do not improvise your way out of a git mess.

This is the process companion to [`CONTRIBUTING.md`](../CONTRIBUTING.md), which
covers setup, the review loop, and the PR mechanics. CONTRIBUTING.md describes
*how* to send a change; this document is the non-negotiable discipline that
applies to **everyone, including the maintainer** — the maintainer developing
locally follows the same branch/PR/gate flow as an external contributor. No
one commits straight to `main`.

---

## The Golden Rules

1. **Know where you are before you do anything.** Run `git status` and
   `git branch --show-current` before you start and before every commit. Never
   assume the branch or the working-tree state.
2. **Never commit directly to `main`.** All work happens on a `feature/*`,
   `fix/*`, `docs/*`, `prompt:*`, or `ci/*` branch and reaches `main` only
   through a pull request. `main` is the only long-lived branch — there is no
   `develop`. The maintainer is not exempt: a change authored by the maintainer
   on `main` skips the adversarial review gate the project runs on every PR,
   which defeats the entire point of the tool. Branch first, then code.
3. **Every branch is based off the latest `origin/main` — no exceptions.** Cut
   every branch from an up-to-date `main`. Never branch off another feature
   branch (stacked branches drift and are how merges silently drop code). Start
   from origin state, not local state — fetch first:
   ```
   git fetch --prune
   git checkout main && git pull --ff-only origin main
   git checkout -b feature/<short-slug>
   ```
   Then prune local branches whose upstream is gone (`git branch -vv | grep
   ': gone]'`) — each one either merged already (safe to delete) or needs a
   look before deleting, never silently kept around as if still live.
   **Create the branch before writing a single line of code.** Never edit files
   on `main` and branch after — you will end up with uncommitted changes on a
   shared branch. Branch first, then code.
4. **One branch at a time, one logical change per branch.** Finish and merge
   the current branch before starting the next piece of work. Don't begin new
   feature code while a PR is open and unmerged — even if asked. Stack depth =
   1. A branch carries one logical change; if you find yourself with two
   unrelated changes in the working tree, they belong on two branches (stash
   one, branch, commit, then branch again for the other).
5. **bd issues and git branches are separate axes — don't conflate them.**
   Issue state lives in bd's own Dolt store, synced via `refs/dolt/data` — a ref
   namespace alongside but independent of `refs/heads/*`. Checking out a
   different git branch does not change which bd issues exist or their status;
   nothing about this branch model needs to change because of bd. Sequence
   `bd dolt push` after the PR merges and the issue closes, not before —
   pushing dolt state ahead of the merge would let a collaborator pull a
   "closed" issue whose code isn't in `main` yet.
6. **Never force-push a shared branch** (`main`, or any branch with an open PR /
   other readers). `--force-with-lease` only ever on your own private feature
   branch, and only when you understand why.
7. **Never rewrite published history.** Don't `rebase`, `amend`, or `reset`
   commits that have already been pushed to a shared branch. Amend only local,
   unpushed commits.
8. **Destructive commands need confirmation.** `git reset --hard`,
   `git clean -fd`, branch deletion, and force-push can lose work
   irrecoverably. State what will be lost and confirm before running them.
9. **Recover, don't panic.** `git reflog` finds "lost" commits after a bad
   reset/rebase. Reach for it before recreating work.

---

## Commits

- **One logical change per commit.** No "misc fixes" grab-bags; no unrelated
  files riding along. Check `git diff --staged` before committing. If a single
  file carries two unrelated changes, stage only the relevant hunk
  (`git add -p`, or split via a temporary checkout) — never let a parked change
  ride into an unrelated commit.
- **Conventional Commits**, matching flaught's listed types: `feat`, `fix`,
  `docs`, `chore`, `test`, `refactor`, `ci`, `prompt`. The history feeds the
  changelog, so the type and summary matter. Imperative subject, lowercase
  type, no trailing period, summary under ~72 chars; detail in the wrapped
  body. Scope is optional but useful: `prompt(test-scrutiny): …`.
- **Signed commits are required on `main`.** GitHub enforces verified
  signatures on `main`, so every contributor — including the maintainer —
  must sign commits. The lowest-friction path is SSH signing (no GPG
  install; reuses an existing SSH key). Set it up once:

  1. Add your public key to GitHub as a **Signing Key** (Settings → SSH and
     GPG keys → New SSH key → Key type: *Signing Key*). This is separate
     from your auth key — GitHub distinguishes them. (CLI: `gh ssh-key add
     --type signing ~/.ssh/id_ed25519.pub` after `gh auth refresh -h
     github.com -s admin:ssh_signing_key`.)
  2. Tell git to sign with it, globally:
     ```
     git config --global gpg.format ssh
     git config --global user.signingkey ~/.ssh/id_ed25519
     git config --global commit.gpgsign true
     ```
  3. Verify: make a test commit and check `git log --show-signature` shows
     a `Good "git" signature`, and that GitHub renders the commit as
     **Verified**.

  An unsigned commit can only land on `main` via an admin override, which
  skips the very review this project exists to provide. If your key is
  passphrase-protected, load it into `ssh-agent` (`ssh-add`) so signing
  doesn't prompt on every commit. See GitHub's docs on SSH commit signing.
- **Stage intentionally.** Prefer naming paths over `git add -A`. Never commit
  `dist/` (build output), secrets, `.env`, or scratch files — check
  `git status` first.
- **Never use `git commit --no-verify`** to skip hooks. The pre-commit hook
  runs the test suite; if it fails, fix the cause. If the hook itself is
  broken, say so and fix the hook — don't bypass it.
- **Only commit/push when the user asks** (or under a standing autonomy grant
  explicitly given for that scope). Flag risky changes even then.

---

## Working Tree — staying out of weird states

- **Keep the tree clean.** Don't start new work on top of unrelated uncommitted
  changes. Commit, stash, or discard first — deliberately.
- **`git stash` is not a parking lot.** If you stash, pop it back in the same
  session; a forgotten stash is a future "where did my change go."
- **Never leave a detached HEAD.** If `git status` says "HEAD detached," stop
  and get back onto a named branch before doing anything else.
- **Resolve conflicts, never paper over them.** During a merge/rebase
  conflict, resolve every marker, re-run `npm run typecheck` and the relevant
  tests, then continue. If it's beyond a clean resolution, `git merge --abort`
  / `git rebase --abort` and reassess — do not force a half-merged tree.

---

## Pull Requests

- Feature branch → PR into `main`. The **Adversarial Review** workflow runs on
  your PR: flaught builds from your branch source (so changes to its own
  review logic are reflected in its own run), posts a comment, and uploads a
  `findings.json` artifact.
- **The adversarial gate is the merge gate.** Exit code `1` (findings exceed
  the severity gate) blocks merge. Exit code `2` (config/API/LLM fault) does
  **not** block merge — a tool outage is not evidence of a code problem. See
  the [exit codes](../README.md#exit-codes) table.
- You don't have to get to zero findings to merge, but each non-dismissed
  finding above the gate needs to be either fixed or dismissed with a real
  reason. "I disagree" is not a reason. See [Dismissals](dismissals.md).
- **Merge promptly.** Once the gate is green, merge. Open PRs drift from
  `main` and compound conflict risk for every other branch in flight.

---

## Pre-flight before pushing (catch failures locally)

Flaught dogfoods itself — run the same checks locally that CI will, in order:

```
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src/
npm test            # vitest run (full suite; some tests use a git worktree)
```

For a faster loop on non-review changes, `npm run test:unit` skips the slow
integration tests. And run the reviewer the way CI will, against your branch:

```
npm run build
npm run review -- --base main      # full review vs the merge-base with main
npm run review -- --no-llm         # deterministic tools only, no API key needed
```

If you don't have a provider key, `--no-llm` still catches most deterministic
findings. Don't push red and hope CI sorts it out — the gate will run the same
review you just ran.

---

## Why this matters here

Flaught's whole premise is that code is scrutinized by a skeptic that did not
write it. The only way that premise holds is if *every* change — including the
maintainer's — reaches `main` through that scrutiny. A commit that lands
straight on `main` is exactly the "the model that wrote the PR is primed to
defend it" failure mode the tool exists to break. Branch, PR, gate. Every
time.