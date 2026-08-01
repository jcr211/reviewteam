# Council Workflow Skills

Drop-in skill templates for coding agents that use ReviewTeam as a quality gate.

## What's here

| File | Purpose | Design Pattern |
|------|---------|----------------|
| `council.md` | Run the council gate, fix findings, retry | Retry-with-cap (max 3 runs) |
| `pr-review.md` | Create PR, check for reviews, fix feedback | Poll-and-stop (never waits) |
| `verify.md` | Tests + types + lint + banned patterns | Run-and-report (fast, no fixes) |

## How to use

### Claude Code

Copy into `.claude/commands/` in your project:

```bash
cp skills/*.md /path/to/your/project/.claude/commands/
```

Then invoke with `/council`, `/pr-review`, `/verify` in Claude Code.

### Codex / Other Agents

Inline the logic into your playbook or agent prompt. The markdown files are self-contained instructions — paste the relevant sections into your agent's task list.

### CI / Scripts

The patterns describe the logic. Implement in your CI tool of choice — the core flow (run gate → check exit code → fix → retry with cap) translates to any scripting language.

## Customization

Each skill has `$ARGUMENTS` at the bottom — this is a Claude Code convention for user-supplied arguments. Remove or replace for other platforms.

**Adapt for your project:**
- `verify.md`: Change the test runner, linter, type checker, and banned patterns to match your stack
- `pr-review.md`: Change the GitHub tool/CLI to whatever your agent has access to
- `council.md`: Change `--base` if your default branch is not `main`, and the log directory if you set a custom `logDir` in `council.config.json`

## Design Principles

These skills solve two autorun agent failure modes:

1. **No infinite loops** — Council gate has a hard retry cap (3 runs max). After that, report and move on.
2. **No sleep stalls** — PR review checks once and stops. The orchestrator re-invokes later. Agents never wait.

See the main [README](../README.md) for configuration, review tiers, and output format.
