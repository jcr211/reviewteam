import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AUDITION_CLASSES,
	buildProposedConfig,
	discoverHarnesses,
	findingMatchesPlant,
	loadAuditionFixture,
	recommendDefaults,
	recommendSeats,
	runSetup,
	scoreAuditionResult,
	writeConfigFile,
} from "./setup.mjs";

const tempDirs = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function makeClassRecall(caught = []) {
	return Object.fromEntries(
		AUDITION_CLASSES.map((className) => [
			className,
			caught.includes(className),
		]),
	);
}

function makeScoreStub({
	id,
	vendor = id,
	caught = [],
	falsePositives = 0,
	latencyMs = 100,
	metered = false,
} = {}) {
	return {
		id,
		vendor,
		model: "test-model",
		ok: true,
		classRecall: makeClassRecall(caught),
		overallRecall: caught.length,
		falsePositives,
		latencyMs,
		metered,
		contractCompliant: true,
		error: null,
		findingCount: caught.length,
	};
}

function makeDiscoveryStub(id, status = "READY") {
	return {
		id,
		vendor: id,
		binary: id,
		status,
		version: "1.0.0",
		defaultModel: `${id}-model`,
		errorTail: "",
		judgeRequired: id === "claude",
	};
}

function jsonFindings(findings) {
	return `review\n\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\``;
}

describe("audition scoring", () => {
	const fixture = loadAuditionFixture();
	const correctness = fixture.manifest.plants.find(
		(plant) => plant.class === "correctness",
	);

	it("matches findings inside a plant range and at both ±5 boundaries", () => {
		expect(
			findingMatchesPlant(
				{ file: correctness.file, lineStart: correctness.lineStart },
				correctness,
			),
		).toBe(true);
		expect(
			findingMatchesPlant(
				{ file: correctness.file, lineStart: correctness.lineStart - 5 },
				correctness,
			),
		).toBe(true);
		expect(
			findingMatchesPlant(
				{ file: correctness.file, lineStart: correctness.lineEnd + 5 },
				correctness,
			),
		).toBe(true);
	});

	it("rejects out-of-range findings immediately beyond the slack", () => {
		expect(
			findingMatchesPlant(
				{ file: correctness.file, lineStart: correctness.lineStart - 6 },
				correctness,
			),
		).toBe(false);
		expect(
			findingMatchesPlant(
				{ file: correctness.file, lineStart: correctness.lineEnd + 6 },
				correctness,
			),
		).toBe(false);
	});

	it("computes per-class recall and counts findings that match no plant as false positives", () => {
		const findings = fixture.manifest.plants.map((plant) => ({
			severity: "p1",
			category: plant.class,
			file: plant.file,
			line: plant.lineStart,
			description: `caught ${plant.class}`,
		}));
		findings.push({
			severity: "p2",
			category: "correctness",
			file: "src/orders.mjs",
			line: 55,
			description: "unplanted observation",
		});
		const score = scoreAuditionResult(
			{
				provider: "test",
				ok: true,
				output: jsonFindings(findings),
				durationMs: 321,
			},
			fixture.manifest,
			fixture.diffText,
		);

		expect(score.classRecall).toEqual(makeClassRecall(AUDITION_CLASSES));
		expect(score.overallRecall).toBe(6);
		expect(score.falsePositives).toBe(1);
		expect(score.contractCompliant).toBe(true);
	});

	it("flags prose-only output as noncompliant while retaining grounded fallback findings", () => {
		const score = scoreAuditionResult(
			{
				provider: "test",
				ok: true,
				output: "P1 correctness src/pagination.mjs:9 skips the first page",
				durationMs: 10,
			},
			fixture.manifest,
			fixture.diffText,
		);
		expect(score.contractCompliant).toBe(false);
		expect(score.classRecall.correctness).toBe(true);
	});
});

