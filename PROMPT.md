# Ralph Loop — Standing Instructions (read every iteration)

You are operating autonomously against `PRD.md`, with progress tracked in `progress.txt`.
This is a live system handling real patient bookings and payments (CareConnect360.in). Correctness beats speed.

## Every iteration, in order:

1. **Read `PRD.md` top to bottom and `progress.txt` in full.** Do not rely on memory of previous iterations — you have none. The disk is the only source of truth.
2. **Pick exactly one task**: the first `[ ]` task in the earliest incomplete phase. Do not skip ahead to a later phase while an earlier phase has unchecked tasks, unless `progress.txt` explicitly says a task was deferred with a reason.
3. **Before writing code**, re-read the specific finding in `audit_report.md` referenced by the task, so you're working from the original evidence, not a paraphrase.
4. **Implement the fix.** Match the audit's suggested fix unless you have a concrete reason to deviate — if you deviate, write the reason in `progress.txt`.
5. **Verify before you ever touch git:**
   - Run any existing lint command in this repo (check `package.json` scripts — commonly `npm run lint`). If none exists, skip, and note that in `progress.txt` once (not every iteration).
   - Run any existing build/typecheck command (`npm run build` or equivalent). It must succeed.
   - Run any existing test suite. It must pass.
   - If a verification command doesn't exist for something the task changed (e.g. no test covers RLS policies), say so explicitly in `progress.txt` rather than silently skipping.
6. **Run the CodeRabbit gate** (see below). This is not optional and not skippable for any task.
7. **Only after CodeRabbit is clean**, stage and commit:
   - `git add` only the files relevant to this task — never `git add .` blindly if unrelated files were touched by tooling (formatters, etc.) unless you intend those changes too.
   - Commit message format: `fix(TASK-XXX): <short description>` — match the task ID from `PRD.md` exactly.
   - Do not push to `main`/`master` directly. This session's branch (created automatically by Ralph Loop's "create new branch every session" setting) is where commits land; leave pushing/PR opening as configured in the extension, or run `git push -u origin HEAD` if the extension expects the branch to be pushed each iteration.
8. **Update `PRD.md`**: flip the task's `[ ]` to `[x]` (only after commit succeeds).
9. **Append to `progress.txt`** (never delete/rewrite previous entries):
   ```
   [ISO timestamp] TASK-XXX: <one-line summary of what changed and why>
   Verification: lint=<pass/skip> build=<pass/skip> tests=<pass/skip> coderabbit=<clean/n-issues-fixed>
   Files: <list>
   ```
10. **Stop.** One task per iteration. Let the loop's iteration boundary handle the next task with fresh context.

## The CodeRabbit gate (mandatory, every task)

Run:
```
coderabbit review --prompt-only --type uncommitted
```
- If CodeRabbit returns issues: fix every **actionable** issue it raises (security, correctness, logic errors). For style-only nitpicks that conflict with the audit's exact suggested fix, you may leave them — note why in `progress.txt`.
- Re-run `coderabbit review --prompt-only --type uncommitted` after fixing. Loop this at most 2 times. If issues remain after 2 fix passes, do not commit — mark the task `[~]` in `PRD.md`, write the unresolved CodeRabbit findings verbatim into `progress.txt`, and stop this iteration so a human can look at it.
- If the `coderabbit` CLI is not installed or not authenticated in this environment, do not silently skip the gate — write that fact into `progress.txt` on the first iteration only, and proceed with lint/build/tests as the gate instead until it's available.

## Hard stops — never do these autonomously:

- **TASK-010 (CSP `unsafe-inline`)**: if fixing this touches more than ~5 files or build tooling, stop and flag per the instructions in `PRD.md`. Do not ship a half-migrated CSP — that can silently break the site or silently reopen the XSS hole.
- **TASK-017 (dual HTML tree consolidation)**: do this on its own dedicated pass, after everything else is done, and enumerate every route repointed in `progress.txt` for human review before merge.
- Never touch `.env`, secrets, or credentials beyond adding documented placeholder keys to `.env.example`.
- Never modify or delete an existing Supabase migration file — new changes are additive migrations only.
- Never merge this session's branch into `main` yourself — that's a human decision.
- If a task's fix requires information not present in the repo or `audit_report.md` (e.g., a business decision, like TASK-020's refund-email intent), do not guess — add a clear question to `progress.txt` and mark the task `[~]`.

## Model note
This project is set up to run the loop's primary model as Claude Opus per session config. If you (the running model) are a fallback model because Opus was rate-limited, apply the same rigor — do not relax the CodeRabbit gate or the phase ordering just because you're a fallback.
