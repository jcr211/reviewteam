import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const gateUrl = new URL("../council-review-gate.mjs", import.meta.url).href;
const fixtures = [];

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(config = {}) {
	const cwd = mkdtempSync(path.join(tmpdir(), "reviewteam-diff-"));
	fixtures.push(cwd);
	git(cwd, "init", "-q");
	git(cwd, "config", "user.name", "ReviewTeam Test");
	git(cwd, "config", "user.email", "reviewteam@example.test");
	const snapshot = "packages/db/migrations/meta/0001_snapshot.json";
	const source = "src/feature.ts";
	mkdirSync(path.join(cwd, path.dirname(snapshot)), { recursive: true });
	mkdirSync(path.join(cwd, "src"), { recursive: true });
	writeFileSync(path.join(cwd, snapshot), '{"old":true}\n');
	writeFileSync(path.join(cwd, source), "export const feature = 1;\n");
	writeFileSync(path.join(cwd, "council.config.json"), JSON.stringify({ logDir: "review-logs", ...config }));
	git(cwd, "add", ".");
	git(cwd, "commit", "-qm", "baseline");
	const base = git(cwd, "rev-parse", "HEAD");
	writeFileSync(path.join(cwd, snapshot), `{"new":true,\n${'"generated": 1,\n'.repeat(40_000)}"end":true}\n`);
	writeFileSync(path.join(cwd, source), "export const feature = 2;\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-qm", "real and generated changes");
	return { cwd, base, snapshot, source };
}

function inspect({ cwd, base }) {
	const script = `
		import { getDiffParts, getFullDiff, getTierRoute, writeLog } from ${JSON.stringify(gateUrl)};
		import { readFileSync } from "node:fs";
		import path from "node:path";
		const parts = getDiffParts(${JSON.stringify(base)});
		const fullDiff = getFullDiff(${JSON.stringify(base)}, parts);
		const route = getTierRoute(${JSON.stringify(base)}, null, parts);
		const runDir = writeLog({ excludedDiffPaths: (await import(${JSON.stringify(new URL("./config.mjs", import.meta.url).href)})).loadCouncilConfig().excludeDiffPaths, diffBodyBytes: parts.diffBodyBytes });
		const meta = JSON.parse(readFileSync(path.join(runDir, "meta.json"), "utf8"));
		console.log(JSON.stringify({ parts, fullDiff, route, meta }));
	`;
	return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd,
		encoding: "utf8",
	}));
}

afterEach(() => {
	for (const cwd of fixtures.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("review diff exclusions", () => {
	it("omits a snapshot body, lists its numstat, and still routes on its path", () => {
		const repo = fixture({
			pathTierRules: [{ pattern: "**/migrations/meta/**", tier: "CRITICAL", reason: "Migration path." }],
		});
		const { parts, fullDiff, route, meta } = inspect(repo);
		expect(parts.excludedFiles).toEqual([repo.snapshot]);
		expect(parts.body).toContain("+export const feature = 2;");
		expect(parts.body).not.toContain("generated");
		expect(fullDiff).toMatch(/\[GENERATED FILES \(bodies omitted\)\]\n\d+\t\d+\tpackages\/db\/migrations\/meta\/0001_snapshot.json/);
		expect(fullDiff).not.toContain("[TRUNCATED:");
		expect(parts.diffBodyBytes).toBeLessThan(200_000);
		expect(route.tier).toBe("CRITICAL");
		expect(route.reasons.join(" ")).toContain(repo.snapshot);
		expect(route.reasons.join(" ")).not.toContain("1500-line critical threshold");
		expect(meta.excludedDiffPaths).toContain("**/migrations/meta/*_snapshot.json");
		expect(meta.diffBodyBytes).toBe(Buffer.byteLength(parts.body, "utf8"));
	});

	it("honors custom globs while keeping unmatched source changes reviewable", () => {
		const repo = fixture({ excludeDiffPaths: ["generated/**"] });
		mkdirSync(path.join(repo.cwd, "generated"));
		writeFileSync(path.join(repo.cwd, "generated/catalog.json"), '{"generated":true}\n');
		git(repo.cwd, "add", ".");
		git(repo.cwd, "commit", "-qm", "custom generated file");
		const { parts, fullDiff, meta } = inspect(repo);
		expect(parts.excludedFiles).toEqual(["generated/catalog.json", repo.snapshot]);
		expect(parts.body).toContain("diff --git a/src/feature.ts b/src/feature.ts");
		expect(parts.body).not.toContain("diff --git a/generated/catalog.json");
		expect(fullDiff).toContain("generated/catalog.json");
		expect(meta.excludedDiffPaths).toContain("generated/**");
	});
});
