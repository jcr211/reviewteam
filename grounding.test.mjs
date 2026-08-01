import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildGroundingPromptSection,
	parseDiffForGrounding,
	runGroundingPass,
} from "./council-review-gate.mjs";

const SIMPLE_DIFF = [
	"diff --git a/src/foo.ts b/src/foo.ts",
	"--- a/src/foo.ts",
	"+++ b/src/foo.ts",
	"@@ -10,8 +10,10 @@",
	" // context line",
	" old line",
	"+new line 1",
	"+new line 2",
	" another context",
	" // more context",
	" // end context",
	" // trailing",
].join("\n");

const RENAME_DIFF = [
	"diff --git a/src/old-name.ts b/src/new-name.ts",
	"similarity index 100%",
	"rename from src/old-name.ts",
	"rename to src/new-name.ts",
	"--- a/src/old-name.ts",
	"+++ b/src/new-name.ts",
	"@@ -5,6 +5,6 @@",
	" // context",
	" some code",
	"+updated code",
	" // more",
].join("\n");

const DELETE_DIFF = [
	"diff --git a/src/deleted.ts b/src/deleted.ts",
	"deleted file mode 100644",
	"--- a/src/deleted.ts",
	"+++ /dev/null",
	"@@ -1,5 +0,0 @@",
	"-line 1",
	"-line 2",
	"-line 3",
	"-line 4",
	"-line 5",
].join("\n");

describe("parseDiffForGrounding", () => {
	it("extracts file paths from old and new sides", () => {
		const { oldFiles, newFiles } = parseDiffForGrounding(SIMPLE_DIFF);
		expect(newFiles.has("src/foo.ts")).toBe(true);
		expect(oldFiles.has("src/foo.ts")).toBe(true);
	});

	it("extracts hunk ranges on the new side", () => {
		const { hunksByFile } = parseDiffForGrounding(SIMPLE_DIFF);
		const hunks = hunksByFile.get("src/foo.ts");
		expect(hunks).toBeDefined();
		expect(hunks).toHaveLength(1);
		expect(hunks[0]).toEqual({ start: 10, end: 19 });
	});

	it("handles renamed files", () => {
		const { oldFiles, newFiles, hunksByFile } = parseDiffForGrounding(RENAME_DIFF);
		expect(oldFiles.has("src/old-name.ts")).toBe(true);
		expect(newFiles.has("src/new-name.ts")).toBe(true);
		expect(hunksByFile.has("src/new-name.ts")).toBe(true);
	});

	it("handles deleted files (no new-side hunks)", () => {
		const { oldFiles, newFiles, hunksByFile } = parseDiffForGrounding(DELETE_DIFF);
		expect(oldFiles.has("src/deleted.ts")).toBe(true);
		expect(newFiles.has("src/deleted.ts")).toBe(false);
		expect(hunksByFile.has("src/deleted.ts")).toBe(false);
	});

	it("handles multiple files in one diff", () => {
		const multiDiff = [SIMPLE_DIFF, RENAME_DIFF].join("\n");
		const { newFiles } = parseDiffForGrounding(multiDiff);
		expect(newFiles.has("src/foo.ts")).toBe(true);
		expect(newFiles.has("src/new-name.ts")).toBe(true);
	});
});

