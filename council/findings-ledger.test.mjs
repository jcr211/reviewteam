import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { backfillLedger } from "./backfill-ledger.mjs";
import {
	appendRunToLedger,
	buildLedgerRecords,
	computeFingerprint,
	parseFindings,
	validateLedgerRecord,
} from "./findings-ledger.mjs";

function makeRun(overrides = {}) {
	return {
		ts: "2026-07-27T00:00:00.000Z",
		runId: "run-1",
		branch: "feat/ledger",
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
		verdict: { decision: "allow" },
		critics: [
			{
				provider: "codex",
				findings: [
					{
						file: "scripts/example.mjs",
						line: 42,
						severity: "P1",
						category: "correctness",
						description: "The parser drops valid records",
					},
				],
			},
		],
		judgeOutput: "",
		...overrides,
	};
}

describe("computeFingerprint", () => {
	test("is deterministic across punctuation and stop words", () => {
		expect(computeFingerprint("a.ts", "correctness", "The parser—is in a loop!")).toBe(
			computeFingerprint("a.ts", "correctness", "parser is, the LOOP"),
		);
	});

	test("uses only the first eight remaining tokens", () => {
		const eight = "one two three four five six seven eight";
		expect(computeFingerprint("a.ts", "other", `${eight} nine ten`)).toBe(
			computeFingerprint("a.ts", "other", `${eight} changed tail`),
		);
	});

	test("preserves unicode alphanumerics while collapsing punctuation", () => {
		expect(computeFingerprint("a.ts", "other", "Résumé—CAFÉ")).toBe(
			computeFingerprint("a.ts", "other", "résumé café"),
		);
	});
});

