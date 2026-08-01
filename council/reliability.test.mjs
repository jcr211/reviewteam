import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
	computeCriticReliability,
	findQuarantinedCritics,
	formatReliabilityTable,
	hasSufficientReliabilityData,
} from "./reliability.mjs";

function makeRecord(overrides = {}) {
	return {
		runId: "run-1",
		critic: "codex",
		category: "correctness",
		judgeDisposition: "confirmed",
		grounding: "grounded",
		...overrides,
	};
}

function writeLedger(lines) {
	const directory = mkdtempSync(path.join(tmpdir(), "council-reliability-"));
	const ledgerPath = path.join(directory, "ledger.jsonl");
	writeFileSync(
		ledgerPath,
		`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
		"utf8",
	);
	return ledgerPath;
}

describe("computeCriticReliability", () => {
	test("computes critic/category counts and all rollups", () => {
		const ledgerPath = writeLedger([
			makeRecord({ judgeDisposition: "confirmed" }),
			makeRecord({ judgeDisposition: "dismissed" }),
			makeRecord({
				category: "security",
				judgeDisposition: "unaddressed",
				grounding: "fabricated",
			}),
			makeRecord({
				critic: "grok",
				category: "security",
				judgeDisposition: "confirmed",
			}),
			makeRecord({
				critic: "judge",
				category: "security",
				judgeDisposition: "confirmed",
			}),
		]);

		expect(computeCriticReliability(ledgerPath)).toEqual({
			codex: {
				all: {
					findings: 3,
					confirmed: 1,
					rejected: 1,
					fabricated: 1,
					confirmationRate: 1 / 3,
				},
				correctness: {
					findings: 2,
					confirmed: 1,
					rejected: 1,
					fabricated: 0,
					confirmationRate: 0.5,
				},
				security: {
					findings: 1,
					confirmed: 0,
					rejected: 0,
					fabricated: 1,
					confirmationRate: 0,
				},
			},
			grok: {
				all: {
					findings: 1,
					confirmed: 1,
					rejected: 0,
					fabricated: 0,
					confirmationRate: 1,
				},
				security: {
					findings: 1,
					confirmed: 1,
					rejected: 0,
					fabricated: 0,
					confirmationRate: 1,
				},
			},
		});
	});

	test("windows by the most recent distinct run IDs", () => {
		const ledgerPath = writeLedger([
			makeRecord({ runId: "run-1", judgeDisposition: "confirmed" }),
			makeRecord({ runId: "run-2", judgeDisposition: "dismissed" }),
			makeRecord({ runId: "run-3", judgeDisposition: "confirmed" }),
			makeRecord({
				runId: "run-3",
				category: "security",
				judgeDisposition: "confirmed",
			}),
		]);
		const reliability = computeCriticReliability(ledgerPath, { lastRuns: 2 });
		expect(reliability.codex.all).toMatchObject({
			findings: 3,
			confirmed: 2,
			rejected: 1,
		});
	});

	test("fails open for missing, empty, and corrupt-only ledgers", () => {
		const directory = mkdtempSync(
			path.join(tmpdir(), "council-reliability-empty-"),
		);
		const emptyPath = path.join(directory, "empty.jsonl");
		const corruptPath = path.join(directory, "corrupt.jsonl");
		writeFileSync(emptyPath, "", "utf8");
		writeFileSync(corruptPath, "{not-json}\n", "utf8");

		expect(
			computeCriticReliability(path.join(directory, "missing.jsonl")),
		).toEqual({});
		expect(computeCriticReliability(emptyPath)).toEqual({});
		expect(computeCriticReliability(corruptPath)).toEqual({});
	});

	test("skips a corrupt line while retaining valid append-only records", () => {
		const directory = mkdtempSync(
			path.join(tmpdir(), "council-reliability-mixed-"),
		);
		const ledgerPath = path.join(directory, "ledger.jsonl");
		writeFileSync(
			ledgerPath,
			`${JSON.stringify(makeRecord())}\n{not-json}\n${JSON.stringify(makeRecord({ judgeDisposition: "dismissed" }))}\n`,
			"utf8",
		);
		expect(computeCriticReliability(ledgerPath).codex.all).toMatchObject({
			findings: 2,
			confirmed: 1,
			rejected: 1,
		});
	});

	test("does not count unverified lines as fabrication or quarantine them", () => {
		const ledgerPath = writeLedger(
			Array.from({ length: 5 }, (_, index) =>
				makeRecord({
					runId: `run-${index + 1}`,
					lineVerified: false,
				}),
			),
		);
		const reliability = computeCriticReliability(ledgerPath);

		expect(reliability.codex.all).toMatchObject({ findings: 5, fabricated: 0 });
		expect(findQuarantinedCritics(reliability)).toEqual([]);
	});
});

describe("formatReliabilityTable", () => {
	test("gates rates below minSamples without expanding beyond one row per critic", () => {
		const ledgerPath = writeLedger([
			...Array.from({ length: 5 }, () => makeRecord()),
			makeRecord({ category: "security", judgeDisposition: "dismissed" }),
		]);
		const reliability = computeCriticReliability(ledgerPath);
		const table = formatReliabilityTable(reliability, { minSamples: 5 });

		expect(table).toContain("83% (5/6)");
		expect(table).toContain("insufficient data");
		expect(table.split("\n")).toHaveLength(3);
		expect(hasSufficientReliabilityData(reliability, 5)).toBe(true);
		expect(hasSufficientReliabilityData(reliability, 7)).toBe(false);
	});
});

describe("findQuarantinedCritics", () => {
	function reliability(findings, fabricated) {
		return {
			codex: {
				all: {
					findings,
					fabricated,
					confirmed: 0,
					rejected: 0,
					confirmationRate: 0,
				},
			},
		};
	}

	test("does not warn at 29 percent", () => {
		expect(findQuarantinedCritics(reliability(100, 29))).toEqual([]);
	});

	test("warns at 31 percent", () => {
		expect(findQuarantinedCritics(reliability(100, 31))).toEqual([
			{ critic: "codex", findings: 100, fabricated: 31 },
		]);
	});

	test("does not warn below five findings", () => {
		expect(findQuarantinedCritics(reliability(4, 4))).toEqual([]);
	});
});
