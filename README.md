# ReviewTeam

*Your code, reviewed by a team that has to prove it.*

[![CI](https://img.shields.io/github/actions/workflow/status/jcr211/reviewteam/ci.yml?branch=main&label=CI)](https://github.com/jcr211/reviewteam/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/jcr211/reviewteam)](LICENSE)

ReviewTeam is a local, two-phase code review harness: configurable model critics inspect a Git diff in parallel, then a judge verifies their findings and returns one `ALLOW` or `BLOCK` verdict. It works with existing command-line model tools, keeps review policy in repository configuration, and writes auditable run artifacts to disk.

```text
                         ┌─ Critic 1: configured specialty ─┐
                         ├─ Critic 2: configured specialty ─┤
git diff ──► Phase 1 ────┼─ ...                             ├──► structured findings
                         └─ Critic N: configured specialty ─┘
                                                                  │
                                                                  ▼
                         ┌────────────────────────────────────────────┐
Phase 2 ────────────────►│ Judge                                      │
                         │ verify findings · inspect flagged regions  │
                         │ gap-scan · final ALLOW/BLOCK verdict       │
                         └────────────────────────────────────────────┘
```

## Why not a single review bot?

A single reviewer has stable blind spots and correlated errors. A cross-vendor roster with distinct specialties covers more defect classes, as the research below suggests, without treating agreement as proof.

Critics produce candidates, not ballots. Before the judge sees a finding, the harness mechanically checks its citations; references to nonexistent files never reach synthesis. The judge then verifies surviving evidence instead of counting votes, removing a common source of false-positive noise that causes review bots to be muted.

The append-only findings ledger measures each critic's track record and supplies reliability weighting to the judge. `npm run calibrate` tests the roster against examples from your repository, so its value is measured rather than marketed. At the `CRITICAL` tier, the judge can run verification commands in a throwaway worktree, and every blocking finding carries a `VERIFIED` or `UNVERIFIED` label.

Everything runs locally through model CLIs you bring and trust. There are no GitHub App permissions or per-seat SaaS subscriptions, and code leaves the machine only through those configured CLIs.

### Why separate CLIs instead of one gateway?

The harness is part of the reviewer. A critic is not just model weights; it also includes the system prompt, context assembly, tool behavior, and output shaping around them. Routing every seat through one gateway gives you several models but one scaffolding pipeline. A truncation bug, prompt bias, or parsing quirk can then correlate every critic at once, which is the failure mode a council is meant to reduce. Separate CLIs de-correlate the scaffolding as well as the weights: the same open-weights model can produce empty or malformed reviews through one CLI and useful findings through another because the harness changed.

Vendor CLIs can also use subscriptions a team already pays for. The built-in adapters spend otherwise idle capacity from flat-rate coding-agent plans instead of requiring every review to incur metered per-token charges through a gateway key.

Each seat remains a separate process with its own authentication. No single process holds every provider credential, and seats can be locked down independently; the built-in critics run hermetically. First-party CLIs also preserve vendor-native behavior and offer day-one model access more often than aggregators that must first normalize a new release.

This is a preference, not a restriction. `criticCommands` can register a single CLI that serves several models. That roster gives up scaffolding diversity, but retains model diversity and the grounding, cross-examination, reliability, and judge layers, which carry most of the value.

It is still materially different from making raw API calls with no harness. The CLI contract — any process that reads a prompt and prints text — is the thinnest stable interface across vendors. Direct API integration would re-solve authentication, retries, and model churn for each provider while placing every seat on metered billing.

## Evidence behind the design

The design is informed by two research results:

- [Multi-Agent Code Verification via Information Theory](https://arxiv.org/abs/2511.16708) reports low measured correlation between specialized bug detectors and improved coverage from combining agents with different detection patterns. That supports specialty prompts and model diversity.
- [Beyond Majority Voting: LLM Aggregation by Leveraging Higher-Order Information](https://arxiv.org/abs/2510.01499) shows why unweighted majority voting is weak when model errors are heterogeneous or correlated. ReviewTeam does not implement that paper's OW or ISP algorithms; it partially applies the narrower engineering lesson with evidence-checking first and measured-reliability context second, without opaque vote math.

The calibration command helps teams measure whether their chosen critics contribute distinct findings. The research does not guarantee that an arbitrary roster will perform well; evaluate the actual models, prompts, and repository.

## Requirements

- Node.js 18 or newer.
- Git, with the target branch checked out in a Git repository.
- At least one supported or custom critic CLI, installed and authenticated.
- Claude Code CLI installed and authenticated for the judge.

## Supported critics

Five adapters ship built in. Each shells out to a CLI you install and authenticate yourself — ReviewTeam stores no provider credentials.

| ID | CLI | Default model | Overrides |
|---|---|---|---|
| `codex` | `codex` | `gpt-6-sol` | `CODEX_BIN`, `CODEX_COUNCIL_MODEL` |
| `claude` | `claude` | falls back to `judgeModel` | `CLAUDE_BIN`, `CLAUDE_CRITIC_MODEL` |
| `grok` | `grok` | `grok-4.7` | `GROK_BIN`, `GROK_COUNCIL_MODEL` |
| `opencode` | `opencode` | `opencode-go/deepseek-v4.1-flash` | `OPENCODE_COUNCIL_MODEL` |
| `omp` | `omp` | omp's configured model | `OMP_BIN`, `OMP_COUNCIL_MODEL` |

CLI version floors for these defaults: `gpt-6-sol` needs a Codex CLI newer than 0.144 (older builds answer
`400 … model is not supported when using Codex with a ChatGPT account`), and the `claude-opus-5-5` judge needs Claude
Code 2.1.280 or newer. If your PATH copy is older, point `CODEX_BIN` / `CLAUDE_BIN` at a newer binary.

The `opencode` default is deliberately not an OpenAI model — the `codex` adapter already covers that family, so pairing them gives you two vendors rather than two views of the same one.

Default model IDs are starting points, not endorsements, and vendors rename models often. Set the override explicitly if you care which model you get.

The **judge is separate from the roster** and always runs through the Claude CLI, so that must be installed and authenticated even if Claude is not one of your critics. `judgeModel` selects the model, not the executable.

### Choosing a roster

The binding constraint is the number of **distinct model families**, not a fixed seat count. Use one critic from every family you can access — typically three or four critics plus the judge. Another seat from an already-seated family adds correlated eyes; a seat from a new family adds a new view. Prefer different CLIs too; see [Why separate CLIs instead of one gateway?](#why-separate-clis-instead-of-one-gateway)

Critics run in parallel, so council wall-clock latency is set by the slowest seat rather than the number of seats. The real marginal costs of another critic are the extra findings the judge must verify, any metered token spend, and additional false-positive noise.

Seats also fail in practice through quota exhaustion, preflight drops, and transient CLI errors. The gate degrades gracefully: a four-seat roster that loses one remains a council, while a two-seat roster that loses one becomes a single reviewer.

Specialties are **emphasis, not exclusivity**. Every critic reviews the whole diff and may report any concrete defect; its specialty directs extra attention. A defect class without a specialty owner is un-emphasized, not unreviewed.

For a roster of N critics, use **N−1 specialists plus one deliberate generalist backstop**. Specialist prompts catch the tail of their assigned classes; the generalist catches defects that the specialty lenses distort or leave between them. The three-seat example uses correctness and data integrity, security and API contracts, and a generalist backstop with extra attention to failure modes.

Do not take this on faith. `npm run calibrate` measures whether your chosen critics actually surface distinct findings on your repository; a critic that never contributes a unique finding is worth dropping.

### Running against a local model

The `omp` adapter uses omp's own provider configuration. Define an OpenAI-compatible provider in [`~/.omp/agent/models.yml`](https://github.com/can1357/oh-my-pi/blob/main/docs/models.md), then select its default model in global `~/.omp/agent/config.yml` as described in [omp settings](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md). The harness does not duplicate those settings. Prompts are delivered through omp's `@file` syntax to work around compiled omp builds on Windows not reading piped stdin.

The omp critic seat is hermetic and prompt-only: it has no tools and no project config, extension, rule, or skill discovery. It reviews exactly the diff it is handed, so reviewed code can neither execute nor exfiltrate through a critic. This applies the harness's prompt-injection guidance to itself.

For a one-run model override:

```bash
OMP_COUNCIL_MODEL=my-local-provider/reviewer npm run review -- --base main
```

Set `LOCAL_MODEL_URL` (or `LM_STUDIO_URL`) only when you want the harness to fail fast by probing the endpoint's `/v1/models` route. With neither variable set, this preflight is skipped silently and omp manages the provider connection itself.

Migrating from `qwencode`: replace that critic ID with `omp` and move the model/provider selection into omp or `OMP_COUNCIL_MODEL`.

The judge still requires the Claude CLI, so this reduces cost rather than eliminating hosted inference entirely.

## Quickstart

Run these commands from the ReviewTeam checkout.

### 1. Install

```bash
npm install
```

### 2. Run setup (recommended)

```bash
npm run setup
```

The setup wizard discovers installed and authenticated CLIs, lets you choose each seat's model, and can audition the READY seats against a bundled synthetic diff before recommending a family-first roster of up to four critics with measured specialties and a generalist backstop. The audition costs one review per candidate seat, runs the seats in parallel for a few minutes, and incurs token cost only for seats whose provider is metered; pass `--no-audition` to use family-first default assignments instead.

For manual setup, copy the example and edit its critic roster and specialties:

```bash
cp council.config.example.json council.config.json
```

### 3. Run

```bash
npm run review -- --base main
```

Useful variants:

```bash
# Increase review depth. A command-line override can raise, but never lower, the computed tier.
npm run review -- --base main --tier critical

# Force the cross-examination round at any tier, or disable it even at CRITICAL.
npm run review -- --base main --debate
npm run review -- --base main --no-debate

# Print detailed progress.
npm run review -- --base main --verbose

# Report a BLOCK verdict without returning a failing process exit code.
npm run review -- --base main --no-block

# Review a plan instead of a diff.
node council-review-gate.mjs --consult plan.md --topic "Cache migration"

# Summarize recent council reliability.
node council-review-gate.mjs --stats --last 20
```

Exit codes are `0` for `ALLOW`, `1` for `BLOCK`, `2` for a harness error, and `3` when the required judge could not authenticate.

## Configuration

`council.config.json` is read from the current working directory. All fields are optional; omitted fields use the defaults below.

| Field | Type | Default | Purpose |
|---|---|---:|---|
| `projectName` | string | `"Your Project"` | Human-readable project name included in critic and judge context. |
| `description` | string | `"The repository under review."` | Short technical description of the system being reviewed. |
| `reviewConcerns` | string[] | `[]` | Free-form correctness, security, reliability, or domain invariants every critic should check. |
| `architectureRules` | string[] | `[]` | Project conventions and dependency rules critics should enforce. |
| `pathTierRules` | object[] | generic rules | Glob-like path patterns that map changed files to `DOCS`, `STANDARD`, or `CRITICAL`. |
| `critics` | string[] | `["codex", "claude"]` | Phase 1 critic IDs. IDs may select built-in adapters or entries in `criticCommands`. |
| `criticSpecialties` | object | `{}` | Per-critic label and prompt override. |
| `criticCommands` | object | `{}` | Definitions for arbitrary CLI-driven critics. |
| `judgeModel` | string | `"claude-opus-5-5"` | Model argument passed to the Claude CLI for Phase 2. |
| `judgeCanExecute` | boolean | `true` | When `true`, CRITICAL-tier review grants the judge Bash access in a disposable worktree (see below). When `false`, CRITICAL uses the STANDARD tool set. Teams that don't want a model executing anything can turn this off and keep search-only verification. |
| `timeoutSeconds` | integer | `300` | Base critic wall-clock timeout. Built-in adapters may enforce a larger minimum. |

| `judgeTimeoutSeconds` | integer | `360` | Judge wall-clock timeout. Doubled to 2× when the judge runs at the Bash tier (CRITICAL + `judgeCanExecute: true`), because verification takes longer than reading. |
| `maxDiffBytes` | integer | `200000` | Maximum reviewable diff body bytes placed directly in critic prompts before truncation. |
| `excludeDiffPaths` | string[] | generated paths (below) | Additional gitignore-style globs whose diff bodies are omitted. |
| `logDir` | string | `".reviewteam/review-logs"` | Repository-relative directory for run artifacts and the run lock. |
| `memoryDir` | string | `".reviewteam/memory"` | Repository-relative directory for learned false-positive memories. |

If OpenCode finishes with a JSON `step_finish` event whose reason is `length` and it has emitted no assistant text, ReviewTeam records `reasoning_exhausted` with the reasoning and output token counts. It makes one bounded recovery attempt: continue the captured OpenCode session with a short request for findings and a verdict, or rerun the attached diff when session continuation is unavailable. The installed CLI's `run --help` determines whether `--session` and the lower `--variant minimal` setting can be used. A recovery needs a parseable findings section and one explicit verdict line; otherwise the seat remains an error. The seat's `meta.json` records the cause and `recovered: "reasoning_exhausted"` when recovery succeeds.

`excludeDiffPaths` extends the built-in list: `**/migrations/meta/*_snapshot.json`, `**/migrations/meta/_journal.json`, `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Cargo.lock`, `**/*.min.js`, `**/*.min.css`, and `**/catalog-expectation*.json`. These generated bodies are omitted from critic prompts and the diff byte limit, but their names and numstat remain visible under `[GENERATED FILES (bodies omitted)]`; all changed paths still participate in tier routing. The run's `meta.json` records the applied patterns as `excludedDiffPaths` and the remaining body size in bytes as `diffBodyBytes`.

### `pathTierRules`

Each rule has three required fields:

| Field | Meaning |
|---|---|
| `pattern` | Case-insensitive path pattern. `*` matches within one path segment; `**` crosses directories. |
| `tier` | `DOCS`, `STANDARD`, or `CRITICAL`. The highest matching tier wins. |
| `reason` | Explanation recorded in run metadata when the rule matches. |

Example:

```json
{
  "pathTierRules": [
    {
      "pattern": "db/migrations/**",
      "tier": "CRITICAL",
      "reason": "Migration changes can affect stored data and access controls."
    },
    {
      "pattern": "docs/**",
      "tier": "DOCS",
      "reason": "Documentation-only changes use the reduced bench."
    }
  ]
}
```

Unmatched paths route to `STANDARD`. Generic high-risk diff signals, changed database constraints, and diffs over 1,500 changed lines raise the result to `CRITICAL`. A `--tier` or `COUNCIL_TIER` override can raise review depth but cannot lower this computed floor.

### `criticSpecialties`

Each key is a critic ID. The value has a `label` shown to the judge and a `prompt` appended to that critic's instructions.

```json
{
  "criticSpecialties": {
    "codex": {
      "label": "State and transaction correctness",
      "prompt": "Focus on idempotency, partial failure, ordering, and data-loss risks."
    }
  }
}
```

A plain string is also accepted and is treated as the specialty prompt with the label `Configured specialty`.

### `criticCommands`

Custom critic definitions support:

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `command` | string | required | Executable name or path. |
| `args` | string[] | `[]` | Arguments passed to the executable. |
| `promptMode` | `"stdin"` or `"file"` | `"stdin"` | How the review prompt is delivered. |
| `timeoutSeconds` | integer | global timeout | Per-critic minimum timeout. |

For `promptMode: "file"`, use `{promptFile}` in an argument. If the placeholder is absent, the prompt file path is appended to the argument list.

## Bring your own models

A critic is any CLI that accepts a prompt and writes plain text to stdout. Add an ID to `critics`, define how to invoke it in `criticCommands`, and optionally give it a specialty.

```json
{
  "critics": ["correctness-reviewer", "security-reviewer"],
  "criticCommands": {
    "correctness-reviewer": {
      "command": "my-review-cli",
      "args": ["review", "--format", "text"],
      "promptMode": "stdin",
      "timeoutSeconds": 240
    },
    "security-reviewer": {
      "command": "another-review-cli",
      "args": ["--input", "{promptFile}"],
      "promptMode": "file",
      "timeoutSeconds": 360
    }
  },
  "criticSpecialties": {
    "correctness-reviewer": {
      "label": "Correctness",
      "prompt": "Trace state changes, retries, and boundary conditions."
    },
    "security-reviewer": {
      "label": "Security",
      "prompt": "Trace authorization, untrusted input, and credential handling."
    }
  }
}
```

Custom critics must follow the response contract in the generated prompt:

1. Begin with `ALLOW: ...` or `BLOCK: ...`.
2. Use `P0` or `P1` only for blocking findings.
3. Cite a real file and line for each finding.
4. End with the requested JSON findings block.

The judge currently runs through the Claude CLI. `judgeModel` changes the model, not the judge executable.

## Environment overrides

| Variable | Purpose |
|---|---|
| `COUNCIL_CRITICS` | Comma-separated roster that overrides `critics`. |
| `CONSULT_CRITICS` | Comma-separated advisor roster for plan consultation. |
| `COUNCIL_TIER` | Requested tier override: `docs`, `standard`, or `critical`. |
| `CODEX_BIN` | Codex executable override. |
| `CODEX_COUNCIL_MODEL` | Model passed to the built-in Codex adapter. |
| `CLAUDE_BIN` | Claude executable override. |
| `CLAUDE_CRITIC_MODEL` | Model used when Claude is a Phase 1 critic. |
| `GROK_BIN` | Grok executable override. |
| `GROK_COUNCIL_MODEL` | Model passed to the built-in Grok adapter. |
| `OPENCODE_COUNCIL_MODEL` | Model passed to the built-in OpenCode adapter. |
| `OMP_BIN` | omp executable override. |
| `OMP_COUNCIL_MODEL` | Optional model passed to the built-in omp adapter; when unset, omp uses its configured default. |
| `LOCAL_MODEL_URL` | Base URL for the optional OpenAI-compatible local-model preflight. |
| `LOCAL_MODEL_API_KEY` | Credential for that local endpoint, when required. |

## Review tiers

- `DOCS`: one configured critic plus the judge, Read tool only.
- `STANDARD`: the configured critic roster plus the judge at normal effort. The judge gets `Read`, `Grep`, and `Glob` for evidence-based verification.
- `CRITICAL`: the configured critic roster, a cross-examination round, and the judge at increased effort. The judge gets `Read`, `Grep`, `Glob`, and — when `judgeCanExecute` is `true` — `Bash` in a disposable worktree.

### Tier-based judge tools

| Tier | `--allowedTools` |
|---|---|
| DOCS | `Read` (unchanged) |
| STANDARD | `Read`, `Grep`, `Glob` |
| CRITICAL | `Read`, `Grep`, `Glob`, `Bash` — only when `judgeCanExecute` is `true` |

When `judgeCanExecute` is `false`, CRITICAL uses the STANDARD tool set. This lets teams that don't want a model executing commands in their repository keep search-only verification even at the highest tier.

### Disposable execution workspace

When the Bash tier is active, the judge runs in a throwaway detached Git worktree (`git worktree add --detach`). The repo root `node_modules` is junction/symlinked into the worktree. Any side effect of executed commands (test artifacts, file modifications, etc.) lands in the throwaway copy, never the user's working tree. The worktree is removed after the judge finishes (or on failure; removal errors emit a stderr warning but never crash the run).

If the disposable workspace cannot be created (e.g., a locked Git index), the gate degrades gracefully to the STANDARD tool set and continues — the review never fails over the sandbox.

### Judge verdict verification contract

For every blocking finding (P0/P1) the judge upholds, the judge MUST label it `VERIFIED` or `UNVERIFIED`:

- **VERIFIED**: The judge read the actual code path, searched the repo, or (at the Bash tier) ran a command demonstrating the issue. The label includes one-line evidence: the command run or the `file:line` trace.
- **UNVERIFIED**: Upheld on plausibility alone — the critic's description sounds true but the judge could not independently confirm.

The final verdict line carries the split, e.g. `BLOCK: cache refresh can overwrite newer data [2 verified, 1 unverified]`. Absence of the suffix keeps today's behavior exactly.

At the Bash tier, the judge is prompted with concrete verification moves: run the project's test command on affected files, execute a small repro snippet, grep for the pattern the critic claims exists.

Path rules are project policy and belong in `council.config.json`. Generic content signals remain a final safety floor.

## Output

Human-readable progress goes to stderr. The final machine-readable decision is written to stdout.

Example:

```text
TIER: CRITICAL — full bench, xhigh judge
  [correctness-reviewer] BLOCK in 42.1s
  [security-reviewer] ALLOW in 35.8s
  [judge] BLOCK in 51.4s

BLOCKED: retry path can emit the same notification twice
Log: .reviewteam/review-logs/2026-07-28T20-14-03-221Z
{"decision":"block","reason":"retry path can emit the same notification twice"}
```

Each run directory contains critic outputs, judge output, metadata, timing, routing reasons, and normalized findings. The findings ledger is append-only and supports later reliability analysis. A machine-wide lock prevents concurrent councils from competing for the same local model resources.

Findings are mechanically verified against the diff and worktree before synthesis. Each finding is classified as `grounded` (the file is in the diff), `out_of_scope` (the file exists but is not changed), or `fabricated` (the file exists in neither the diff nor the worktree); approximate or out-of-hunk line citations remain grounded and are annotated for content verification instead of being excluded. Fabricated findings never reach the judge, while out-of-scope findings are kept but demoted to P2 severity for verdict-pressure purposes; both grounding and line verification are recorded in the findings ledger.

### Cross-examination round

After grounding, each participating critic receives the other critics' surviving findings and can endorse, refute, or mark each one unsure with a short reason. Fabricated findings and a critic's own findings are excluded. The round runs automatically at `CRITICAL`; `--debate` forces it at any tier, while `--no-debate` disables it everywhere. It is also skipped when fewer than two critics produced surviving findings, because there is nobody to cross-examine.

This costs one extra parallel model call per participating critic — one additional round, not a pairwise call for every critic/finding combination. Endorsements are strong corroboration when they cross model families, while a concrete refutation tells the judge exactly what to check. They remain evidence pointers rather than majority votes: the judge still verifies the code and owns the verdict, following the lesson from [Beyond Majority Voting](https://arxiv.org/abs/2510.01499) that correlated or heterogeneous model votes should not be treated as interchangeable ballots. Vote arrays are retained in the append-only findings ledger and aggregate tallies are recorded in run metadata.

### Reliability weighting

The ledger tracks findings, judge confirmations and rejections, and fabricated citations per critic and category, plus an all-category rollup. Once a cell has at least five findings, the judge receives its confirmation rate as context; smaller samples are labeled `insufficient data` and do not change new-install behavior. This context guides verification effort rather than calculating or overriding the verdict.

After grounding, the harness also checks each active seat across the current run plus recent history. More than 30% fabricated citations across at least five findings in the last ten runs emits a loud warning, records the critic ID in run metadata, and marks the seat degraded for the judge. The harness never removes a seat automatically; roster changes remain an operator decision. The judge-unavailable fallback applies the same grounding discipline mechanically: fabricated findings do not count, and out-of-scope P0/P1 findings count as non-blocking P2s.

`--stats` includes a finding-reliability matrix with each critic's submitted findings, confirmed and rejected percentages, and fabricated count over the requested window.

## Calibration

### Setup wizard

`npm run setup` auditions seats only against the bundled synthetic fixture in `test-fixtures/audition/`; it never sends the repository's code during that audition. The six planted defect classes provide a quick deterministic comparison of recall, false positives, latency, and response-contract compliance. `npm run calibrate` remains the deeper repository-specific measurement for representative branches and real project concerns.

Run critics over representative branches to compare coverage and unique findings:

```bash
npm run calibrate -- --branches feat/cache,fix/session-expiry --base main
```

Calibration is descriptive, not a benchmark guarantee. Use labeled examples from the repository and inspect false positives before changing the roster.

## Coding agent integration

`skills/` holds drop-in instructions for coding agents that run the gate as part of their own workflow, rather than a human invoking it directly.

| File | Purpose |
|------|---------|
| `council.md` | Run the gate, triage findings by priority, fix and retry under a hard cap |
| `pr-review.md` | Open a PR, check for reviews once, act on feedback |
| `verify.md` | Tests, types, lint, and a project-defined banned-pattern scan |

For Claude Code, copy them into your project's command directory:

```bash
cp skills/*.md /path/to/your/project/.claude/commands/
```

They then run as `/council`, `/pr-review`, and `/verify`. For other agents the files are self-contained markdown — inline the relevant sections into your playbook.

Two constraints are deliberate and worth preserving if you adapt them. The council skill caps itself at three total runs, because an agent that retries a review gate until it passes will loop indefinitely on a finding it cannot fix. The PR skill checks for reviews once and exits rather than waiting, because agents that sleep waiting on external state stall the orchestrator that invoked them. See [`skills/README.md`](skills/README.md) for adapting them to your stack.

## Limitations

- Review quality depends on the installed models, their authentication state, and the quality of project policy in the config.
- The harness reviews Git diffs. It is not a replacement for tests, type checking, static analysis, dependency scanning, or human review.
- Critics can hallucinate files, lines, and failure modes. A mechanical grounding pass excludes citations of nonexistent files, annotates approximate line numbers for content verification, and demotes findings outside the diff scope. At STANDARD+, the judge searches the repo for the actual code paths. At CRITICAL, it can execute verification commands in a throwaway workspace. The judge reduces false-positive risk but cannot eliminate it — a plausible-but-wrong finding and a demonstrated one may still look identical in its output, which is why the VERIFIED/UNVERIFIED labeling contract exists.
- Large diffs are truncated for critic prompts. The judge receives focused context around cited lines, so split unrelated work into smaller branches.
- Built-in CLI flags can drift as vendors update their tools. Custom adapters are the stable escape hatch.
- The judge is a required single point of synthesis. A judge outage returns a non-zero status rather than silently accepting critic consensus.
- No provider credentials are managed by this project; every CLI must already be authenticated.

## Development

```bash
npm run typecheck
npm run lint
npm test
```

The fixture reviews in `test-fixtures/` are synthetic. They preserve parser edge cases without embedding output from another codebase.

## License

MIT
