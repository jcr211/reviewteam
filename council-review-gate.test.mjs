import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	aggregateFindings,
	aggregateDebateVotes,
	buildOmpArgs,
	buildConsultCriticPrompt,
	buildDebateJudgeSection,
	buildJudgeInstructions,
	buildReliabilityPromptSection,
	buildRebuttalPrompt,
	claudeNeedsShell,
	getProviderConfig,
	getSpecializationBlock,
	isJudgeAuthFailure,
	isJudgeTransientFailure,
	isVerdictSummary,
	normalizeProviderFailure,
	numberDebateFindings,
	parseArgs,
	parseCriticVerdict,
	parseJsonFindings,
	parseRebuttalVotes,
	parseVerdict,
	preflightLocalModel,
	reanchorCriticVerdict,
	resolveLocalModelConfig,
	resolveJudgeTools,
	shouldRunDebate,
	synthesizeFromCritics,
	tallyDebateFindings,
	toLogMetadata,
	writeConsultLog,
} from "./council-review-gate.mjs";

const SYNTHETIC_ALLOW_PREAMBLE = readFileSync(
	new URL(
		"./test-fixtures/council-review-gate/synthetic-allow-preamble.md",
		import.meta.url,
	),
	"utf8",
);
const SYNTHETIC_ALLOW_REPORT = readFileSync(
	new URL(
		"./test-fixtures/council-review-gate/synthetic-allow-report.md",
		import.meta.url,
	),
	"utf8",
);

describe("omp adapter", () => {
	it("uses an @file prompt, the review repository cwd, and the configured executable and model", () => {
		const config = getProviderConfig("omp", "review", {
			timeoutMs: 300_000,
			env: { OMP_BIN: "/opt/omp-custom", OMP_COUNCIL_MODEL: "local/reviewer" },
		});
		const promptFile = "/tmp/council-prompt.md";

		expect(config.cmd).toBe("/opt/omp-custom");
		expect(config.buildArgs(promptFile)).toEqual([
			"-p",
			"--no-tools",
			"--no-extensions",
			"--no-rules",
			"--no-skills",
			"--approval-mode",
			"always-ask",
			"--no-session",
			"--no-title",
			"--thinking",
			"medium",
			"--max-time",
			"285",
			"--model",
			"local/reviewer",
			`@${promptFile}`,
		]);
		expect(config.buildArgs(promptFile).at(-1)).toBe(`@${promptFile}`);
		expect(config.useStdin).toBe(false);
		expect(config.useTempFile).toBe(true);
		expect(config.promptAsTempFile).toBe(true);
		expect(config.cwd).toBe(process.cwd());
	});

	it("uses omp's configured default model when OMP_COUNCIL_MODEL is unset", () => {
		const config = getProviderConfig("omp", "review", { timeoutMs: 180_000, env: {} });

		expect(config.cmd).toBe("omp");
		expect(config.args).not.toContain("--model");
	});

	it("subtracts 15 seconds from the effective critic timeout", () => {
		expect(buildOmpArgs(180_000, {})).toContain("165");
	});

	it("floors --max-time at 60 seconds", () => {
		expect(buildOmpArgs(70_000, {})).toContain("60");
	});
});

