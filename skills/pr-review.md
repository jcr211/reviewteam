Create a PR and handle automated reviewer feedback. Uses poll-and-stop — never waits, sleeps, or loops. Two modes: fresh run or re-check.

## Mode detection

If arguments start with `check` followed by a PR number (e.g., `check 142`), skip to **section 3** using that PR number. Otherwise, start from section 1.

## 1. Push

```bash
git branch --show-current
git status
```

If on your main/default branch, STOP. If uncommitted changes exist, commit first. Then push:

```bash
git push origin <branch-name>
```

## 2. Create PR

Create a pull request using your available tools:
- **GitHub MCP:** `mcp__github__create_pull_request` (owner, repo, head, base, title, body)
- **GitHub CLI:** `gh pr create --base main --head <branch> --title "..." --body "..."`
- **GitHub API:** POST to `/repos/{owner}/{repo}/pulls`

Use whichever method your agent has access to. Capture the returned PR number.

**PR body should include:** what changed (from recent commits), any council or verification results from this session.

## 3. Check for reviews (POLL-AND-STOP)

Check for automated review comments using your available tools:
- **GitHub MCP:** `get_pull_request_reviews` + `get_pull_request_comments`
- **GitHub CLI:** `gh pr view <PR#> --comments` + `gh api repos/{owner}/{repo}/pulls/{PR#}/comments`
- **GitHub API:** GET `/repos/{owner}/{repo}/pulls/{PR#}/reviews` + `.../comments`

**If no reviews yet:** Report:
```
PR #[number] created. No automated reviews yet.
Re-run with: check [number]
```
Then **STOP**. Do not wait, sleep, poll in a loop, or retry. The orchestrator or user will re-invoke later.

**If reviews are present:** Continue to section 4.

## 4. Triage findings

For each review comment from automated reviewers:

1. **Classify severity** — P0/P1/HIGH findings require action. P2+/advisory/style items: note and skip.
2. **Verify against code** — Read the cited file and line before acting. Automated reviewers produce false positives regularly.
3. **Check project context** — If your project has a review context file (e.g., `.github/REVIEW_CONTEXT.md`) listing intentional patterns, check findings against it.
4. **Fix legitimate findings** with descriptive commit messages.

## 5. Push and report

If fixes were made, push them. Report:

```
PR REVIEW: #[number]
Reviews from: [reviewer names]
P0/P1 fixed: [count with one-liners]
Advisory noted: [count]
False positives skipped: [count]
```

$ARGUMENTS
