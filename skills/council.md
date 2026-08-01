Run the ReviewTeam pre-PR review gate. Interpret results, fix legitimate findings, retry with a hard cap. Every path exits cleanly — no stalls.

## 0. Preflight

```bash
git branch --show-current
```

If on your main/default branch, STOP — council runs on feature branches only.

## 1. Run the gate

```bash
npm run review -- --base main --verbose
```

If your default branch is not `main`, change `--base` accordingly.

This takes 3-5 minutes (parallel critics + judge). Capture the exit code.

## 2. Handle result by exit code

### Exit 0 — ALLOW

Read the newest `.json` log in your configured `logDir` (default: `.reviewteam/review-logs/`). Summarize: critic count, timing, any P2/P3 advisory observations. Report "Council: ALLOW" and stop.

### Exit 2 — ERROR

All critics or the judge failed. Report the error. This is a tool failure, not a code quality signal. State: "Council error — does not block PR. Proceeding." and stop.

### Exit 1 — BLOCK

This requires action:

1. Read the newest `.json` log. Parse `aggregatedFindings` and `finalVerdict`.
2. Check for `*-raw.txt` diagnostic files alongside the log (written when a critic produces no parsed output — useful for debugging critic issues).
3. Findings use this format: `[P0|P1|P2|P3] \`file:L##\` (CATEGORY) — description`
4. For each **P0 or P1** finding:
   - Read the cited file at the cited line
   - Determine if the finding is legitimate or a false positive
   - If legitimate: fix it
   - If false positive: note it and move on
5. **Ignore P2/P3** — these are advisory and do not justify a retry
6. If any fixes were made: commit with a descriptive message and re-run the gate (go back to step 1)

## 3. Retry cap

**Maximum 2 retries (3 total gate runs).** If still BLOCK after 3 runs:
- Report the remaining findings with file:line references
- State: "Council gate exhausted retries. Remaining findings noted."
- STOP — do not loop further. Downstream reviewers will catch anything remaining.

## 4. Report

Always end with a structured summary:

```
COUNCIL RESULT: [ALLOW | BLOCK-FIXED | BLOCK-REMAINING | ERROR]
Runs: [1-3]
Findings fixed: [count with one-line descriptions]
Findings noted: [count of P2/P3 or unresolved items]
```

$ARGUMENTS
