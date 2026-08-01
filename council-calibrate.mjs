#!/usr/bin/env node
// Council Calibration Harness
// Runs critics on a set of branches and dumps side-by-side results.
// Supports --full-pipeline mode: Phase 1 critics → Phase 2 judge.
//
// Usage:
//   node council-calibrate.mjs [--branches branch1,branch2,...] [--base main]
//   node council-calibrate.mjs [--critics critic-a,critic-b] [--base main]
//   node council-calibrate.mjs --full-pipeline --branches branch1 --base main
//
// Output: <configured logDir>/calibration/<timestamp>/

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadCouncilConfig } from "./council/config.mjs";
import {
	buildTaskPrompt,
	getMainWorktreeRoot,
	git,
	gitSafe,
	MAX_DIFF_BYTES,
	parseVerdict,
	PHASE1_CRITICS,
	spawnCritic,
	spawnJudgeWithFiles,
	TIMEOUT_SECONDS,
} from "./council-review-gate.mjs";

const DEFAULT_CRITICS = PHASE1_CRITICS.join(",");
const COUNCIL_CONFIG = loadCouncilConfig();

function parseArgs() {
	const args = process.argv.slice(2);
	const opts = { branches: null, base: null, critics: DEFAULT_CRITICS, verbose: false, fullPipeline: false };
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--branches" && args[i + 1]) opts.branches = args[++i];
		else if (args[i] === "--base" && args[i + 1]) opts.base = args[++i];
		else if (args[i] === "--critics" && args[i + 1]) opts.critics = args[++i];
		else if (args[i] === "--full-pipeline") opts.fullPipeline = true;
		else if (args[i] === "--verbose" || args[i] === "-v") opts.verbose = true;
	}
	return opts;
}

function detectBaseBranch() {
	for (const branch of ["main", "master", "develop"]) {
		if (gitSafe("rev-parse", "--verify", branch) !== null) return branch;
	}
	return "main";
}

function discoverBranches(base) {
	try {
		const raw = execFileSync("git", ["branch", "--list", "feat/*", "--format=%(refname:short)"], {
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
		}).trim();
		if (!raw) return [];
		const branches = raw.split("\n").filter(Boolean);
		const withSize = branches.map((b) => {
			const mergeBase = gitSafe("merge-base", base, b) || base;
			const stat = gitSafe("diff", "--shortstat", mergeBase, b) || "";
			const insertions = stat.match(/(\d+) insertion/)?.[1] || "0";
			const deletions = stat.match(/(\d+) deletion/)?.[1] || "0";
			return {
				branch: b,
				lines: Number.parseInt(insertions, 10) + Number.parseInt(deletions, 10),
				stat,
			};
		});
		withSize.sort((a, b) => b.lines - a.lines);
		return withSize;
	} catch {
		return [];
	}
}

function selectCalibrationBranches(allBranches) {
	if (allBranches.length === 0) return [];
	const selected = [];

	const large = allBranches.find((b) => b.lines >= 500);
	if (large) selected.push(large);

	const small = allBranches.find((b) => b.lines > 0 && b.lines < 100 && !selected.includes(b));
	if (small) selected.push(small);

	const dbBranch = allBranches.find((b) =>
		(b.branch.includes("db") || b.branch.includes("migration") || b.branch.includes("database") || b.branch.includes("rpc"))
		&& !selected.includes(b),
	);
	if (dbBranch) selected.push(dbBranch);

	const pipelineBranch = allBranches.find((b) =>
		(b.branch.includes("pipeline") || b.branch.includes("workflow") || b.branch.includes("stage"))
		&& !selected.includes(b),
	);
	if (pipelineBranch) selected.push(pipelineBranch);

	const secBranch = allBranches.find((b) =>
		(b.branch.includes("security") || b.branch.includes("auth") || b.branch.includes("stripe"))
		&& !selected.includes(b),
	);
	if (secBranch) selected.push(secBranch);

	if (selected.length < 3) {
		for (const b of allBranches) {
			if (!selected.includes(b) && b.lines > 50) {
				selected.push(b);
				if (selected.length >= 5) break;
			}
		}
	}

	return selected.slice(0, 5);
}

function getDiffForBranch(base, branch) {
	const mergeBase = gitSafe("merge-base", base, branch) || base;
	const diff = git("diff", mergeBase, branch);
	if (diff.length > MAX_DIFF_BYTES) {
		const statSummary = git("diff", "--stat", mergeBase, branch);
		return (
			`[TRUNCATED: diff is ${diff.length} bytes, showing first ${MAX_DIFF_BYTES} bytes]\n\n` +
			`Full diff stat:\n${statSummary}\n\n` +
			diff.slice(0, MAX_DIFF_BYTES)
		);
	}
	return diff;
}