describe("recommendation", () => {
	it("selects one seat from each available family before duplicate-family seats", () => {
		const recommendation = recommendSeats([
			makeScoreStub({
				id: "a-best",
				vendor: "family-a",
				caught: AUDITION_CLASSES,
			}),
			makeScoreStub({
				id: "a-second",
				vendor: "family-a",
				caught: AUDITION_CLASSES.slice(0, 5),
			}),
			makeScoreStub({
				id: "b-best",
				vendor: "family-b",
				caught: AUDITION_CLASSES.slice(0, 4),
			}),
			makeScoreStub({
				id: "b-second",
				vendor: "family-b",
				caught: AUDITION_CLASSES.slice(0, 3),
			}),
			makeScoreStub({
				id: "c-best",
				vendor: "family-c",
				caught: AUDITION_CLASSES.slice(0, 2),
			}),
		]);
		expect(recommendation.roster).toEqual(["a-best", "b-best", "c-best"]);
		expect(recommendation.roster).toHaveLength(3);
		expect(
			recommendDefaults([
				makeDiscoveryStub("a-best"),
				{ ...makeDiscoveryStub("a-second"), vendor: "a-best" },
				makeDiscoveryStub("b-best"),
				{ ...makeDiscoveryStub("b-second"), vendor: "b-best" },
				makeDiscoveryStub("c-best"),
			]).roster,
		).toEqual(["a-best", "b-best", "c-best"]);
	});

	it("makes the highest-recall seat the generalist backstop", () => {
		const recommendation = recommendSeats([
			makeScoreStub({ id: "specialist", caught: ["correctness"] }),
			makeScoreStub({
				id: "best",
				caught: ["correctness", "security", "error-handling"],
			}),
		]);
		expect(recommendation.generalistBackstop).toBe("best");
		expect(recommendation.criticSpecialties.best.label).toContain(
			"Generalist backstop",
		);
		expect(recommendation.criticSpecialties.best.prompt).toContain(
			"Review the whole diff",
		);
	});

	it("adds a second seat from a family only when fewer than three families exist", () => {
		const recommendation = recommendSeats([
			makeScoreStub({
				id: "a-best",
				vendor: "family-a",
				caught: AUDITION_CLASSES,
			}),
			makeScoreStub({
				id: "a-second",
				vendor: "family-a",
				caught: AUDITION_CLASSES.slice(0, 5),
			}),
			makeScoreStub({
				id: "b-best",
				vendor: "family-b",
				caught: AUDITION_CLASSES.slice(0, 4),
			}),
		]);
		expect(recommendation.roster).toEqual(["a-best", "b-best", "a-second"]);
	});

	it("notes a clearly fastest non-metered family excluded by rank", () => {
		const scores = Array.from({ length: 5 }, (_, index) =>
			makeScoreStub({
				id: `seat-${index}`,
				vendor: `family-${index}`,
				caught: AUDITION_CLASSES.slice(0, 5 - index),
				latencyMs: index === 4 ? 1 : 100 + index,
			}),
		);
		const recommendation = recommendSeats(scores);
		expect(recommendation.roster).toHaveLength(4);
		expect(recommendation.notes).toContain(
			"seat-4 was excluded by rank; consider adding it for cross-family redundancy at near-zero cost.",
		);
	});

	it("declares the required judge-reliance gap when a class is uncaught", () => {
		const recommendation = recommendSeats([
			makeScoreStub({
				id: "a",
				caught: AUDITION_CLASSES.filter((name) => name !== "performance"),
			}),
			makeScoreStub({ id: "b", caught: ["correctness"] }),
		]);
		expect(recommendation.gaps).toContain(
			"no seat caught the performance plant — findings in that class will rely on the judge",
		);
	});
});

