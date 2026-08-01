import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCouncilConfig } from "./config.mjs";
import { appendRunToLedger } from "./findings-ledger.mjs";

const COUNCIL_CONFIG = loadCouncilConfig();

function mainRoot() {
	try {
		const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return path.dirname(path.resolve(common));
	} catch {
		return process.cwd();
	}
}

export function defaultCouncilLogDir() {
	return path.join(mainRoot(), COUNCIL_CONFIG.logDir);
}

function timestampFromRunId(runId) {
	return runId
		.replace(/-(\d{3})Z$/, ".$1Z")
		.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})/, "$1:$2:$3");
}

function fromMeta(meta, runId, critics, judgeOutput) {
	return {
		ts: meta.timestamp || timestampFromRunId(runId),
		runId,
		branch: meta.branch || "unknown",
		baseSha: meta.baseSha || "unknown",
		headSha: meta.headSha || "unknown",
		verdict: meta.finalVerdict || meta.verdict,
		aggregatedFindings: meta.aggregatedFindings || [],
		critics,
		judgeOutput,
	};
}

function findingsByProvider(meta) {
	const grouped = new Map();
	for (const finding of Array.isArray(meta.aggregatedFindings) ? meta.aggregatedFindings : []) {
		const severity = String(finding?.severity || "").toUpperCase();
		if (!/^P[0-3]$/.test(severity) || !finding?.foundBy) continue;
		const values = grouped.get(finding.foundBy) || [];
		values.push(finding);
		grouped.set(finding.foundBy, values);
	}
	return grouped;
}

function withFallbackFindings(meta, critics, preferAggregated = false) {
	const grouped = findingsByProvider(meta);
	const result = critics.map((critic) => {
		const findings = grouped.get(critic.provider) || [];
		if (preferAggregated && findings.length > 0) return { ...critic, output: "", findings };
		return { ...critic, findings: critic.output.trim() ? [] : findings };
	});
	for (const [provider, findings] of grouped) {
		if (!result.some((critic) => critic.provider === provider)) {
			result.push({ provider, output: "", findings });
		}
	}
	return result;
}

function parseRawCouncilOutput(rawOutput) {
	if (typeof rawOutput !== "string" || !rawOutput.trim()) return { critics: [], judgeOutput: "" };
	try {
		const parsed = JSON.parse(rawOutput);
		return {
			critics: Object.entries(parsed.drafts || {}).map(([provider, output]) => ({
				provider,
				output: typeof output === "string" ? output : "",
			})),
			judgeOutput: typeof parsed.output === "string" ? parsed.output : "",
		};
	} catch {
		return { critics: [], judgeOutput: "" };
	}
}

export function parseRunEntry(entryPath) {
	const directory = statSync(entryPath).isDirectory();
	const runId = path.basename(entryPath, directory ? undefined : path.extname(entryPath));
	if (directory) {
		const meta = JSON.parse(readFileSync(path.join(entryPath, "meta.json"), "utf8"));
		const critics = [];
		for (const phase of Array.isArray(meta.phase1) ? meta.phase1 : []) {
			let output = "";
			try {
				output = readFileSync(path.join(entryPath, `${phase.provider}.md`), "utf8");
			} catch {
				// Failed or excluded critics may have no output.
			}
			critics.push({ provider: phase.provider || "unknown", output });
		}
		let judgeOutput = "";
		try {
			judgeOutput = readFileSync(path.join(entryPath, "judge.md"), "utf8");
		} catch {
			// A missing judge produces null dispositions.
		}
		return fromMeta(meta, runId, withFallbackFindings(meta, critics), judgeOutput);
	}
	const meta = JSON.parse(readFileSync(entryPath, "utf8"));
	const raw = parseRawCouncilOutput(meta.rawOutput);
	const criticSources = Array.isArray(meta.phase1)
		? meta.phase1
		: Array.isArray(meta.verdict?.criticResults)
			? meta.verdict.criticResults
			: Array.isArray(meta.criticDetails)
				? meta.criticDetails
				: [];
	const critics =
		criticSources.length > 0
			? criticSources.map((phase) => ({
					provider: phase.provider || "unknown",
					output: phase.output || phase.outputSnippet || "",
				}))
			: raw.critics;
	return fromMeta(
		meta,
		runId,
		withFallbackFindings(meta, critics, true),
		meta.phase2?.output || meta.phase2?.outputSnippet || raw.judgeOutput,
	);
}

export function backfillLedger({ logDir, ledgerPath = path.join(logDir, "ledger.jsonl") }) {
	const summary = { runsSeen: 0, runsIngested: 0, findingsWritten: 0, skipped: 0 };
	const entries = readdirSync(logDir)
		.filter((name) => name !== path.basename(ledgerPath))
		.sort();
	for (const name of entries) {
		const entryPath = path.join(logDir, name);
		try {
			if (!name.endsWith(".json") && !statSync(entryPath).isDirectory()) continue;
		} catch (error) {
			summary.runsSeen++;
			summary.skipped++;
			process.stderr.write(
				`Backfill warning: skipped ${name}: ${error instanceof Error ? error.message : "unreadable entry"}\n`,
			);
			continue;
		}
		summary.runsSeen++;
		try {
			const runData = parseRunEntry(entryPath);
			if (!runData.ts || !runData.verdict) throw new Error("missing timestamp or verdict");
			const result = appendRunToLedger(runData, ledgerPath);
			if (result.skipped) {
				summary.skipped++;
			} else {
				summary.runsIngested++;
				summary.findingsWritten += result.written;
			}
		} catch (error) {
			summary.skipped++;
			process.stderr.write(
				`Backfill warning: skipped ${name}: ${error instanceof Error ? error.message : "unparseable run"}\n`,
			);
		}
	}
	return summary;
}

function main() {
	const logDir = process.argv[2] ? path.resolve(process.argv[2]) : defaultCouncilLogDir();
	const ledgerPath = process.argv[3]
		? path.resolve(process.argv[3])
		: path.join(logDir, "ledger.jsonl");
	const summary = backfillLedger({ logDir, ledgerPath });
	process.stdout.write(
		`runs seen: ${summary.runsSeen} / runs ingested: ${summary.runsIngested} / findings written: ${summary.findingsWritten} / skipped: ${summary.skipped}\n`,
	);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