function getBranchInfoFor(branch) {
	return {
		branch,
		lastCommit: gitSafe("log", "-1", "--format=%h %s", branch) || "?",
	};
}

function extractFindings(output) {
	const findings = [];
	const lines = (output || "").split("\n");
	for (const line of lines) {
		const fileMatch = line.match(/[`"]?([a-zA-Z0-9_\-/.]+\.[a-zA-Z]{1,4})[`"]?[:\s]/);
		const lineMatch = line.match(/[:\s]L?(\d+[-–]\d+|\d+)/i);
		const severityMatch = line.match(/\b(P0|P1|P2|P3|info|critical|high|medium|low)\b/i);
		const categoryMatch = line.match(/\b(security|correctness|error.?handling|api.?contract|database|performance)\b/i);

		if (fileMatch || severityMatch) {
			findings.push({
				raw: line.trim(),
				file: fileMatch?.[1] || null,
				lines: lineMatch?.[1] || null,
				severity: severityMatch?.[1]?.toLowerCase() || "info",
				category: categoryMatch?.[1]?.toLowerCase() || "uncategorized",
			});
		}
	}
	return findings;
}

function hasLineRefs(findings) {
	if (findings.length === 0) return "—";
	const withRefs = findings.filter((f) => f.lines !== null).length;
	return `${withRefs}/${findings.length}`;
}

function uniqueCategories(findings) {
	const cats = new Set(findings.map((f) => f.category).filter((c) => c !== "uncategorized"));
	return cats.size > 0 ? [...cats].join(", ") : "—";
}

function generateSummary(timestamp, base, branchResults) {
	const lines = [];
	lines.push(`# Council Calibration — ${timestamp}`);
	lines.push("");
	lines.push(`Base: \`${base}\``);
	lines.push(`Critics: ${branchResults[0]?.criticNames?.join(", ") || "?"}`);
	lines.push("");
	lines.push("## Per-Branch Results");

	const aggregates = {};

	for (const br of branchResults) {
		lines.push("");
		lines.push(`### Branch: \`${br.branch}\` (${br.diffLines} diff lines)`);
		lines.push("");
		lines.push("| Critic | Verdict | Time | Findings | Line refs? | Categories covered |");
		lines.push("|--------|---------|------|----------|------------|--------------------|");

		for (const cr of br.critics) {
			const verdict = cr.verdict?.decision === "block" ? "BLOCK" : "ALLOW";
			const time = cr.ok ? `${(cr.durationMs / 1000).toFixed(1)}s` : "FAILED";
			const findingCount = cr.findings.length;
			const lineRefs = hasLineRefs(cr.findings);
			const cats = uniqueCategories(cr.findings);

			lines.push(`| ${cr.provider} | ${verdict} | ${time} | ${findingCount} | ${lineRefs} | ${cats} |`);

			if (!aggregates[cr.provider]) {
				aggregates[cr.provider] = { times: [], findings: [], uniqueFindings: [], falsePositives: 0, lineRefHits: 0, lineRefTotal: 0 };
			}
			if (cr.ok) aggregates[cr.provider].times.push(cr.durationMs);
			aggregates[cr.provider].findings.push(...cr.findings);
			aggregates[cr.provider].lineRefTotal += cr.findings.length;
			aggregates[cr.provider].lineRefHits += cr.findings.filter((f) => f.lines !== null).length;
		}

		const uniqueByProvider = {};
		for (const cr of br.critics) {
			const otherRaws = new Set(
				br.critics
					.filter((o) => o.provider !== cr.provider)
					.flatMap((o) => o.findings.map((f) => f.file)),
			);
			const unique = cr.findings.filter((f) => f.file && !otherRaws.has(f.file));
			if (unique.length > 0) {
				uniqueByProvider[cr.provider] = unique;
				if (aggregates[cr.provider]) {
					aggregates[cr.provider].uniqueFindings.push(...unique);
				}
			}
		}

		if (Object.keys(uniqueByProvider).length > 0) {
			lines.push("");
			lines.push("**Unique findings (caught by only one critic):**");
			for (const [prov, findings] of Object.entries(uniqueByProvider)) {
				for (const f of findings) {
					const loc = f.lines ? ` (line ${f.lines})` : "";
					lines.push(`- [${prov}] ${f.file || "?"}${loc} — ${f.category}`);
				}
			}
		}

		if (br.phase2) {
			const judgeVerdict = parseVerdict(br.phase2.output);
			lines.push("");
			lines.push(`**Phase 2 — Judge:** ${judgeVerdict.decision.toUpperCase()} (${(br.phase2.durationMs / 1000).toFixed(1)}s)`);
			lines.push(`- ${judgeVerdict.reason}`);
			if (judgeVerdict.details) {
				lines.push(`- Details: ${judgeVerdict.details.slice(0, 500)}`);
			}
		}
	}

	lines.push("");
	lines.push("## Aggregate Stats");
	lines.push("");
	lines.push("| Critic | Avg time | Total findings | Unique findings | Line ref rate |");
	lines.push("|--------|----------|----------------|-----------------|---------------|");

	for (const [prov, agg] of Object.entries(aggregates)) {
		const avgTime = agg.times.length > 0
			? `${(agg.times.reduce((a, b) => a + b, 0) / agg.times.length / 1000).toFixed(1)}s`
			: "—";
		const lineRefRate = agg.lineRefTotal > 0
			? `${Math.round((agg.lineRefHits / agg.lineRefTotal) * 100)}%`
			: "—";
		lines.push(`| ${prov} | ${avgTime} | ${agg.findings.length} | ${agg.uniqueFindings.length} | ${lineRefRate} |`);
	}

	lines.push("");
	lines.push("## Role Assignment Analysis");
	lines.push("");
	lines.push("Answer these questions from the data above:");
	lines.push("");
	lines.push("1. **Does the judge find issues no critic catches?** Count judge-only findings.");
	lines.push("   - If YES (at least two across branches), consider moving that model into the critic roster.");
	lines.push("   - If NO (judge findings are subsets of others) → keep that model in the synthesis role.");
	lines.push("");
	lines.push("2. **Which critic has the highest overlap with the judge?** Check whether that seat adds distinct coverage.");
	lines.push("");
	lines.push("3. **Which critic has the most false positives?** Best candidate for judge role.");
	lines.push("");
	lines.push("4. **Which critic finds the most unique issues?** Should NOT be the judge.");
	lines.push("");
	lines.push("5. **What categories does each critic dominate?**");
	lines.push("   - Best at security: ___");
	lines.push("   - Best at correctness: ___");
	lines.push("   - Best at error-handling: ___");
	lines.push("   - Best at database/schema: ___");
	lines.push("   - Best at API contracts: ___");
	lines.push("");

	return lines.join("\n");
}

async function main() {
	const opts = parseArgs();
	const base = opts.base || detectBaseBranch();
	const criticList = (opts.fullPipeline && opts.critics === DEFAULT_CRITICS)
		? [...PHASE1_CRITICS]
		: opts.critics.split(",").map((c) => c.trim()).filter(Boolean);

	process.stderr.write(`Calibration: base=${base}, critics=[${criticList.join(",")}]${opts.fullPipeline ? " (full-pipeline)" : ""}\n`);

	let branches;
	if (opts.branches) {
		branches = opts.branches.split(",").map((b) => b.trim()).filter(Boolean);
		process.stderr.write(`Calibration: using specified branches: ${branches.join(", ")}\n`);
	} else {
		process.stderr.write("Calibration: auto-discovering branches...\n");
		const allBranches = discoverBranches(base);
		process.stderr.write(`Calibration: found ${allBranches.length} feature branches\n`);
		const selected = selectCalibrationBranches(allBranches);
		branches = selected.map((s) => s.branch);
		if (branches.length === 0) {
			process.stderr.write("Calibration: no suitable branches found. Use --branches to specify.\n");
			process.exit(1);
		}
		process.stderr.write(`Calibration: selected ${branches.length} branches:\n`);
		for (const s of selected) {
			process.stderr.write(`  ${s.branch} (${s.lines} lines changed)\n`);
		}
	}

	const mainRoot = getMainWorktreeRoot();
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const outDir = path.join(mainRoot, COUNCIL_CONFIG.logDir, "calibration", timestamp);
	mkdirSync(outDir, { recursive: true });

	const branchResults = [];

	for (const branch of branches) {
		process.stderr.write(`\n${"=".repeat(60)}\n`);
		process.stderr.write(`Calibration: branch=${branch}\n`);

		let diff;
		try {
			diff = getDiffForBranch(base, branch);
		} catch (err) {
			process.stderr.write(`  SKIP: could not get diff — ${err.message}\n`);
			continue;
		}

		if (!diff.trim()) {
			process.stderr.write(`  SKIP: empty diff\n`);
			continue;
		}

		const diffLines = diff.split("\n").length;
		process.stderr.write(`  ${diffLines} diff lines\n`);

		const branchInfo = getBranchInfoFor(branch);

		const branchDir = path.join(outDir, branch.replace(/\//g, "--"));
		mkdirSync(branchDir, { recursive: true });

		const criticResults = [];
		const rawCriticResults = [];

		process.stderr.write(`  Running ${criticList.length} critics in parallel...\n`);
		const results = await Promise.allSettled(
			criticList.map((provider) => {
				const prompt = `${buildTaskPrompt(branchInfo, provider)}\n\nDIFF:\n${diff}`;
				return spawnCritic(provider, prompt, TIMEOUT_SECONDS * 1000);
			}),
		);

		for (let i = 0; i < criticList.length; i++) {
			const provider = criticList[i];
			const result = results[i];
			const cr = result.status === "fulfilled"
				? result.value
				: { provider, ok: false, output: "", error: result.reason?.message ?? String(result.reason), durationMs: 0 };

			rawCriticResults.push(cr);

			const verdict = cr.ok ? parseVerdict(cr.output) : { decision: "allow", reason: `Failed: ${cr.error}` };
			const findings = cr.ok ? extractFindings(cr.output) : [];

			const status = cr.ok ? "OK" : "FAILED";
			const time = `${(cr.durationMs / 1000).toFixed(1)}s`;
			const dec = verdict.decision.toUpperCase();
			process.stderr.write(`  [${provider}] ${status} ${time} → ${dec} (${findings.length} findings)\n`);

			if (opts.verbose && cr.output) {
				process.stderr.write(`    Output preview: ${cr.output.slice(0, 300).replace(/\n/g, " ")}\n`);
			}

			writeFileSync(path.join(branchDir, `${provider}.md`), cr.output || `(no output — ${cr.error || "unknown error"})`, "utf8");

			criticResults.push({
				provider,
				ok: cr.ok,
				durationMs: cr.durationMs,
				error: cr.error,
				verdict,
				findings,
				outputLength: (cr.output || "").length,
			});
		}

		let phase2Result = null;
		if (opts.fullPipeline) {
			process.stderr.write("  Phase 2: Running judge review...\n");
			phase2Result = await spawnJudgeWithFiles(diff, rawCriticResults);

			const judgeVerdict = phase2Result.ok ? parseVerdict(phase2Result.output) : { decision: "error", reason: `Failed: ${phase2Result.error}` };
			const jStatus = phase2Result.ok ? "OK" : "FAIL";
			process.stderr.write(`  [judge] ${jStatus} ${(phase2Result.durationMs / 1000).toFixed(1)}s → ${judgeVerdict.decision.toUpperCase()}\n`);

			writeFileSync(path.join(branchDir, "judge.md"), phase2Result.output || `(no output — ${phase2Result.error || "unknown error"})`, "utf8");
		}

		const metaData = {
			branch,
			base,
			diffLines,
			lastCommit: branchInfo.lastCommit,
			timestamp: new Date().toISOString(),
			fullPipeline: opts.fullPipeline,
			critics: criticResults.map((cr) => ({
				provider: cr.provider,
				ok: cr.ok,
				durationMs: cr.durationMs,
				error: cr.error,
				verdict: cr.verdict.decision,
				verdictReason: cr.verdict.reason,
				findingCount: cr.findings.length,
				outputLength: cr.outputLength,
			})),
		};
		if (phase2Result) {
			const judgeVerdict = parseVerdict(phase2Result.output);
			metaData.phase2 = {
				provider: "judge",
				ok: phase2Result.ok,
				durationMs: phase2Result.durationMs,
				verdict: judgeVerdict.decision,
				verdictReason: judgeVerdict.reason,
				outputLength: (phase2Result.output || "").length,
			};
		}
		writeFileSync(path.join(branchDir, "meta.json"), JSON.stringify(metaData, null, 2), "utf8");

		branchResults.push({
			branch,
			diffLines,
			criticNames: criticList,
			critics: criticResults,
			phase2: phase2Result,
		});
	}

	if (branchResults.length === 0) {
		process.stderr.write("\nCalibration: no branches produced results.\n");
		process.exit(1);
	}

	const summary = generateSummary(timestamp, base, branchResults);
	const summaryPath = path.join(outDir, "summary.md");
	writeFileSync(summaryPath, summary, "utf8");

	process.stderr.write(`\n${"=".repeat(60)}\n`);
	process.stderr.write(`Calibration complete.\n`);
	process.stderr.write(`  Branches tested: ${branchResults.length}\n`);
	process.stderr.write(`  Critics: ${criticList.join(", ")}\n`);
	process.stderr.write(`  Output: ${outDir}\n`);
	process.stderr.write(`  Summary: ${summaryPath}\n`);
}

main().catch((err) => {
	process.stderr.write(`Calibration fatal: ${err.message}\n${err.stack}\n`);
	process.exit(2);
});