describe("ledger records", () => {
	test("emits the frozen strict shape and rejects extras", () => {
		const [record] = buildLedgerRecords(makeRun());
		expect(validateLedgerRecord(record)).toBe(true);
		expect(validateLedgerRecord({ ...record, extra: true })).toBe(false);
		expect(Object.keys(record)).toHaveLength(15);
	});

	test("records cross-examination vote arrays additively", () => {
		const [record] = buildLedgerRecords(
			makeRun({
				critics: [
					{
						provider: "codex",
						findings: [
							{
								file: "scripts/example.mjs",
								line: 42,
								severity: "P1",
								category: "correctness",
								description: "The parser drops valid records",
								endorsedBy: ["grok", "grok"],
								refutedBy: ["claude"],
								unsureBy: [],
							},
						],
					},
				],
			}),
		);

		expect(record).toMatchObject({
			critic: "codex",
			endorsedBy: ["grok"],
			refutedBy: ["claude"],
			unsureBy: [],
		});
		expect(validateLedgerRecord(record)).toBe(true);
		expect(validateLedgerRecord({ ...record, endorsedBy: ["grok", "grok"] })).toBe(false);
	});

	test("records line verification additively", () => {
		const [record] = buildLedgerRecords(
			makeRun({
				critics: [
					{
						provider: "codex",
						findings: [
							{
								file: "scripts/example.mjs",
								line: 9999,
								severity: "P1",
								category: "correctness",
								description: "The parser drops valid records",
								grounding: "grounded",
								lineVerified: false,
							},
						],
					},
				],
			}),
		);

		expect(record).toMatchObject({ grounding: "grounded", lineVerified: false });
		expect(validateLedgerRecord(record)).toBe(true);
		expect(validateLedgerRecord({ ...record, lineVerified: "false" })).toBe(false);
	});

	test("handles every judge disposition conservatively", () => {
		const confirmed = buildLedgerRecords(
			makeRun({
				judgeOutput:
					'```json\n{"findings":[{"file":"scripts/example.mjs","line":50,"severity":"P2","category":"correctness","description":"Judge confirms parser defect"}]}\n```',
			}),
		);
		expect(confirmed.find((record) => record.critic === "codex")?.judgeDisposition).toBe(
			"confirmed",
		);
		expect(confirmed.find((record) => record.critic === "judge")?.judgeDisposition).toBe(
			"confirmed",
		);
		expect(
			buildLedgerRecords(
				makeRun({
					judgeOutput:
						"DISMISSED as a false positive: scripts/example.mjs does not drop valid parser records.",
				}),
			)[0].judgeDisposition,
		).toBe("dismissed");
		expect(
			buildLedgerRecords(makeRun({ judgeOutput: "## ALLOW: no blockers." }))[0].judgeDisposition,
		).toBe("unaddressed");
		expect(
			buildLedgerRecords(
				makeRun({
					judgeOutput:
						"### Verified Findings\n**Codex `scripts/example.mjs:42` (correctness) — CONFIRMED, non-blocking.**",
				}),
			)[0].judgeDisposition,
		).toBe("confirmed");
		expect(buildLedgerRecords(makeRun())[0].judgeDisposition).toBeNull();
	});

	test("requires claim overlap before applying a file-scoped dismissal", () => {
		const records = buildLedgerRecords(
			makeRun({
				critics: [
					{
						provider: "codex",
						findings: [
							{
								file: "scripts/example.mjs",
								line: 42,
								severity: "P1",
								category: "correctness",
								description: "The parser drops valid records",
							},
							{
								file: "scripts/example.mjs",
								line: 90,
								severity: "P2",
								category: "correctness",
								description: "The writer loses concurrent appends",
							},
						],
					},
				],
				judgeOutput:
					"Codex claim that scripts/example.mjs drops valid parser records is DISMISSED as a false positive.",
			}),
		);
		expect(records.map((record) => record.judgeDisposition)).toEqual(["dismissed", "unaddressed"]);
	});

	test("recognizes explicit verified confirmations without making them judge findings", () => {
		const records = buildLedgerRecords(
			makeRun({
				judgeOutput:
					"### Verified Findings\n**Codex [P1] `scripts/example.mjs:42` (correctness) — parser drops valid records — CONFIRMED.**",
			}),
		);
		expect(records).toHaveLength(1);
		expect(records[0].judgeDisposition).toBe("confirmed");
	});

	test("prefers attributed aggregate findings and expands critic agreement occurrences", () => {
		const records = buildLedgerRecords(
			makeRun({
				critics: [
					{ provider: "codex", output: "unparseable prose" },
					{ provider: "grok", output: "" },
				],
				aggregatedFindings: [
					{
						file: "scripts/aggregate.mjs",
						lineStart: 14,
						severity: "p1",
						category: "correctness",
						description: "Aggregate truth is retained",
						foundBy: "codex",
						agreedBy: ["grok", "grok"],
					},
				],
			}),
		);
		expect(records.map((record) => record.critic)).toEqual(["codex", "grok"]);
		expect(records.every((record) => record.title === "Aggregate truth is retained")).toBe(true);
	});

	test("retains distinct raw findings when an aggregate is available", () => {
		const records = buildLedgerRecords(
			makeRun({
				critics: [
					{
						provider: "codex",
						output:
							'```json\n{"findings":[{"file":"scripts/aggregate.mjs","line":14,"severity":"P1","category":"correctness","description":"Aggregate truth is retained"},{"file":"scripts/aggregate.mjs","line":18,"severity":"P2","category":"correctness","description":"Nearby distinct truth is retained"}]}\n```',
					},
				],
				aggregatedFindings: [
					{
						file: "scripts/aggregate.mjs",
						lineStart: 14,
						severity: "p1",
						category: "correctness",
						description:
							"- [P1] `scripts/aggregate.mjs:L14` (correctness) — Aggregate truth is retained",
						foundBy: "codex",
						agreedBy: [],
					},
				],
			}),
		);
		expect(records.map((record) => record.title)).toEqual([
			"Aggregate truth is retained",
			"Nearby distinct truth is retained",
		]);
	});

	test("does not treat the judge's review of critic findings as judge-originated findings", () => {
		const records = buildLedgerRecords(
			makeRun({
				judgeOutput:
					"### Verified Findings\n**Codex [P1] `scripts/example.mjs:42` (correctness) — DISMISSED as a false positive.**",
			}),
		);
		expect(records).toHaveLength(1);
		expect(records[0].critic).toBe("codex");
		expect(records[0].judgeDisposition).toBe("dismissed");
	});

	test("does not cross-confirm an unrelated judge discovery in the same file and category", () => {
		const records = buildLedgerRecords(
			makeRun({
				judgeOutput:
					"### Deep-Dive Discoveries\n- [P2] `scripts/example.mjs:L99` (correctness) — A completely unrelated cache defect.",
			}),
		);
		expect(records.find((record) => record.critic === "codex")?.judgeDisposition).toBe(
			"unaddressed",
		);
	});

	test("preserves long extensions, line numbers, and later em dashes in prose findings", () => {
		const records = buildLedgerRecords(
			makeRun({
				critics: [
					{
						provider: "grok",
						output:
							"- [P1] `src/dashboard/App.tsx:L42` (correctness) — account filter missing — data crosses account boundaries\n- [P2] `src/api/config.json:L7` (api-contract) — missing schema",
					},
				],
			}),
		);
		expect(records.map(({ file, line, title }) => ({ file, line, title }))).toEqual([
			{
				file: "src/dashboard/App.tsx",
				line: 42,
				title: "account filter missing — data crosses account boundaries",
			},
			{ file: "src/api/config.json", line: 7, title: "missing schema" },
		]);
	});

	test("appends findings discovered in the judge deep-dive", () => {
		const records = buildLedgerRecords(
			makeRun({
				judgeOutput:
					"### Deep-Dive Discoveries\n- [P2] `scripts/judge-only.mjs:L8` (security) — Judge found a new exposure.",
			}),
		);
		expect(records.find((record) => record.critic === "judge")).toMatchObject({
			file: "scripts/judge-only.mjs",
			line: 8,
			severity: "P2",
			category: "security",
			title: "Judge found a new exposure.",
			judgeDisposition: "confirmed",
		});
	});

	test("gives an explicit dismissal precedence over an unrelated judge finding", () => {
		const records = buildLedgerRecords(
			makeRun({
				judgeFindings: [
					{
						file: "scripts/example.mjs",
						line: 99,
						severity: "P2",
						category: "correctness",
						description: "A different judge discovery",
					},
				],
				judgeOutput:
					"Codex claim that scripts/example.mjs drops valid parser records is DISMISSED as a false positive.",
			}),
		);
		expect(records.find((record) => record.critic === "codex")?.judgeDisposition).toBe("dismissed");
	});

	test("does not manufacture a finding from a markdown verdict heading", () => {
		expect(
			parseFindings("## BLOCK: `scripts/example.mjs:L42` has P1 correctness concerns."),
		).toEqual([]);
	});

	test("append is idempotent by runId", () => {
		const ledger = path.join(mkdtempSync(path.join(tmpdir(), "council-ledger-")), "ledger.jsonl");
		expect(appendRunToLedger(makeRun(), ledger)).toEqual({ skipped: false, written: 1 });
		const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		expect(appendRunToLedger(makeRun(), ledger)).toEqual({ skipped: true, written: 0 });
		expect(readFileSync(ledger, "utf8").trim().split("\n")).toHaveLength(1);
		expect(warning).toHaveBeenCalledOnce();
		warning.mockRestore();
	});
});

