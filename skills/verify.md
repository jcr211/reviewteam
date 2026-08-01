Quick verification pass — tests, types, lint, banned patterns. Produces a structured pass/fail table. Runs in under 2 minutes.

## 1. Detect scope

If arguments specify a package or directory, use it. Otherwise detect from changed files:

```bash
git diff --name-only main...HEAD
```

## 2. Run tests

Run your project's test suite for the affected code:

```bash
# Examples — adapt to your project's test runner:
npx vitest run --reporter=verbose
npx jest --verbose
npm test
```

Compare pass/fail/skip counts against your project's known baselines. PASS if count >= baseline. FAIL if any regression (count dropped or new failures).

If your project doesn't track baselines, simply report the counts.

## 3. Type check

```bash
# TypeScript:
npx tsc --noEmit

# Or your project's type check command:
npm run typecheck
```

PASS if zero errors. FAIL with error count and first 5 errors shown.

## 4. Lint changed files

Get changed source files and lint only those:

```bash
git diff --name-only main...HEAD -- "*.ts" "*.tsx" "*.js" "*.jsx" "*.py"
```

Run your project's linter on changed files only:

```bash
# Examples — adapt to your project:
npx biome check <files>
npx eslint <files>
ruff check <files>
```

PASS if zero errors on changed files. Pre-existing errors on untouched files are acceptable.

## 5. Banned pattern scan

Grep changed files for patterns your project considers dangerous. Common examples:

| Pattern | Why banned |
|---------|-----------|
| `as any` | Disables type safety (TypeScript) |
| `as unknown as` | Bypasses type checking (TypeScript) |
| `// @ts-ignore` | Suppresses errors without justification |
| `console.log` | Debug logging in production code |
| `TODO` / `FIXME` | Unfinished work shipping to main |

Customize this list for your project's conventions.

PASS if zero hits. FAIL with file:line for each match.

## 6. Report

Output a structured table:

```
VERIFY RESULT: [PASS | FAIL]

| Check           | Result | Details                    |
|-----------------|--------|----------------------------|
| Tests           | PASS   | 240/240 (no regressions)   |
| Types           | PASS   | 0 errors                   |
| Lint            | PASS   | 0 errors on 12 changed     |
| Banned patterns | PASS   | 0 hits                     |
```

Overall PASS only if ALL checks pass.

$ARGUMENTS