describe("config emission", () => {
	it("writes valid JSON", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "council-setup-test-"));
		tempDirs.push(dir);
		const configPath = path.join(dir, "council.config.json");
		const recommendation = recommendSeats([
			makeScoreStub({ id: "codex", caught: AUDITION_CLASSES }),
			makeScoreStub({ id: "claude", caught: AUDITION_CLASSES }),
		]);
		const config = buildProposedConfig(recommendation, dir);
		writeConfigFile(config, { configPath });
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(config);
	});

	it("refuses to overwrite an existing config without confirmation", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "council-setup-test-"));
		tempDirs.push(dir);
		const configPath = path.join(dir, "council.config.json");
		writeFileSync(configPath, "original", "utf8");
		expect(() => writeConfigFile({ critics: [] }, { configPath })).toThrow(
			/Refusing to overwrite/,
		);
		expect(readFileSync(configPath, "utf8")).toBe("original");
	});

	it("--yes accepts defaults and explicitly authorizes overwrite without prompting", async () => {
		let promptCalls = 0;
		let overwrite = false;
		const result = await runSetup(
			{ yes: true, json: false, noAudition: true },
			{
				discover: async () => [
					makeDiscoveryStub("codex"),
					makeDiscoveryStub("claude"),
				],
				prompt: async () => {
					promptCalls++;
					return "";
				},
				stdout: () => {},
				configPath: "council.config.json",
				fileExists: () => true,
				writeConfig: (_config, options) => {
					overwrite = options.overwrite;
					return options.configPath;
				},
			},
		);
		expect(promptCalls).toBe(0);
		expect(overwrite).toBe(true);
		expect(result.wroteConfig).toBe(true);
	});
});

describe("discovery", () => {
	it("classifies ready, installed-but-failed, and missing adapters without live CLI calls", async () => {
		const authProbe = async (id) =>
			id === "ready"
				? { ok: true, output: "READY", error: null }
				: { ok: false, output: "", error: "first line\nverbatim failure tail" };
		const rows = await discoverHarnesses({
			providers: ["ready", "failed", "missing"],
			resolveBinary: (id) => id,
			versionProbe: async (binary) => ({
				ok: binary !== "missing",
				notFound: binary === "missing",
				stdout: binary === "missing" ? "" : "1.2.3",
				stderr: "",
				error: binary === "missing" ? "not found" : null,
			}),
			authProbe,
		});
		expect(rows.map((row) => row.status)).toEqual([
			"READY",
			"INSTALLED-BUT-FAILED",
			"NOT FOUND",
		]);
		expect(rows[1].errorTail).toContain("verbatim failure tail");
	});
});

describe("fixture integrity", () => {
	it("contains every manifested file and line range in the bundled diff", () => {
		const fixture = loadAuditionFixture();
		const ranges = new Map();
		const actualLineCounts = new Map();
		let currentFile = null;
		for (const line of fixture.diffText.split(/\r?\n/)) {
			if (line.startsWith("+++ b/")) currentFile = line.slice("+++ b/".length);
			if (!line.startsWith("@@ ") || !currentFile) continue;
			const match = line.match(/\+(\d+),(\d+)/);
			const start = Number.parseInt(match[1], 10);
			const count = Number.parseInt(match[2], 10);
			ranges.set(currentFile, { start, end: start + count - 1 });
			actualLineCounts.set(currentFile, 0);
		}

		currentFile = null;
		let inHunk = false;
		for (const line of fixture.diffText.split(/\r?\n/)) {
			if (line.startsWith("diff --git ")) inHunk = false;
			if (line.startsWith("+++ b/")) currentFile = line.slice("+++ b/".length);
			if (line.startsWith("@@ ")) {
				inHunk = true;
				continue;
			}
			if (inHunk && currentFile && line.startsWith("+")) {
				actualLineCounts.set(
					currentFile,
					actualLineCounts.get(currentFile) + 1,
				);
			}
		}

		for (const [file, range] of ranges) {
			expect(actualLineCounts.get(file), file).toBe(
				range.end - range.start + 1,
			);
		}

		for (const plant of fixture.manifest.plants) {
			const range = ranges.get(plant.file);
			expect(range, plant.file).toBeDefined();
			expect(plant.lineStart).toBeGreaterThanOrEqual(range.start);
			expect(plant.lineEnd).toBeLessThanOrEqual(range.end);
		}
	});
});