describe("optional local-model preflight", () => {
	it("skips silently when neither endpoint variable is set", async () => {
		let fetchCalled = false;
		const messages = [];
		const ran = await preflightLocalModel({
			env: {},
			fetchImpl: async () => {
				fetchCalled = true;
				return new Response();
			},
			writeError: (message) => messages.push(message),
		});

		expect(ran).toBe(false);
		expect(fetchCalled).toBe(false);
		expect(messages).toEqual([]);
		expect(resolveLocalModelConfig({ env: {} })).toBeNull();
	});

	it.each(["LOCAL_MODEL_URL", "LM_STUDIO_URL"])(
		"runs when %s is explicitly set",
		async (variable) => {
			const requests = [];
			const env = { [variable]: "http://localhost:1234/v1/" };
			const ran = await preflightLocalModel({
				env,
				fetchImpl: async (url) => {
					requests.push(url);
					return new Response(JSON.stringify({ data: [{ id: "configured-model" }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				},
				writeError: () => {},
			});

			expect(ran).toBe(true);
			expect(requests).toEqual(["http://localhost:1234/v1/models"]);
		},
	);
});

describe("buildConsultCriticPrompt", () => {
	it("includes the topic and plan text verbatim", () => {
		const prompt = buildConsultCriticPrompt("My plan text", "Test topic", "codex");
		expect(prompt).toContain("Topic: Test topic");
		expect(prompt).toContain("My plan text");
		expect(prompt).toContain("Risks & flaws");
		expect(prompt).toContain("Do NOT produce an approval verdict");
	});

	it("falls back to (untitled plan) when topic is null", () => {
		const prompt = buildConsultCriticPrompt("plan", null, "codex");
		expect(prompt).toContain("Topic: (untitled plan)");
	});

	it("includes the provider specialization block as emphasis", () => {
		const prompt = buildConsultCriticPrompt("plan", "T", "codex");
		expect(prompt).toContain("Correctness and data integrity");
		expect(prompt).toContain("Apply this as your area of emphasis while advising:");
	});

	it("works for an unknown provider (no spec block)", () => {
		const prompt = buildConsultCriticPrompt("plan", "T", "unknown-provider");
		expect(prompt).toContain("Topic: T");
		expect(prompt).not.toContain("Apply this as your area of emphasis");
	});

	it("drops review-only verdict directives but keeps the grok no-tools line", () => {
		const prompt = buildConsultCriticPrompt("plan", "T", "grok");
		// Advisory mode must NOT instruct the critic to emit a verdict — it contradicts
		// "Do NOT produce an approval verdict".
		expect(prompt).not.toContain("Start your output with ALLOW or BLOCK");
		expect(prompt).not.toContain("Severity-tag each finding");
		// The no-tools line must survive into consult mode.
		expect(prompt).toContain("You have NO tools");
		expect(prompt).toContain("Do NOT produce an approval verdict");
	});

	it("drops security-review format lines in consult mode", () => {
		const prompt = buildConsultCriticPrompt("plan", "T", "opencode");
		expect(prompt).not.toContain("Start with ALLOW or BLOCK");
		expect(prompt).not.toContain("Maximum 5 findings");
		expect(prompt).toContain("Security surface analysis");
	});
});

describe("getSpecializationBlock", () => {
	it("keeps review-only verdict directives in review mode (default)", () => {
		const block = getSpecializationBlock("grok");
		expect(block).toContain("You have NO tools");
		expect(block).toContain("Start your output with ALLOW or BLOCK");
	});

	it("strips review-only directives in consult mode, keeps emphasis", () => {
		const block = getSpecializationBlock("grok", "consult");
		expect(block).toContain("You have NO tools");
		expect(block).not.toContain("Start your output with ALLOW or BLOCK");
	});

	it("resolves grok aliases to the grok persona (no-tools line) in both modes", () => {
		for (const mode of ["review", "consult"]) {
			expect(getSpecializationBlock("grok-cli", mode)).toContain("You have NO tools");
		}
	});

	it("is identical across modes for providers with no review-only lines (codex)", () => {
		expect(getSpecializationBlock("codex", "review")).toBe(
			getSpecializationBlock("codex", "consult"),
		);
	});
});

describe("parseJsonFindings", () => {
	it("extracts and normalizes a valid JSON findings block", () => {
		const output = [
			"ALLOW: looks fine but two nits",
			"- [P2] `packages/api/src/foo.ts:L42` (correctness) — off by one",
			"```json",
			'{"findings":[{"file":"packages/api/src/foo.ts","line":42,"severity":"P2","category":"correctness","description":"off by one"}]}',
			"```",
		].join("\n");
		const out = parseJsonFindings(output);
		expect(out).toEqual([
			{
				description: "off by one",
				file: "packages/api/src/foo.ts",
				lineStart: 42,
				severity: "p2",
				category: "correctness",
			},
		]);
	});

	it("normalizes severity casing and spaced categories", () => {
		const output =
			'```json\n{"findings":[{"file":"a.ts","line":"10-20","severity":"P1","category":"Error Handling","description":"x"}]}\n```';
		const [f] = parseJsonFindings(output);
		expect(f.severity).toBe("p1");
		expect(f.category).toBe("error-handling");
		expect(f.lineStart).toBe(10); // takes start of a range
	});

	it("returns an empty array (not null) when the critic reports no findings", () => {
		expect(parseJsonFindings('```json\n{"findings":[]}\n```')).toEqual([]);
	});

	it("returns null when there is no JSON block (caller falls back to prose)", () => {
		expect(parseJsonFindings("ALLOW: nothing structured here")).toBeNull();
	});

	it("returns null on malformed JSON (caller falls back to prose)", () => {
		expect(parseJsonFindings("```json\n{not valid json,,}\n```")).toBeNull();
	});

	it("prefers the last valid block when several are present", () => {
		const output = [
			'```json\n{"findings":[{"file":"old.ts","line":1,"severity":"P3","category":"correctness","description":"stale"}]}\n```',
			"some prose",
			'```json\n{"findings":[{"file":"new.ts","line":2,"severity":"P1","category":"security","description":"real"}]}\n```',
		].join("\n");
		const out = parseJsonFindings(output);
		expect(out).toHaveLength(1);
		expect(out[0].file).toBe("new.ts");
	});
});

describe("Phase-1 critic verdict parsing", () => {
	it("parses a synthetic ALLOW after an analysis preamble", () => {
		const verdict = parseCriticVerdict(SYNTHETIC_ALLOW_PREAMBLE);
		expect(verdict.decision).toBe("allow");
		expect(verdict.discrepancy).toContain("generic parser says BLOCK");
		expect(parseVerdict(reanchorCriticVerdict(SYNTHETIC_ALLOW_PREAMBLE)).decision).toBe("allow");
	});

	it("reanchors a synthetic report-style ALLOW", () => {
		const config = getProviderConfig("omp");
		const reanchored = config.parseOutput(SYNTHETIC_ALLOW_REPORT);
		expect(reanchored.startsWith("ALLOW:")).toBe(true);
		expect(parseCriticVerdict(SYNTHETIC_ALLOW_REPORT).decision).toBe("allow");
		expect(parseVerdict(reanchored).decision).toBe("allow");
	});

	it("uses the last explicit verdict line when a critic emits more than one", () => {
		const output = [
			"ALLOW: provisional assessment",
			"More analysis found a blocker.",
			"**BLOCK: final assessment after review.**",
		].join("\n");
		expect(parseCriticVerdict(output).decision).toBe("block");
		expect(reanchorCriticVerdict(output).startsWith("BLOCK:")).toBe(true);
	});

	it("tallies empty findings JSON without a BLOCK line as ALLOW", () => {
		const output = [
			"Analysis completed without a standalone verdict line.",
			"```json",
			'{"findings":[]}',
			"```",
		].join("\n");
		const verdict = parseCriticVerdict(output);
		expect(verdict.decision).toBe("allow");
		expect(verdict.discrepancy).toContain("findings imply ALLOW");
	});

	it("FAILS CLOSED when an explicit ALLOW conflicts with a P0/P1 findings blocker", () => {
		const output = [
			"Analysis preamble.",
			"ALLOW: explicit final verdict.",
			"```json",
			'{"findings":[{"severity":"P1","description":"stale draft"}]}',
			"```",
		].join("\n");
		const verdict = parseCriticVerdict(output);
		expect(verdict.decision).toBe("block");
		expect(verdict.reason).toContain("failing closed");
		expect(verdict.discrepancy).toContain("findings imply BLOCK");
	});

	it("keeps an explicit ALLOW when its findings are advisory-only (no P0/P1)", () => {
		const output = [
			"Analysis preamble.",
			"ALLOW: explicit final verdict.",
			"```json",
			'{"findings":[{"severity":"P2","description":"nit: rename var"}]}',
			"```",
		].join("\n");
		expect(parseCriticVerdict(output).decision).toBe("allow");
	});

	it("keeps a reason that ends in markdown emphasis balanced", () => {
		// The trailing `*` must stay in the reason, not be eaten by a wrapper group.
		const out = reanchorCriticVerdict("Preamble.\nALLOW: This is *critical*");
		expect(out.startsWith("ALLOW: This is *critical*")).toBe(true);
		expect(parseCriticVerdict("Preamble.\nALLOW: This is *critical*").reason).toBe(
			"ALLOW: This is *critical*",
		);
	});

	it("detects an inline verdict glued after a narration sentence", () => {
		const out = "I reviewed the diff. BLOCK: missing account filter on the records query.";
		expect(parseCriticVerdict(out).decision).toBe("block");
		expect(reanchorCriticVerdict(out).startsWith("BLOCK:")).toBe(true);
	});

	it("does not treat a mid-sentence verdict token in prose as a verdict", () => {
		// "should BLOCK:" has no sentence boundary before the token → not a standalone verdict.
		const out = "The gate should BLOCK: unsafe merges before they land on main";
		expect(reanchorCriticVerdict(out)).toBe(out);
	});

	it("derives fallback receipt counts from the same corrected critic tallies", () => {
		const fallback = synthesizeFromCritics([
			{ provider: "omp", ok: true, output: SYNTHETIC_ALLOW_PREAMBLE, durationMs: 1 },
			{
				provider: "grok",
				ok: true,
				output: 'Analysis only.\n```json\n{"findings":[]}\n```',
				durationMs: 1,
			},
		]);
		expect(fallback).toEqual({
			decision: "allow",
			reason: "ALLOW (judge unavailable — critic fallback): 2 critic(s) found no blockers",
		});
	});

	it("excludes fabricated blockers and demotes out-of-scope blockers in fallback tallies", () => {
		const fallback = synthesizeFromCritics([
			{
				provider: "codex",
				ok: true,
				output:
					'BLOCK: two blockers\n```json\n{"findings":[{"file":"missing.mjs","line":1,"severity":"P1","category":"correctness","description":"missing file"},{"file":"existing.mjs","line":99,"severity":"P0","category":"security","description":"outside diff"}]}\n```',
				durationMs: 1,
				groundedFindings: [
					{ severity: "p1", grounding: "fabricated" },
					{ severity: "p0", grounding: "out_of_scope" },
				],
			},
		]);
		expect(fallback).toEqual({
			decision: "allow",
			reason: "ALLOW (judge unavailable — critic fallback): 1 critic(s) found no blockers",
		});
	});

	it("keeps grounded P0/P1 findings blocking in fallback tallies", () => {
		const fallback = synthesizeFromCritics([
			{
				provider: "codex",
				ok: true,
				output: "ALLOW: no blockers",
				durationMs: 1,
				groundedFindings: [{ severity: "p1", grounding: "grounded" }],
			},
		]);
		expect(fallback).toMatchObject({ decision: "block" });
	});
});

describe("judge invocation failures", () => {
	it("spawns claude.exe directly on Windows-capable configs", () => {
		expect(getProviderConfig("opusjudge").noShell).toBe(true);
	});

	it("does not retry a permanent expired-OAuth failure as transient empty output", () => {
		expect(
			isJudgeTransientFailure({
				ok: false,
				output: "",
				error: "Exit 1: Failed to authenticate: OAuth session expired and could not be refreshed",
			}),
		).toBe(false);
	});

	it("normalizes Claude's exit-zero auth text into a provider failure", () => {
		expect(
			normalizeProviderFailure({
				ok: true,
				output: "Failed to authenticate: OAuth session expired and could not be refreshed",
				error: null,
			}),
		).toMatchObject({
			ok: false,
			error: "Failed to authenticate: OAuth session expired and could not be refreshed",
		});
	});

	it("short 72-char 'not logged in' output IS classified as auth failure", () => {
		expect(
			normalizeProviderFailure({
				ok: true,
				output: "You are not logged in. Please log in to continue using this service.", // 72 chars
				error: null,
			}),
		).toMatchObject({ ok: false });
	});

	it("long review containing 'not logged in' is NOT classified as auth failure", () => {
		const longReview = [
			"BLOCK: The authentication middleware has a critical flaw.",
			"",
			"In `packages/api/src/middleware/auth.ts`, the session validation does not",
			"properly handle the case where the user is not logged in but presents a valid",
			"API key. The code at line 42 checks for an active session before verifying",
			"the API key, which means that if a user was previously authenticated and then",
			"their session expired, they would be blocked even though their API key is valid.",
			"",
			"The fix should reorder the checks so that API key validation happens before",
			"session validation. This way, users with valid API keys can still access the",
			"API even if they are not logged in through a browser session.",
			"",
			"Additionally, the error message returned to the client when the user is",
			"not logged in should be more specific about whether the issue is with their",
			"session or their API key. Currently it just says 'Authentication required'",
			"which doesn't help the developer debug the issue.",
			"",
			"- [P1] `packages/api/src/middleware/auth.ts:L42` (security) — session check before API key validation",
			"- [P2] `packages/api/src/middleware/auth.ts:L58` (error-handling) — generic error message when user is not logged in",
		].join("\n");
		expect(longReview.length).toBeGreaterThan(500);
		const result = normalizeProviderFailure({ ok: true, output: longReview, error: null });
		expect(result.ok).toBe(true);
	});

	it("long review with verdict tallies correctly — auth phrases in body do not drop the review", () => {
		// A review that discusses a scenario where "the user is not logged in" should
		// still have its BLOCK verdict counted, not silently dropped as an auth failure.
		const longReview = [
			"BLOCK: Auth middleware reorders session and API key checks incorrectly.",
			"",
			"When the user is not logged in via browser but has a valid API key,",
			"the current flow rejects the request at line 42 before reaching the",
			"API key validation at line 55. This means legitimate API consumers are",
			"blocked when their session expires.",
			"",
			"The correct order should be: (1) check API key, (2) check session.",
			"If either passes, the request is authenticated. Only if both fail",
			"should the 401 response mention that the user is not logged in.",
			"",
			`- [P1] packages/api/src/middleware/auth.ts:L42 (security) — session check before API key`,
			"",
			"```json",
			'{"findings":[{"file":"packages/api/src/middleware/auth.ts","line":42,"severity":"P1","category":"security","description":"session check before API key validation"}]}',
			"```",
		].join("\n");
		expect(longReview.length).toBeGreaterThan(500);
		const result = normalizeProviderFailure({ ok: true, output: longReview, error: null });
		expect(result.ok).toBe(true);
		// The BLOCK verdict and findings are still intact — not silently dropped.
		expect(result.output).toContain("BLOCK:");
	});

	it("keeps a SHORT review carrying a verdict and findings even if it quotes an auth phrase", () => {
		const shortReview = [
			"BLOCK: session is validated before the API key is checked when the user is not logged in.",
			"```json",
			'{"findings":[{"file":"packages/api/src/middleware/auth.ts","line":42,"severity":"P1","category":"security","description":"session check before API key"}]}',
			"```",
		].join("\n");
		expect(shortReview.length).toBeLessThan(500);
		const result = normalizeProviderFailure({ ok: true, output: shortReview, error: null });
		expect(result.ok).toBe(true);
		expect(result.output).toContain("BLOCK:");
	});

	it("isJudgeAuthFailure: a non-ok expired-OAuth judge result is an auth failure", () => {
		expect(
			isJudgeAuthFailure({
				ok: false,
				output: "",
				error: "Failed to authenticate: OAuth session expired and could not be refreshed",
			}),
		).toBe(true);
	});

	it("isJudgeAuthFailure: a rendered verdict that discusses auth code is NOT an auth failure", () => {
		expect(
			isJudgeAuthFailure({
				ok: true,
				output: "## ALLOW: auth is fine even when the user is not logged in via browser",
				error: null,
			}),
		).toBe(false);
	});

	it("isJudgeAuthFailure: a non-auth infra failure is not an auth failure", () => {
		expect(isJudgeAuthFailure({ ok: false, output: "", error: "Timeout after 360000ms" })).toBe(
			false,
		);
	});

	it("claudeNeedsShell: a .exe CLAUDE_BIN override never needs a shell", () => {
		const prev = process.env.CLAUDE_BIN;
		try {
			process.env.CLAUDE_BIN = "claude-custom.exe";
			expect(claudeNeedsShell()).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.CLAUDE_BIN;
			else process.env.CLAUDE_BIN = prev;
		}
	});

	// Covers the npm-shim branch: only a claude.cmd on PATH, no
	// native claude.exe — shell-less spawn would ENOENT, so claudeNeedsShell() must flip to true.
	// win32-only (the function short-circuits to false on other platforms).
	it.skipIf(process.platform !== "win32")(
		"claudeNeedsShell: flips true when only a claude.cmd shim is on PATH (no native .exe)",
		() => {
			const dir = mkdtempSync(path.join(tmpdir(), "claude-shim-"));
			writeFileSync(path.join(dir, "claude.cmd"), "@echo off\n");
			const prevPath = process.env.PATH;
			const prevBin = process.env.CLAUDE_BIN;
			try {
				delete process.env.CLAUDE_BIN;
				process.env.PATH = dir; // only the shim dir; no claude.exe anywhere on PATH
				expect(claudeNeedsShell()).toBe(true);
			} finally {
				process.env.PATH = prevPath;
				if (prevBin === undefined) delete process.env.CLAUDE_BIN;
				else process.env.CLAUDE_BIN = prevBin;
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("isVerdictSummary", () => {
	it("drops ALLOW/BLOCK verdict lines", () => {
		expect(isVerdictSummary({ description: "ALLOW: all good", file: "a.ts", lineStart: 1 })).toBe(
			true,
		);
		expect(isVerdictSummary({ description: "BLOCK: nope", file: "a.ts", lineStart: 1 })).toBe(true);
	});

	it("drops any finding with no file (summary/observation, not actionable)", () => {
		expect(
			isVerdictSummary({ description: "No P0/P1 issues found", file: null, lineStart: 7 }),
		).toBe(true);
		expect(
			isVerdictSummary({ description: "core pattern correct", file: null, lineStart: 0 }),
		).toBe(true);
	});

	it("keeps real file-anchored findings", () => {
		expect(isVerdictSummary({ description: "off by one", file: "a.ts", lineStart: 42 })).toBe(
			false,
		);
	});
});

describe("aggregateFindings", () => {
	const jsonBlock = (findings) => `\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\``;

	it("prefers JSON findings over prose and filters verdict-summary pollution", () => {
		const results = [
			{
				provider: "codex",
				ok: true,
				output: `ALLOW: fine\nThe core pattern is correctly applied. No P0 issues.\n${jsonBlock([
					{ file: "pkg/a.ts", line: 50, severity: "P1", category: "security", description: "leak" },
				])}`,
			},
		];
		const agg = aggregateFindings(results);
		expect(agg).toHaveLength(1);
		expect(agg[0].file).toBe("pkg/a.ts");
		expect(agg[0].severity).toBe("p1");
		expect(agg[0].foundBy).toBe("codex");
	});

	it("records cross-critic agreement when two critics flag the same file:line bucket", () => {
		const results = [
			{
				provider: "codex",
				ok: true,
				output: jsonBlock([
					{ file: "pkg/a.ts", line: 50, severity: "P1", category: "security", description: "leak" },
				]),
			},
			{
				provider: "review-b",
				ok: true,
				output: jsonBlock([
					{
						file: "pkg/a.ts",
						line: 53,
						severity: "P1",
						category: "security",
						description: "same leak",
					},
				]),
			},
		];
		const agg = aggregateFindings(results);
		expect(agg).toHaveLength(1);
		expect(agg[0].foundBy).toBe("codex");
		expect(agg[0].agreedBy).toContain("review-b");
	});

	it("falls back to prose extraction for critics with no JSON block", () => {
		const results = [
			{
				provider: "omp",
				ok: true,
				output: "BLOCK: bad\n- [P0] `pkg/b.ts:L12` (database) — missing account filter",
			},
		];
		const agg = aggregateFindings(results);
		expect(agg).toHaveLength(1);
		expect(agg[0].file).toBe("pkg/b.ts");
		expect(agg[0].severity).toBe("p0");
	});

	it("skips failed critics", () => {
		const results = [{ provider: "review-c", ok: false, output: "", error: "timeout" }];
		expect(aggregateFindings(results)).toEqual([]);
	});
});

describe("cross-examination round", () => {
	function makeFinding(overrides = {}) {
		return {
			description: "Default finding",
			file: "src/default.mjs",
			lineStart: 10,
			severity: "p1",
			category: "correctness",
			foundBy: "codex",
			grounding: "grounded",
			...overrides,
		};
	}

	it("builds stable prompts from peer findings and excludes own or fabricated findings", () => {
		const numbered = numberDebateFindings([
			makeFinding({ description: "Codex finding", file: "src/a.mjs", foundBy: "codex" }),
			makeFinding({ description: "Fabricated", file: "missing.mjs", grounding: "fabricated" }),
			makeFinding({ description: "Grok finding", file: "src/b.mjs", foundBy: "grok" }),
			makeFinding({
				description: "Claude finding with\nwrapped detail",
				file: "src/c.mjs",
				foundBy: "claude",
				grounding: "out_of_scope",
			}),
		]);
		const codexPrompt = buildRebuttalPrompt("codex", numbered);
		const grokPrompt = buildRebuttalPrompt("grok", numbered);

		expect(codexPrompt).not.toContain("Codex finding");
		expect(codexPrompt).not.toContain("Fabricated");
		expect(codexPrompt).toContain("#2 [p1] src/b.mjs:10 (correctness) — Grok finding");
		expect(codexPrompt).toContain(
			"#3 [p1] src/c.mjs:10 (correctness) — Claude finding with wrapped detail",
		);
		expect(grokPrompt).toContain("#1 [p1] src/a.mjs:10 (correctness) — Codex finding");
		expect(grokPrompt).toContain("#3 [p1] src/c.mjs:10 (correctness)");
		expect(grokPrompt).not.toContain("Grok finding");
	});

	it("parses valid JSON and tolerates a fenced response", () => {
		expect(
			parseRebuttalVotes(
				'```json\n{"votes":[{"finding":2,"vote":"refute","reason":"guard exists"}]}\n```',
				[2],
			),
		).toEqual([{ finding: 2, vote: "refute", reason: "guard exists" }]);
	});

	it("returns no votes for malformed whole output", () => {
		expect(parseRebuttalVotes('{"votes":[', [1])).toEqual([]);
	});

	it("drops malformed individual votes, duplicates, and unknown finding numbers", () => {
		const output = JSON.stringify({
			votes: [
				{ finding: 1, vote: "endorse", reason: "matches the code" },
				{ finding: 1, vote: "refute", reason: "duplicate" },
				{ finding: 2, vote: "maybe", reason: "bad enum" },
				{ finding: 99, vote: "unsure", reason: "unknown number" },
				{ finding: 3, vote: "unsure", reason: "" },
				{ finding: 3, vote: "unsure", reason: { detail: "not one line" } },
			],
		});
		expect(parseRebuttalVotes(output, [1, 2, 3])).toEqual([
			{ finding: 1, vote: "endorse", reason: "matches the code" },
		]);
	});

	it("aggregates critic identities and reasons onto findings", () => {
		const numbered = numberDebateFindings([
			makeFinding({ description: "Peer finding", foundBy: "codex" }),
			makeFinding({ description: "Second peer finding", foundBy: "grok", lineStart: 30 }),
		]);
		const findings = aggregateDebateVotes(numbered, [
			{
				critic: "grok",
				votes: [{ finding: 1, vote: "refute", reason: "guard exists two lines above" }],
			},
			{
				critic: "claude",
				votes: [
					{ finding: 1, vote: "endorse", reason: "reproduced" },
					{ finding: 2, vote: "unsure", reason: "needs runtime evidence" },
				],
			},
		]);

		expect(findings[0]).toMatchObject({
			endorsedBy: ["claude"],
			refutedBy: ["grok"],
			unsureBy: [],
			voteReasons: {
				claude: "reproduced",
				grok: "guard exists two lines above",
			},
		});
		expect(findings[1].unsureBy).toEqual(["claude"]);
		expect(tallyDebateFindings(findings)).toEqual({ endorsed: 1, refuted: 1, unsureOnly: 1 });
	});

	it("renders compact vote evidence and the non-ballot instruction for the judge", () => {
		const numbered = numberDebateFindings([
			makeFinding({
				description: "Missing validation",
				endorsedBy: ["grok"],
				refutedBy: ["codex"],
				unsureBy: [],
				voteReasons: { grok: "confirmed", codex: "guard exists two lines above" },
			}),
		]);
		const section = buildDebateJudgeSection(numbered);

		expect(section).toContain("endorsed by: grok");
		expect(section).toContain('refuted by: codex ("guard exists two lines above")');
		expect(section).toContain("Cross-family endorsement is strong corroboration");
		expect(section).toContain("Votes are evidence pointers, not a ballot");
	});

	it("enables by tier or force flag, lets --no-debate win, and skips with one producer", () => {
		expect(shouldRunDebate("CRITICAL", null, 2)).toBe(true);
		expect(shouldRunDebate("STANDARD", true, 2)).toBe(true);
		expect(shouldRunDebate("CRITICAL", false, 3)).toBe(false);
		expect(shouldRunDebate("CRITICAL", null, 1)).toBe(false);
		expect(shouldRunDebate("STANDARD", null, 3)).toBe(false);
	});

	it("parses debate flags with --no-debate taking precedence", () => {
		expect(parseArgs(["--debate"]).debate).toBe(true);
		expect(parseArgs(["--no-debate"]).debate).toBe(false);
		expect(parseArgs(["--debate", "--no-debate"]).debate).toBe(false);
		expect(parseArgs([]).debate).toBeNull();
	});
});

describe("writeConsultLog", () => {
	it("includes topic in meta.json", () => {
		const runDir = writeConsultLog({
			topic: "Test topic for meta",
			planPath: path.join(tmpdir(), "test-plan.md"),
			critics: ["codex"],
			timings: { codex: 1200 },
			planCharCount: 42,
			advisorOutputs: [{ provider: "codex", ok: true, output: "codex advisory", error: null }],
			chairOutput: "chair synthesis text",
		});
		expect(runDir).toBeTruthy();
		const meta = JSON.parse(readFileSync(path.join(runDir, "meta.json"), "utf8"));
		expect(meta.topic).toBe("Test topic for meta");
		expect(meta.critics).toEqual(["codex"]);
		expect(meta.planCharCount).toBe(42);
		// Cleanup
		try {
			rmSync(runDir, { recursive: true, force: true });
		} catch {}
	});

	it("falls back to (untitled plan) when topic is null", () => {
		const runDir = writeConsultLog({
			topic: null,
			planPath: "/tmp/plan.md",
			critics: [],
			timings: {},
			planCharCount: 0,
			advisorOutputs: [],
			chairOutput: "",
		});
		expect(runDir).toBeTruthy();
		const meta = JSON.parse(readFileSync(path.join(runDir, "meta.json"), "utf8"));
		expect(meta.topic).toBe("(untitled plan)");
		// Cleanup
		try {
			rmSync(runDir, { recursive: true, force: true });
		} catch {}
	});

	it("writes chair-synthesis.md with the provided output", () => {
		const runDir = writeConsultLog({
			topic: "synthesis check",
			planPath: "/tmp/plan.md",
			critics: ["codex"],
			timings: {},
			planCharCount: 10,
			advisorOutputs: [],
			chairOutput: "THE SYNTHESIS",
		});
		expect(runDir).toBeTruthy();
		const synthesis = readFileSync(path.join(runDir, "chair-synthesis.md"), "utf8");
		expect(synthesis).toBe("THE SYNTHESIS");
		// Cleanup
		try {
			rmSync(runDir, { recursive: true, force: true });
		} catch {}
	});
});

// Contaminated providers that have code-review framing in their buildArgs wrapper text.
// In consult mode, none of their wrapper strings may contain review-specific terms.
const REVIEW_TERMS = ["code review", "diff", "ALLOW", "BLOCK", "verdict", "shipping blocker"];
const CONTAMINATED_PROVIDERS = ["omp", "grok", "opencode"];

describe("getProviderConfig consult mode — no code-review framing in wrapper text", () => {
	for (const provider of CONTAMINATED_PROVIDERS) {
		it(`${provider}: wrapper text contains no review-specific terms in consult mode`, () => {
			const config = getProviderConfig(provider, "consult");
			expect(config).toBeTruthy();

			if (config.buildArgs) {
				// buildArgs takes a tempFilePath and returns the args array.
				const args = config.buildArgs("/tmp/test-plan.md");
				const argsText = args.join(" ");
				for (const term of REVIEW_TERMS) {
					expect(argsText.toLowerCase()).not.toContain(term.toLowerCase());
				}
			}
		});

		it(`${provider}: review mode wrapper text is unchanged (default path)`, () => {
			const reviewConfig = getProviderConfig(provider, "review");
			const defaultConfig = getProviderConfig(provider);
			expect(reviewConfig).toBeTruthy();
			expect(defaultConfig).toBeTruthy();

			if (reviewConfig.buildArgs && defaultConfig.buildArgs) {
				const reviewArgs = reviewConfig.buildArgs("/tmp/x.md").join(" ");
				const defaultArgs = defaultConfig.buildArgs("/tmp/x.md").join(" ");
				// Default (no mode arg) must be byte-identical to explicit "review" mode.
				expect(defaultArgs).toBe(reviewArgs);
			}
		});
	}
});

describe("getProviderConfig consult mode — twoPass disabled", () => {
	it("opencode twoPass is false in consult mode", () => {
		const config = getProviderConfig("opencode", "consult");
		expect(config).toBeTruthy();
		expect(config.twoPass).toBe(false);
	});

	it("opencode twoPass is true in review mode (default path unchanged)", () => {
		const config = getProviderConfig("opencode", "review");
		expect(config).toBeTruthy();
		expect(config.twoPass).toBe(true);
	});
});

describe("consult mode does not reanchor advisory verdicts", () => {
	const advisory = "Option A is safer.\nALLOW: prefer A here\nOption B trades speed for risk.";

	for (const provider of ["omp", "grok"]) {
		it(`${provider}: consult parseOutput passes the advisory through untouched`, () => {
			const config = getProviderConfig(provider, "consult");
			expect(config.parseOutput(advisory)).toBe(advisory);
		});

		it(`${provider}: review parseOutput still reanchors the verdict to the top`, () => {
			const config = getProviderConfig(provider, "review");
			expect(config.parseOutput(advisory).startsWith("ALLOW: prefer A here")).toBe(true);
		});
	}
});

describe("parseVerdict (fail-closed)", () => {
	it('recognizes a "## BLOCK:" markdown heading as a block', () => {
		const v = parseVerdict("## BLOCK: corroborator overlap veto is wrong\n\nDetails here.");
		expect(v.decision).toBe("block");
	});

	it('recognizes a "## ALLOW:" markdown heading as an allow', () => {
		const v = parseVerdict("## ALLOW: looks good, ship it\n\nNice work.");
		expect(v.decision).toBe("allow");
	});

	it('recognizes a trailing {"decision":"block"} JSON line as a block', () => {
		const v = parseVerdict('Some prose.\n{"decision":"block","reason":"money path unsafe"}');
		expect(v.decision).toBe("block");
		expect(v.reason).toContain("money path unsafe");
	});

	it('recognizes a trailing {"decision":"allow"} JSON line as an allow', () => {
		const v = parseVerdict('Some prose.\n{"decision":"allow","reason":"clean"}');
		expect(v.decision).toBe("allow");
	});

	it("parses a heading plus trailing JSON as block", () => {
		const judge = [
			"## BLOCK: cache refresh can overwrite newer data",
			"",
			"The refresh compares timestamps incorrectly, so an older response can win.",
			"",
			'{"decision":"block","reason":"timestamp comparison allows a stale write"}',
		].join("\n");
		const v = parseVerdict(judge);
		expect(v.decision).toBe("block");
	});

	it("prefers the explicit JSON decision over a disagreeing heading", () => {
		const v = parseVerdict('## ALLOW: looks fine\n\n{"decision":"block","reason":"actually not"}');
		expect(v.decision).toBe("block");
	});

	it("is case/whitespace tolerant on the JSON decision", () => {
		const v = parseVerdict('intro\n   {"decision":"BLOCK","reason":"x"}   ');
		expect(v.decision).toBe("block");
	});

	it("FAILS CLOSED (block) on empty output", () => {
		expect(parseVerdict("").decision).toBe("block");
		expect(parseVerdict("   \n  ").decision).toBe("block");
	});

	it("FAILS CLOSED (block) on garbage with no recognizable verdict", () => {
		const v = parseVerdict("the judge rambled but never rendered a verdict line");
		expect(v.decision).toBe("block");
		expect(v.reason.toLowerCase()).toContain("failing closed");
	});

	it("FAILS CLOSED (block) on a {decision:...} line with an unknown value", () => {
		const v = parseVerdict('{"decision":"maybe","reason":"unsure"}');
		expect(v.decision).toBe("block");
	});
});

describe("parseVerdict (block-first edge cases)", () => {
	// [codex P1] An example/quoted {"decision":"allow"} must NEVER override a
	// real "## BLOCK:" heading — block-first wins.
	it("a block heading is NOT overridden by a trailing allow-example JSON", () => {
		const judge = [
			"## BLOCK: the real verdict — money path unsafe",
			"The reviewed diff itself contained example test data:",
			'{"decision":"allow"}',
		].join("\n");
		expect(parseVerdict(judge).decision).toBe("block");
	});

	// [codex P1] A {"decision":"allow"} embedded mid-sentence (the line does not
	// start with "{") is not a standalone verdict line and must be ignored →
	// fail-closed here. (A standalone JSON line followed by a sign-off IS trusted;
	// that is covered in the "final parser round" block below.)
	it("ignores a {decision} embedded mid-sentence — not standalone (fail-closed)", () => {
		const judge = [
			"Some analysis of the diff.",
			'The reviewed code literally contained {"decision":"allow"} as test data.',
			"...but the judge never rendered its own standalone verdict line.",
		].join("\n");
		expect(parseVerdict(judge).decision).toBe("block");
	});

	// [codex P1] A code-fenced {"decision":"allow"} (e.g. format example, or the
	// quoted diff) must not be treated as the verdict → fail-closed here.
	it("ignores a code-fenced allow JSON example (fail-closed)", () => {
		const judge = [
			"Emit your verdict in this format:",
			"```json",
			'{"decision":"allow"}',
			"```",
		].join("\n");
		expect(parseVerdict(judge).decision).toBe("block");
	});

	it("a real block heading wins even with a fenced allow JSON example", () => {
		const judge = ["## BLOCK: unsafe", "```json", '{"decision":"allow"}', "```"].join("\n");
		expect(parseVerdict(judge).decision).toBe("block");
	});

	// [codex P2] review_summary formatted as a "## ALLOW:" heading must read as
	// ALLOW, not fall through to the fail-closed default.
	it("structured review_summary '## ALLOW:' reads as allow (no false block)", () => {
		const envelope = JSON.stringify({
			output: { review_summary: "## ALLOW: looks good, ship it" },
		});
		expect(parseVerdict(envelope).decision).toBe("allow");
	});

	it("structured review_summary '## BLOCK:' reads as block", () => {
		const envelope = JSON.stringify({
			output: { review_summary: "## BLOCK: missing account filter", blocking_issues: ["x"] },
		});
		expect(parseVerdict(envelope).decision).toBe("block");
	});

	// [codex P2] An all-ALLOW drafts envelope must read as ALLOW, not fall through
	// to the fail-closed default.
	it("an all-ALLOW drafts envelope reads as allow (no false block)", () => {
		const envelope = JSON.stringify({
			drafts: { codex: "ALLOW: fine", grok: "ALLOW: ok" },
		});
		expect(parseVerdict(envelope).decision).toBe("allow");
	});

	it("one BLOCK draft among allows makes the whole verdict block", () => {
		const envelope = JSON.stringify({
			drafts: { codex: "ALLOW: fine", grok: "BLOCK: security hole" },
		});
		expect(parseVerdict(envelope).decision).toBe("block");
	});

	// Details are sliced from the heading's true index even when
	// earlier prose lines are duplicated.
	it("slices block details from after the heading with duplicate prose lines", () => {
		const judge = ["preamble", "preamble", "## BLOCK: real problem", "detail A", "detail B"].join(
			"\n",
		);
		const v = parseVerdict(judge);
		expect(v.decision).toBe("block");
		expect(v.details).toBe("detail A\ndetail B");
	});
});

describe("parseVerdict (final parser round)", () => {
	// A bare "BLOCK:" in a judge's BODY must not block, but a
	// critic's bare verdict (its output MUST BEGIN with BLOCK:/ALLOW:) must still
	// classify. So: bare prefix counts only as the first content line OR a real
	// markdown heading; bare prefix in the body is ignored.
	it("a critic-style bare 'ALLOW:' first line reads as allow", () => {
		const critic = ["ALLOW: clean, no blocking issues", "- [P3] minor nit in a comment"].join("\n");
		expect(parseVerdict(critic).decision).toBe("allow");
	});

	it("a critic-style bare 'BLOCK:' first line reads as block", () => {
		const critic = ["BLOCK: P1 missing account filter", "- [P1] handler leaks rows"].join("\n");
		expect(parseVerdict(critic).decision).toBe("block");
	});

	it("a bare 'BLOCK:' in the judge BODY does NOT block an ALLOW verdict", () => {
		const judge = [
			"## ALLOW: looks good",
			"Verified findings:",
			"BLOCK: <a dismissed critic finding> — false positive, not a real blocker",
			'{"decision":"allow","reason":"clean"}',
		].join("\n");
		expect(parseVerdict(judge).decision).toBe("allow");
	});

	it("a real '## BLOCK:' heading still blocks even with the same body", () => {
		const judge = [
			"## BLOCK: real money-path blocker",
			"Verified findings:",
			"BLOCK: <a dismissed critic finding>",
			'{"decision":"block","reason":"unsafe"}',
		].join("\n");
		expect(parseVerdict(judge).decision).toBe("block");
	});

	// A standalone {"decision":...} JSON line is trusted even
	// when followed by a prose sign-off; only mid-sentence embeds are ignored.
	it("trusts a standalone allow JSON even with a trailing prose sign-off", () => {
		const judge = [
			"## ALLOW: looks good",
			'{"decision":"allow","reason":"clean"}',
			"Let me know if you'd like more detail.",
		].join("\n");
		expect(parseVerdict(judge).decision).toBe("allow");
	});

	it("trusts a standalone block JSON even with a trailing prose sign-off", () => {
		const judge = [
			"## BLOCK: unsafe money path",
			'{"decision":"block","reason":"x"}',
			"Happy to re-review after the fix.",
		].join("\n");
		expect(parseVerdict(judge).decision).toBe("block");
	});
});

describe("buildJudgeInstructions — canonical verdict format", () => {
	const prompt = buildJudgeInstructions("/tmp/diff.patch", [
		{ name: "Codex", specialty: "correctness", verdict: "BLOCK", file: "/tmp/codex.md" },
	]);

	it("instructs a `## ALLOW:` / `## BLOCK:` markdown heading", () => {
		expect(prompt).toContain("## ALLOW:");
		expect(prompt).toContain("## BLOCK:");
	});

	it('requires a trailing standalone {"decision":...} JSON line', () => {
		expect(prompt).toContain('{"decision":"allow"');
		expect(prompt).toContain('{"decision":"block"');
		expect(prompt.toLowerCase()).toContain("last line");
	});
});

describe("critic reliability prompt", () => {
	const richReliability = {
		codex: {
			all: {
				findings: 5,
				confirmed: 3,
				rejected: 2,
				fabricated: 0,
				confirmationRate: 0.6,
			},
		},
	};

	it("injects the reliability section when samples are sufficient", () => {
		const reliability = buildReliabilityPromptSection(richReliability, {
			lastRuns: 30,
			minSamples: 5,
			quarantineWarnings: ["codex"],
		});
		const prompt = buildJudgeInstructions(
			"/tmp/diff.patch",
			[{ name: "codex", specialty: "correctness", verdict: "BLOCK", file: "/tmp/codex.md" }],
			undefined,
			false,
			reliability,
		);

		expect(prompt).toContain("## Critic reliability (last 30 runs, this repository)");
		expect(prompt).toContain("60% (3/5)");
		expect(prompt).toContain("Degraded seat(s): codex");
		expect(prompt).toContain("This is context, not a verdict");
	});

	it("omits the reliability section when samples are thin", () => {
		const thinReliability = {
			codex: {
				all: {
					findings: 4,
					confirmed: 4,
					rejected: 0,
					fabricated: 0,
					confirmationRate: 1,
				},
			},
		};
		const reliability = buildReliabilityPromptSection(thinReliability, { minSamples: 5 });
		const prompt = buildJudgeInstructions("/tmp/diff.patch", [], undefined, false, reliability);

		expect(reliability).toBe("");
		expect(prompt).not.toContain("Critic reliability");
	});
});

describe("run metadata", () => {
	it("records quarantineWarnings while excluding full outputs", () => {
		expect(
			toLogMetadata({
				timestamp: "2026-07-31T00:00:00.000Z",
				quarantineWarnings: ["codex"],
				debate: true,
				debateTallies: { endorsed: 2, refuted: 1, unsureOnly: 0 },
				criticFullOutputs: [{ provider: "codex", output: "review" }],
				judgeFullOutput: { output: "verdict" },
			}),
		).toEqual({
			timestamp: "2026-07-31T00:00:00.000Z",
			quarantineWarnings: ["codex"],
			debate: true,
			debateTallies: { endorsed: 2, refuted: 1, unsureOnly: 0 },
		});
	});
});

describe("parseVerdict — money-PR preamble regression (judge follows the new format)", () => {
	// The real false-block: the judge opened with a synthesis preamble, then a verdict.
	// With the strengthened prompt the judge now emits a `## ALLOW:` heading + a trailing
	// JSON line even after a preamble — that MUST parse as allow.
	it("preamble + `## ALLOW:` heading + trailing allow JSON reads as allow", () => {
		const judge = [
			"I've verified the flagged area thoroughly. Here is my synthesis.",
			"",
			"## ALLOW: documented opt-in back-compat, binding floor intact",
			"",
			"### Verified Findings",
			"Codex P1 — DISMISSED: strictly additive.",
			"",
			'{"decision":"allow","reason":"documented opt-in back-compat; binding floor intact"}',
		].join("\n");
		expect(parseVerdict(judge).decision).toBe("allow");
	});

	// Proof we did NOT loosen parseVerdict: the ORIGINAL failing shape (preamble + a bare
	// `ALLOW:` with no `##` heading and no trailing JSON) must STILL fail closed.
	it("preamble + bare `ALLOW:` (no heading, no JSON) still FAILS CLOSED (block)", () => {
		const judge = [
			"I've verified the flagged area thoroughly. Here is my synthesis.",
			"",
			"ALLOW: the sole P1 is documented opt-in back-compat",
		].join("\n");
		expect(parseVerdict(judge).decision).toBe("block");
	});
});

describe("parseVerdict — VERIFIED/UNVERIFIED suffix tolerance", () => {
	it("parses BLOCK with verified/unverified suffix correctly", () => {
		// When a JSON line is present, its reason takes precedence over the heading.
		// Test with the VERIFIED/UNVERIFIED suffix in both heading and JSON.
		const judge = [
			"## BLOCK: cache refresh can overwrite newer data [2 verified, 1 unverified]",
			"",
			"### Verified Findings",
			"P0 — VERIFIED: timestamp comparison at `src/cache.ts:L42` allows stale write.",
			"",
			'{"decision":"block","reason":"cache refresh can overwrite newer data [2 verified, 1 unverified]"}',
		].join("\n");
		const v = parseVerdict(judge);
		expect(v.decision).toBe("block");
		expect(v.reason).toContain("[2 verified, 1 unverified]");
	});

	it("parses ALLOW with suffix unchanged", () => {
		const judge = [
			"## ALLOW: no blocking issues found [0 verified, 0 unverified]",
			'{"decision":"allow","reason":"clean"}',
		].join("\n");
		const v = parseVerdict(judge);
		expect(v.decision).toBe("allow");
	});

	it("parses plain BLOCK without suffix the same as before", () => {
		const judge = [
			"## BLOCK: missing account filter",
			'{"decision":"block","reason":"missing account filter"}',
		].join("\n");
		const v = parseVerdict(judge);
		expect(v.decision).toBe("block");
		expect(v.reason).toBe("BLOCK: missing account filter");
	});

	it("parses plain ALLOW without suffix the same as before", () => {
		const judge = [
			"## ALLOW: looks good, ship it",
			'{"decision":"allow","reason":"clean"}',
		].join("\n");
		const v = parseVerdict(judge);
		expect(v.decision).toBe("allow");
	});
});

describe("buildJudgeInstructions — VERIFIED/UNVERIFIED contract", () => {
	const prompt = buildJudgeInstructions("/tmp/diff.patch", [
		{ name: "Codex", specialty: "correctness", verdict: "BLOCK", file: "/tmp/codex.md" },
	]);

	it("includes VERIFIED/UNVERIFIED labeling instructions", () => {
		expect(prompt).toContain("VERIFIED");
		expect(prompt).toContain("UNVERIFIED");
		expect(prompt).toContain("you MUST label");
	});

	it("includes verdict suffix format", () => {
		expect(prompt).toContain("[2 verified, 1 unverified]");
	});

	it("does NOT include Bash-tier suggestions when bashTier is false (default)", () => {
		expect(prompt).not.toContain("Verification Tools (Bash tier");
		expect(prompt).not.toContain("You have access to Bash");
	});

	it("includes STANDARD-tier search instructions when bashTier is false", () => {
		expect(prompt).toContain("Verification Tools (STANDARD tier");
		expect(prompt).toContain("Grep and Glob");
	});
});

describe("buildJudgeInstructions — Bash tier suggestions", () => {
	const prompt = buildJudgeInstructions("/tmp/diff.patch", [
		{ name: "Codex", specialty: "correctness", verdict: "BLOCK", file: "/tmp/codex.md" },
	], undefined, true);

	it("includes Bash-tier verification suggestions", () => {
		expect(prompt).toContain("Verification Tools (Bash tier");
		expect(prompt).toContain("You have access to Bash");
		expect(prompt).toContain("Run the project's test command");
		expect(prompt).toContain("Grep for the pattern");
	});

	it("does NOT include STANDARD-tier search instructions", () => {
		expect(prompt).not.toContain("Verification Tools (STANDARD tier");
	});

	it("includes verified/unverified labeling", () => {
		expect(prompt).toContain("VERIFIED");
		expect(prompt).toContain("UNVERIFIED");
	});
});

describe("resolveJudgeTools", () => {
	it("returns Read only for DOCS", () => {
		expect(resolveJudgeTools("DOCS")).toEqual(["Read"]);
	});

	it("returns Read,Grep,Glob for STANDARD", () => {
		expect(resolveJudgeTools("STANDARD")).toEqual(["Read", "Grep", "Glob"]);
	});

	it("returns Read,Grep,Glob,Bash for CRITICAL with judgeCanExecute=true", () => {
		expect(resolveJudgeTools("CRITICAL", true)).toEqual(["Read", "Grep", "Glob", "Bash"]);
	});

	it("returns Read,Grep,Glob for CRITICAL with judgeCanExecute=false", () => {
		expect(resolveJudgeTools("CRITICAL", false)).toEqual(["Read", "Grep", "Glob"]);
	});
});