describe("backfillLedger", () => {
	test("ingests flat and directory fixtures and counts an invalid run", () => {
		const logDir = mkdtempSync(path.join(tmpdir(), "council-backfill-"));
		const ledgerPath = path.join(logDir, "ledger.jsonl");
		writeFileSync(
			path.join(logDir, "2026-01-01T00-00-00-000Z.json"),
			JSON.stringify({
				timestamp: "2026-01-01T00:00:00.000Z",
				branch: "old",
				base: "main",
				finalVerdict: { decision: "block" },
				phase1: [
					{
						provider: "grok",
						outputSnippet:
							'```json\n{"findings":[{"file":"old/file.ts","line":7,"severity":"P2","category":"performance","description":"Repeated scan"}]}\n```',
					},
				],
				phase2: { outputSnippet: "## BLOCK: confirmed." },
			}),
		);
		const runDir = path.join(logDir, "2026-01-02T00-00-00-000Z");
		mkdirSync(runDir);
		writeFileSync(
			path.join(runDir, "meta.json"),
			JSON.stringify({
				timestamp: "2026-01-02T00:00:00.000Z",
				branch: "new",
				base: "main",
				finalVerdict: { decision: "allow" },
				phase1: [{ provider: "codex" }],
			}),
		);
		writeFileSync(
			path.join(runDir, "codex.md"),
			'```json\n{"findings":[{"file":"new/file.ts","line":9,"severity":"P3","category":"api-contract","description":"Missing example"}]}\n```',
		);
		writeFileSync(path.join(runDir, "judge.md"), "## ALLOW: advisory only.");
		writeFileSync(path.join(logDir, "bad.json"), "");
		const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		expect(backfillLedger({ logDir, ledgerPath })).toEqual({
			runsSeen: 3,
			runsIngested: 2,
			findingsWritten: 2,
			skipped: 1,
		});
		expect(readFileSync(ledgerPath, "utf8").trim().split("\n")).toHaveLength(2);
		warning.mockRestore();
	});

	test("extracts critic results and legacy raw drafts from older flat logs", () => {
		const logDir = mkdtempSync(path.join(tmpdir(), "council-flat-backfill-"));
		const ledgerPath = path.join(logDir, "ledger.jsonl");
		writeFileSync(
			path.join(logDir, "2026-01-03T00-00-00-000Z.json"),
			JSON.stringify({
				timestamp: "2026-01-03T00:00:00.000Z",
				branch: "critic-results",
				verdict: {
					decision: "allow",
					criticResults: [
						{
							provider: "opencode",
							output: "- [P2] `legacy/file.ts:L12` (database) — Transaction can split.",
						},
					],
				},
			}),
		);
		writeFileSync(
			path.join(logDir, "2026-01-04T00-00-00-000Z.json"),
			JSON.stringify({
				timestamp: "2026-01-04T00:00:00.000Z",
				branch: "raw-drafts",
				verdict: { decision: "block" },
				rawOutput: JSON.stringify({
					drafts: {
						"review-b": "- [P3] `legacy/raw.ts:L4` (error-handling) — Error is swallowed.",
					},
					output: null,
				}),
			}),
		);
		expect(backfillLedger({ logDir, ledgerPath })).toEqual({
			runsSeen: 2,
			runsIngested: 2,
			findingsWritten: 2,
			skipped: 0,
		});
		const records = readFileSync(ledgerPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records.map((record) => record.critic)).toEqual(["opencode", "review-b"]);
	});
});