describe("runGroundingPass", () => {
	let tmpDir;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(tmpdir(), "grounding-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("classifies fabricated finding (file nowhere)", () => {
		const findings = [
			{ file: "src/nonexistent.ts", lineStart: 10, severity: "p1", description: "test", foundBy: "critic-x" },
		];
		const result = runGroundingPass(findings, SIMPLE_DIFF);
		expect(findings[0].grounding).toBe("fabricated");
		expect(result.counts.fabricated).toBe(1);
		expect(result.counts.grounded).toBe(0);
		expect(result.fabricatedByCritic.get("critic-x")).toBe(1);
	});

	it("classifies a real in-diff file beyond EOF as grounded with an unverified line", () => {
		const filePath = path.join(tmpDir, "src", "foo.ts");
		mkdirSync(path.dirname(filePath), { recursive: true });
		writeFileSync(filePath, "line 1\nline 2\nline 3\n");

		// Temporarily patch existsSync by using an absolute path in the finding
		const findings = [
			{ file: filePath, lineStart: 9999, severity: "p1", description: "test" },
		];
		// Use a diff that references the absolute path
		const diff = [
			`diff --git a/${filePath} b/${filePath}`,
			`--- a/${filePath}`,
			`+++ b/${filePath}`,
			"@@ -1,3 +1,3 @@",
			" line 1",
			"+changed",
			" line 2",
		].join("\n");
		const result = runGroundingPass(findings, diff);
		expect(findings[0]).toMatchObject({ grounding: "grounded", lineVerified: false });
		expect(result.counts.fabricated).toBe(0);
		expect(result.counts.grounded).toBe(1);
	});

	it("classifies out_of_scope (real file not in diff)", () => {
		const filePath = path.join(tmpDir, "src", "other.ts");
		mkdirSync(path.dirname(filePath), { recursive: true });
		writeFileSync(filePath, "line 1\nline 2\n");

		const findings = [
			{ file: filePath, lineStart: 1, severity: "p1", description: "test" },
		];
		runGroundingPass(findings, SIMPLE_DIFF);
		expect(findings[0].grounding).toBe("out_of_scope");
	});

	it("classifies an in-diff file outside every hunk as grounded with an unverified line", () => {
		const findings = [
			{ file: "src/foo.ts", lineStart: 99, severity: "p1", description: "test" },
		];
		runGroundingPass(findings, SIMPLE_DIFF);
		expect(findings[0]).toMatchObject({ grounding: "grounded", lineVerified: false });
	});

	it("classifies grounded (line inside a hunk)", () => {
		const findings = [
			{ file: "src/foo.ts", lineStart: 12, severity: "p1", description: "test" },
		];
		runGroundingPass(findings, SIMPLE_DIFF);
		expect(findings[0]).toMatchObject({ grounding: "grounded", lineVerified: true });
	});

	it("classifies grounded with slack (line 2 outside hunk boundary)", () => {
		// Hunk is 10-19, slack is ±3, so line 7 should be grounded
		const findings = [
			{ file: "src/foo.ts", lineStart: 7, severity: "p1", description: "test" },
		];
		runGroundingPass(findings, SIMPLE_DIFF);
		expect(findings[0]).toMatchObject({ grounding: "grounded", lineVerified: true });
	});

	it("classifies deleted-file citation as grounded", () => {
		const findings = [
			{ file: "src/deleted.ts", lineStart: 3, severity: "p1", description: "test" },
		];
		runGroundingPass(findings, DELETE_DIFF);
		expect(findings[0]).toMatchObject({ grounding: "grounded", lineVerified: true });
	});

	it("handles rename (old path cited → resolved to new path)", () => {
		const findings = [
			{ file: "src/old-name.ts", lineStart: 6, severity: "p1", description: "test" },
		];
		runGroundingPass(findings, RENAME_DIFF);
		expect(findings[0]).toMatchObject({ grounding: "grounded", lineVerified: true });
	});

	it("skips findings with no file", () => {
		const findings = [
			{ file: null, lineStart: 0, severity: "p1", description: "test" },
		];
		const result = runGroundingPass(findings, SIMPLE_DIFF);
		expect(findings[0].grounding).toBeUndefined();
		expect(result.counts.grounded).toBe(0);
	});

	it("counts multiple findings correctly", () => {
		const findings = [
			{ file: "src/foo.ts", lineStart: 12, severity: "p1", description: "g", foundBy: "a" },
			{ file: "src/foo.ts", lineStart: 99, severity: "p1", description: "oos", foundBy: "a" },
			{ file: "src/nowhere.ts", lineStart: 1, severity: "p1", description: "fab", foundBy: "b" },
		];
		const result = runGroundingPass(findings, SIMPLE_DIFF);
		expect(result.counts).toEqual({ grounded: 2, out_of_scope: 0, fabricated: 1 });
		expect(result.fabricatedByCritic.get("b")).toBe(1);
	});
});

describe("buildGroundingPromptSection", () => {
	it("includes fabricated critic warnings", () => {
		const fabricatedByCritic = new Map([["critic-x", 2]]);
		const findings = [
			{ file: "src/foo.ts", lineStart: 12, severity: "p1", description: "ok", grounding: "grounded" },
		];
		const section = buildGroundingPromptSection(findings, fabricatedByCritic);
		expect(section).toContain("critic-x cited 2 nonexistent file(s)");
		expect(section).toContain("extra scrutiny");
	});

	it("lists out-of-scope findings with demoted label", () => {
		const findings = [
			{ file: "src/other.ts", lineStart: 5, severity: "p1", description: "missed", grounding: "out_of_scope" },
		];
		const section = buildGroundingPromptSection(findings, new Map());
		expect(section).toContain("out-of-scope; demoted to P2");
		expect(section).toContain("src/other.ts:5");
		expect(section).toContain("(out-of-scope)");
	});

	it("lists grounded findings", () => {
		const findings = [
			{ file: "src/foo.ts", lineStart: 12, severity: "p0", description: "real issue", grounding: "grounded" },
		];
		const section = buildGroundingPromptSection(findings, new Map());
		expect(section).toContain("Grounded findings");
		expect(section).toContain("src/foo.ts:12");
		expect(section).toContain("real issue");
	});

	it("annotates grounded findings whose cited line is approximate", () => {
		const findings = [
			{
				file: "src/foo.ts",
				lineStart: 9999,
				severity: "p1",
				description: "real issue",
				grounding: "grounded",
				lineVerified: false,
			},
		];
		const section = buildGroundingPromptSection(findings, new Map());
		expect(section).toContain(
			"cited line does not match the worktree — treat the line as approximate, verify by content",
		);
	});

	it("omits fabricated findings from the list", () => {
		const findings = [
			{ file: "src/nowhere.ts", lineStart: 1, severity: "p1", description: "ghost", grounding: "fabricated" },
			{ file: "src/foo.ts", lineStart: 12, severity: "p1", description: "real", grounding: "grounded" },
		];
		const section = buildGroundingPromptSection(findings, new Map([["critic-x", 1]]));
		expect(section).not.toContain("ghost");
		expect(section).toContain("real");
	});
});
